// ============================================================
// AI ANALYST — 4-Model Ensemble (Claude + GPT-4o + Gemini + Groq)
// Mirrors the 4-model predictor in your Kalshi bot
// A pick only goes through if 3 of 4 models agree (shouldPick=true)
// Final levels = weighted average across agreeing models
// ------------------------------------------------------------
// CHANGES IN THIS VERSION:
//  • Per-model rate limiter ("scan slower") so you never burst
//    past a per-minute cap — paces calls regardless of how the
//    caller loops over tickers.
//  • Real exponential backoff + jitter on 429s, applied to ALL
//    four models (Claude & Gemini previously had NO retry).
//  • 429 detection now handles both axios errors AND the
//    Anthropic SDK error shape, and respects Retry-After headers.
//  • Gemini model string moved to env + defaulted to a current
//    model (gemini-2.0-flash was deprecated by Google in Feb 2026).
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import { StockQuote, TechnicalIndicators, NewsArticle, StockPick } from './types';

// ── Model weights (Claude + GPT weighted higher) ───────────
const MODEL_WEIGHTS: Record<string, number> = {
  // Equal weights — no model is treated as smarter than another. With the
  // 0.65 consensus rule this makes picks a clean 3-of-4 vote (2 = 0.50 fails,
  // 3 = 0.75 passes). Revisit once the scorecard has real graded results.
  claude:  0.25,
  gpt4o:   0.25,
  gemini:  0.25,
  groq:    0.25,
};

// ── Requests-per-minute budget per model ───────────────────
// Conservative defaults sit UNDER each provider's free-tier cap
// so 429s basically stop happening. When you upgrade a provider
// to a paid tier, just raise the matching number (or set the env
// var) — e.g. Groq Developer tier ≈ 10x, so GROQ_RPM=250 is safe.
const MODEL_RPM: Record<string, number> = {
  claude: Number(process.env.CLAUDE_RPM) || 50,
  gpt4o:  Number(process.env.GPT4O_RPM)  || 50,
  gemini: Number(process.env.GEMINI_RPM) || 4,   // free-tier cap is 5 RPM (per dashboard); 4 leaves headroom
  groq:   Number(process.env.GROQ_RPM)   || 25,  // free tier is 30 RPM, org-wide; leave headroom
};

// Gemini 2.0 was deprecated by Google (Feb 2026). Default to a
// current Flash model; override with GEMINI_MODEL if needed.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// ── Per-model rate limiter ─────────────────────────────────
// Serializes the *start* of each call to a given model and
// spaces starts by (60000 / RPM) ms. Because these limiters live
// at module scope, they pace every call across the whole run —
// no matter whether the caller loops sequentially or fires
// Promise.all over all 59 tickers at once.
class RateLimiter {
  private gate: Promise<void> = Promise.resolve();
  private lastStart = 0;
  constructor(private minIntervalMs: number) {}

  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    const wait = this.gate.then(async () => {
      const now = Date.now();
      const delay = Math.max(0, this.lastStart + this.minIntervalMs - now);
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
      this.lastStart = Date.now();
    });
    // Keep the queue alive even if a downstream call rejects.
    this.gate = wait.catch(() => {});
    await wait;
    return fn();
  }
}

const limiters: Record<string, RateLimiter> = Object.fromEntries(
  Object.entries(MODEL_RPM).map(([model, rpm]) => [
    model,
    new RateLimiter(Math.ceil(60000 / Math.max(1, rpm))),
  ])
);

// ── Per-run participation tracker ──────────────────────────
// Tallies how each model behaved across a whole scan so you can
// see at a glance whether all four are actually voting — instead
// of eyeballing every ticker line. Call logRunSummary() once at
// the end of your weekly run; it prints the table and resets.
interface ModelStats { picks: number; passes: number; errors: number; }
const MODELS = ['claude', 'gpt4o', 'gemini', 'groq'] as const;

function freshStats(): Record<string, ModelStats> {
  return Object.fromEntries(MODELS.map(m => [m, { picks: 0, passes: 0, errors: 0 }]));
}
let runStats: Record<string, ModelStats> = freshStats();

function recordVotes(votes: ModelVote[]): void {
  for (const v of votes) {
    const s = runStats[v.model];
    if (!s) continue;
    if (v.error) s.errors++;
    else if (v.shouldPick) s.picks++;
    else s.passes++;
  }
}

export function resetRunStats(): void {
  runStats = freshStats();
}

// Prints a per-model summary for the run, then resets the counters.
export function logRunSummary(): void {
  const tickers = Object.values(runStats)
    .reduce((max, s) => Math.max(max, s.picks + s.passes + s.errors), 0);

  console.log('\n========== ENSEMBLE RUN SUMMARY ==========');
  console.log(`Tickers analyzed: ${tickers}`);
  for (const m of MODELS) {
    const s = runStats[m];
    const ran = s.picks + s.passes;
    const total = ran + s.errors;
    const errPct = total ? Math.round((s.errors / total) * 100) : 0;
    const flag = total === 0 ? ' ⚠️ NEVER RAN'
      : s.errors === total ? ' ⚠️ ALL ERRORED'
      : errPct >= 25 ? ' ⚠️ HIGH ERROR RATE'
      : '';
    console.log(
      `  ${m.toUpperCase().padEnd(7)} | voted ${String(ran).padStart(3)} ` +
      `(✅ ${s.picks} pick / ❌ ${s.passes} pass) | ⚠️ ${s.errors} err (${errPct}%)${flag}`
    );
  }
  console.log('==========================================\n');

  resetRunStats();
}

// ── 429 / transient-error detection across SDK + axios ─────
function getStatus(err: any): number | undefined {
  return err?.status ?? err?.response?.status;
}

function isRetryable(err: any): boolean {
  const status = getStatus(err);
  if (status === 429) return true;                 // rate limited
  if (status === 503 || status === 529) return true; // overloaded
  const code = err?.code;
  return code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNABORTED';
}

// Honor a server-provided Retry-After (seconds) when present.
function retryAfterMs(err: any): number | undefined {
  const h = err?.response?.headers || err?.headers;
  const ra = h?.['retry-after'] ?? h?.['Retry-After'];
  if (ra == null) return undefined;
  const secs = Number(ra);
  return Number.isFinite(secs) ? secs * 1000 : undefined;
}

// ── Exponential backoff with jitter ────────────────────────
async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  retries = 5,
  baseMs = 2000,
  capMs = 30000,
): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const last = attempt === retries;
      if (!isRetryable(err) || last) throw err;

      const backoff = Math.min(capMs, baseMs * 2 ** attempt);
      const jitter = Math.random() * (backoff * 0.25);
      const wait = retryAfterMs(err) ?? backoff + jitter;
      console.warn(
        `[Analyst] ${label} ${getStatus(err) ?? err?.code ?? 'error'} — retry ${attempt + 1}/${retries} in ${Math.round(wait)}ms`
      );
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw new Error(`[Analyst] ${label}: max retries exceeded`);
}

// Combine throttle + retry into one call wrapper.
function callModel<T>(model: string, fn: () => Promise<T>): Promise<T> {
  const limiter = limiters[model];
  const run = () => withRetry(model, fn);
  return limiter ? limiter.schedule(run) : run();
}

// ── Build shared prompt ────────────────────────────────────
function buildPrompt(
  quote: StockQuote,
  technicals: TechnicalIndicators,
  news: NewsArticle[],
  modelRole: string,
  memoryBlock?: string
): string {
  const newsText = news.map(n =>
    `[${n.sentiment.toUpperCase()}] ${n.source}: ${n.title}`
  ).join('\n');

  return `You are ${modelRole}. Analyze this stock for a SWING TRADE (1-4 week hold).

STOCK DATA:
Ticker: ${quote.ticker} (${quote.name})
Sector: ${quote.sector}
Current Price: $${quote.price}
Day Change: ${quote.changePercent?.toFixed(2)}%
52W High: $${quote.week52High} | 52W Low: $${quote.week52Low}
Beta: ${quote.beta || 'N/A'} | P/E: ${quote.pe || 'N/A'}
Volume vs Avg: ${quote.volume?.toLocaleString()} vs ${quote.avgVolume?.toLocaleString()}

TECHNICALS:
RSI(14): ${technicals.rsi?.toFixed(1) || 'N/A'}
MACD: ${technicals.macd?.toFixed(3) || 'N/A'} (Signal: ${technicals.macdSignal?.toFixed(3) || 'N/A'})
SMA20: $${technicals.sma20?.toFixed(2) || 'N/A'} | SMA50: $${technicals.sma50?.toFixed(2) || 'N/A'} | SMA200: $${technicals.sma200?.toFixed(2) || 'N/A'}
Trend: ${technicals.trend.toUpperCase()}
Support: $${technicals.support?.toFixed(2) || 'N/A'} | Resistance: $${technicals.resistance?.toFixed(2) || 'N/A'}

RECENT NEWS (last 5 days):
${newsText || 'No recent news found.'}
${memoryBlock ? `\n${memoryBlock}\n` : ''}
Respond ONLY with a JSON object (no markdown, no preamble):
{
  "shouldPick": true/false,
  "confidenceScore": 0-100,
  "entryLow": number,
  "entryHigh": number,
  "targetPrice": number,
  "stopLoss": number,
  "timeHorizon": "string, e.g. '1-2 weeks'",
  "catalysts": ["array", "of", "strings"],
  "risks": ["array", "of", "strings"],
  "summary": "2-3 sentence plain English summary of the trade thesis. Include WHY now.",
  "riskRewardRatio": number
}

Rules:
- Only set shouldPick=true if confidence >= 65
- Target 5-15% above current price, stop 3-7% below. riskRewardRatio must be >= 2.0
- Be realistic. If chart looks weak or news is negative, say shouldPick=false`;
}

function parseJSON(text: string): any {
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

function errorVote(model: string, message?: string): ModelVote {
  return {
    model, shouldPick: false, confidenceScore: 0, entryLow: 0, entryHigh: 0,
    targetPrice: 0, stopLoss: 0, timeHorizon: '', catalysts: [], risks: [],
    summary: '', riskRewardRatio: 0, error: message,
  };
}

interface ModelVote {
  model: string;
  shouldPick: boolean;
  confidenceScore: number;
  entryLow: number;
  entryHigh: number;
  targetPrice: number;
  stopLoss: number;
  timeHorizon: string;
  catalysts: string[];
  risks: string[];
  summary: string;
  riskRewardRatio: number;
  error?: string;
}

// ── Claude ─────────────────────────────────────────────────
async function askClaude(
  quote: StockQuote,
  technicals: TechnicalIndicators,
  news: NewsArticle[],
  memoryBlock?: string
): Promise<ModelVote> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  const prompt = buildPrompt(quote, technicals, news,
    'an expert stock trader specializing in fundamental analysis and market sentiment', memoryBlock);

  try {
    const response = await callModel('claude', () => client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }));
    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    return { model: 'claude', ...parseJSON(text) };
  } catch (err: any) {
    console.error('[Analyst] Claude error:', err?.message);
    return errorVote('claude', err?.message);
  }
}

// ── GPT-4o ─────────────────────────────────────────────────
async function askGPT4o(
  quote: StockQuote,
  technicals: TechnicalIndicators,
  news: NewsArticle[],
  memoryBlock?: string
): Promise<ModelVote> {
  const prompt = buildPrompt(quote, technicals, news,
    'an expert technical analyst focused on chart patterns and momentum', memoryBlock);

  try {
    const response = await callModel('gpt4o', () => axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
      },
      { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
    ));
    const text = response.data.choices[0].message.content;
    return { model: 'gpt4o', ...parseJSON(text) };
  } catch (err: any) {
    console.error('[Analyst] GPT-4o error:', err?.message);
    return errorVote('gpt4o', err?.message);
  }
}

// ── Gemini ─────────────────────────────────────────────────
async function askGemini(
  quote: StockQuote,
  technicals: TechnicalIndicators,
  news: NewsArticle[],
  memoryBlock?: string
): Promise<ModelVote> {
  const prompt = buildPrompt(quote, technicals, news,
    'an expert analyst specializing in news-driven catalysts, sector rotation, and macro trends', memoryBlock);

  try {
    const response = await callModel('gemini', () => axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }
    ));
    const text = response.data.candidates[0].content.parts[0].text;
    return { model: 'gemini', ...parseJSON(text) };
  } catch (err: any) {
    console.error('[Analyst] Gemini error:', err?.message);
    return errorVote('gemini', err?.message);
  }
}

// ── Groq (Llama) ───────────────────────────────────────────
async function askGroq(
  quote: StockQuote,
  technicals: TechnicalIndicators,
  news: NewsArticle[],
  memoryBlock?: string
): Promise<ModelVote> {
  const prompt = buildPrompt(quote, technicals, news,
    'a risk-focused trader who weighs both upside and downside fairly. Approve solid setups but flag genuine red flags', memoryBlock);

  try {
    const response = await callModel('groq', () => axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      },
      { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` } }
    ));
    const text = response.data.choices[0].message.content;
    return { model: 'groq', ...parseJSON(text) };
  } catch (err: any) {
    console.error('[Analyst] Groq error:', err?.message);
    return errorVote('groq', err?.message);
  }
}

// ── Ensemble voting ────────────────────────────────────────
function combineVotes(votes: ModelVote[], quote: StockQuote): {
  shouldPick: boolean;
  confidenceScore: number;
  entryLow: number;
  entryHigh: number;
  targetPrice: number;
  stopLoss: number;
  timeHorizon: string;
  catalysts: string[];
  risks: string[];
  summary: string;
  riskRewardRatio: number;
  voteBreakdown: string;
} {
  const agreeing = votes.filter(v => v.shouldPick && !v.error);
  const total = votes.filter(v => !v.error).length;

  // ── Weighted consensus ───────────────────────────────────
  // A pick needs models worth >= 65% of the *available* weight to agree.
  // With all 4 live (weights: claude .35, gpt4o .30, gemini .20, groq .15)
  // 0.65 means: any 3 of 4 agree, OR Claude + GPT-4o agree together.
  // Two light models (e.g. gemini + groq = .35) can't carry a pick alone.
  // Dividing by available weight means one model erroring doesn't block it.
  const CONSENSUS = 0.65;
  const weightOf = (v: ModelVote) => MODEL_WEIGHTS[v.model] || 0.25;
  const agreeWeight = agreeing.reduce((s, v) => s + weightOf(v), 0);
  const availWeight = votes.filter(v => !v.error).reduce((s, v) => s + weightOf(v), 0);
  const agreeFraction = availWeight > 0 ? agreeWeight / availWeight : 0;
  const shouldPick = agreeing.length > 0 && agreeFraction >= CONSENSUS - 1e-9;

  const voteBreakdown = votes.map(v => {
    const icon = v.error ? '⚠️' : v.shouldPick ? '✅' : '❌';
    return `${icon} ${v.model.toUpperCase()}${v.error ? ' (error)' : ` (${v.confidenceScore})`}`;
  }).join(' | ');

  if (!shouldPick || agreeing.length === 0) {
    return {
      shouldPick: false, confidenceScore: 0, entryLow: 0, entryHigh: 0,
      targetPrice: 0, stopLoss: 0, timeHorizon: '', catalysts: [], risks: [],
      summary: '', riskRewardRatio: 0, voteBreakdown,
    };
  }

  // Weighted average of numeric fields across agreeing models
  const weightedAvg = (field: keyof ModelVote): number => {
    let total = 0;
    let weightSum = 0;
    for (const v of agreeing) {
      const w = MODEL_WEIGHTS[v.model] || 0.25;
      total += (v[field] as number) * w;
      weightSum += w;
    }
    return total / weightSum;
  };

  // Collect all catalysts + risks, deduplicate
  const allCatalysts = [...new Set(agreeing.flatMap(v => v.catalysts))].slice(0, 4);
  const allRisks = [...new Set(agreeing.flatMap(v => v.risks))].slice(0, 3);

  // Use Claude's summary if available, else first agreeing model's
  const claudeVote = agreeing.find(v => v.model === 'claude');
  const summary = claudeVote?.summary || agreeing[0].summary;

  // Most common time horizon
  const horizons = agreeing.map(v => v.timeHorizon);
  const timeHorizon = horizons.sort((a, b) =>
    horizons.filter(h => h === a).length - horizons.filter(h => h === b).length
  ).pop() || '1-2 weeks';

  return {
    shouldPick: true,
    confidenceScore: Math.round(weightedAvg('confidenceScore')),
    entryLow: parseFloat(weightedAvg('entryLow').toFixed(2)),
    entryHigh: parseFloat(weightedAvg('entryHigh').toFixed(2)),
    targetPrice: parseFloat(weightedAvg('targetPrice').toFixed(2)),
    stopLoss: parseFloat(weightedAvg('stopLoss').toFixed(2)),
    // R/R from ACTUAL averaged levels. Measured from the MIDPOINT of the
    // entry zone — using entryHigh understated reward and crushed the ratio
    // when averaging pushed entryHigh up toward the target.
    riskRewardRatio: (() => {
      const entry = (weightedAvg('entryLow') + weightedAvg('entryHigh')) / 2;
      const target = weightedAvg('targetPrice');
      const stop = weightedAvg('stopLoss');
      const reward = target - entry;
      const risk = entry - stop;
      if (risk <= 0) return 0;
      return parseFloat((reward / risk).toFixed(2));
    })(),
    timeHorizon,
    catalysts: allCatalysts,
    risks: allRisks,
    summary,
    voteBreakdown,
  };
}

// ── Main: analyze a stock with all 4 models ────────────────
export async function analyzeStock(
  quote: StockQuote,
  technicals: TechnicalIndicators,
  news: NewsArticle[],
  memoryBlock?: string
): Promise<StockPick | null> {

  console.log(`[Analyst] Running 4-model ensemble on ${quote.ticker}...`);

  // All four run "in parallel" — but the per-model rate limiters
  // (module scope) space each provider's calls under its cap, so
  // there's no need to hand-stagger Gemini/Groq anymore. Different
  // providers don't share limits, so they genuinely overlap.
  // memoryBlock (similar past graded trades, when available) goes to
  // all four models identically — same shared prompt, one extra section.
  const [claudeVote, gpt4oVote, geminiVote, groqVote] = await Promise.all([
    askClaude(quote, technicals, news, memoryBlock),
    askGPT4o(quote, technicals, news, memoryBlock),
    askGemini(quote, technicals, news, memoryBlock),
    askGroq(quote, technicals, news, memoryBlock),
  ]);

  const votes = [claudeVote, gpt4oVote, geminiVote, groqVote];
  recordVotes(votes);
  const result = combineVotes(votes, quote);

  console.log(`[Analyst] ${quote.ticker} vote: ${result.voteBreakdown}`);
  console.log(`[Analyst] ${quote.ticker} decision: ${result.shouldPick ? `PICK (${result.confidenceScore}/100)` : 'PASS'}`);

  if (!result.shouldPick || result.confidenceScore < 65) return null;

  const pick: StockPick = {
    ticker: quote.ticker,
    name: quote.name,
    pickType: 'STOCK_LONG',
    currentPrice: quote.price,
    entryZone: { low: result.entryLow, high: result.entryHigh },
    targetPrice: result.targetPrice,
    stopLoss: result.stopLoss,
    riskRewardRatio: result.riskRewardRatio,
    timeHorizon: result.timeHorizon,
    confidenceScore: result.confidenceScore,
    catalysts: result.catalysts,
    risks: result.risks,
    summary: result.summary,
    technicals,
    news: news.slice(0, 3),
    sector: quote.sector,
    addedAt: new Date().toISOString(),
    voteBreakdown: result.voteBreakdown,
  };

  return pick;
}

// ── Generate weekly market outlook (Claude only) ──────────
export async function generateMarketOutlook(
  marketNews: NewsArticle[],
  picks: StockPick[]
): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  const newsText = marketNews.slice(0, 5).map(n => `- ${n.title}`).join('\n');
  const pickSummary = picks.map(p => `${p.ticker}: ${p.summary}`).join('\n');

  try {
    const response = await callModel('claude', () => client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: `Write a concise 3-4 sentence WEEKLY MARKET OUTLOOK for a stock trader using Robinhood.
Tone: direct, practical, no fluff. Mention 1-2 macro risks and 1-2 tailwinds.

Recent market news:
${newsText}

This week's picks context:
${pickSummary}

Respond with just the outlook paragraph, no headers.`
      }],
    }));

    return response.content[0].type === 'text'
      ? response.content[0].text.trim()
      : 'Market outlook unavailable this week.';
  } catch {
    return 'Market outlook unavailable this week.';
  }
}

// ── Generate daily position update (Claude only) ─────────
export async function generatePositionUpdate(
  ticker: string,
  pickType: string,
  entryPrice: number,
  currentPrice: number,
  targetPrice: number,
  stopLoss: number,
  news: NewsArticle[]
): Promise<{ action: string; update: string }> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  const pnlPercent = ((currentPrice - entryPrice) / entryPrice * 100).toFixed(1);
  const distToTarget = ((targetPrice - currentPrice) / currentPrice * 100).toFixed(1);
  const distToStop = ((currentPrice - stopLoss) / currentPrice * 100).toFixed(1);
  const newsText = news.slice(0, 3).map(n => `[${n.sentiment}] ${n.title}`).join('\n');

  try {
    const response = await callModel('claude', () => client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `You are managing an active ${pickType} position in ${ticker}.
Entry: $${entryPrice} | Current: $${currentPrice} | P&L: ${pnlPercent}%
Target: $${targetPrice} (${distToTarget}% away) | Stop: $${stopLoss} (${distToStop}% below)

Recent news:
${newsText || 'No fresh news.'}

Respond with JSON only:
{
  "action": "ENTER_NOW|HOLD|TRIM|EXIT|WAIT",
  "update": "One sentence on what to do and why. Be direct."
}`
      }],
    }));

    const text = response.content[0].type === 'text' ? response.content[0].text.trim() : '';
    return JSON.parse(text);
  } catch {
    return { action: 'HOLD', update: 'No update available — hold position per original plan.' };
  }
}
