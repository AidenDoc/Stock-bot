// ============================================================
// AGENTS — Phase 2 information asymmetry (two roles, one vendor)
// ------------------------------------------------------------
// Two agents see DELIBERATELY DISJOINT slices of point-in-time data:
//
//   • Technical agent — sees ONLY the stock's own indicators and the
//     detected PULLBACK/BREAKOUT setup. The stock is ANONYMIZED (no
//     ticker/name/sector) so the model can't lean on outside knowledge
//     of the company. No market context.
//
//   • Regime agent — sees ONLY broad-market context (SPY vs its moving
//     averages, as-of the cutoff). Knows NOTHING about any single stock.
//
// Same vendor (Claude), called twice with different system prompts and
// different data — asymmetry is about distinct INPUTS and ROLES, not
// distinct vendors. We do NOT reintroduce the 4-vendor split.
//
// Determinism: temperature 0 + an on-disk cache keyed by (role, date,
// ticker). Point-in-time inputs are fixed, so a cached verdict is a
// faithful replay — and re-runs cost nothing.
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';

const AGENT_MODEL = process.env.AGENT_MODEL || 'claude-opus-4-5';
const CACHE_FILE = path.join(process.cwd(), 'data', 'agent_cache.json');

// ── Verdict shape ──────────────────────────────────────────
export interface AgentVerdict {
  direction: 'long' | 'neutral' | 'avoid';
  confidence: number; // 0–100, the agent's conviction in its OWN call
  reason: string;
}

// Inputs handed to each agent (already point-in-time; built by the caller).
export interface TechnicalView {
  strategy: 'PULLBACK' | 'BREAKOUT';
  price: number;
  changePercent: number;
  rsi: number | null;
  macd: number | null;
  macdSignal: number | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  trend: string;
  pctTo52High: number;   // how far below the 52w high (%)
  pctFrom52Low: number;  // how far above the 52w low (%)
  setupReasons: string[];
}

export interface RegimeView {
  date: string;
  spyPrice: number;
  spySma50: number | null;
  spySma200: number | null;
  pctVs200: number | null; // SPY vs its 200d (%)
  pctVs50: number | null;  // SPY vs its 50d (%)
  chg20d: number | null;   // SPY 20-day change (%)
  trend: string;
}

// ── Minimal Claude caller (temp 0 + transient retry) ───────
let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  return client;
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

async function callClaude(system: string, user: string): Promise<string> {
  for (let attempt = 0; attempt <= 4; attempt++) {
    try {
      const resp = await getClient().messages.create({
        model: AGENT_MODEL,
        max_tokens: 400,
        temperature: 0,
        system,
        messages: [{ role: 'user', content: user }],
      });
      return resp.content[0].type === 'text' ? resp.content[0].text : '';
    } catch (err: any) {
      const status = err?.status ?? err?.response?.status;
      const retryable = status === 429 || status === 529 || status === 503;
      if (!retryable || attempt === 4) throw err;
      const wait = Math.min(30000, 2000 * 2 ** attempt) + Math.floor(Math.random() * 1000);
      console.warn(`[Agents] ${status} — retry ${attempt + 1}/4 in ${wait}ms`);
      await sleep(wait);
    }
  }
  throw new Error('[Agents] unreachable');
}

function parseVerdict(text: string): AgentVerdict {
  try {
    const j = JSON.parse(text.replace(/```json|```/g, '').trim());
    const direction = ['long', 'neutral', 'avoid'].includes(j.direction) ? j.direction : 'neutral';
    const confidence = Math.max(0, Math.min(100, Math.round(Number(j.confidence) || 0)));
    return { direction, confidence, reason: String(j.reason || '').slice(0, 200) };
  } catch {
    return { direction: 'neutral', confidence: 50, reason: 'parse-error → neutral' };
  }
}

// ── On-disk verdict cache ──────────────────────────────────
type Cache = Record<string, AgentVerdict>;
let cache: Cache | null = null;
let dirtyCount = 0;

function loadCache(): Cache {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
  } catch {
    cache = {};
  }
  return cache!;
}

export function saveCache(): void {
  if (!cache) return;
  const dir = path.dirname(CACHE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  dirtyCount = 0;
}

async function cached(key: string, fn: () => Promise<AgentVerdict>): Promise<AgentVerdict> {
  const c = loadCache();
  if (c[key]) return c[key];
  const v = await fn();
  c[key] = v;
  if (++dirtyCount >= 10) saveCache(); // crash-safe periodic flush
  return v;
}

function n(x: number | null, digits = 2): string {
  return x == null ? 'N/A' : x.toFixed(digits);
}

// ── Technical agent ────────────────────────────────────────
const TECH_SYSTEM =
  'You are a pure technical analyst. You see ONLY one stock\'s own price ' +
  'indicators and a detected entry setup. You have NO information about the ' +
  'company\'s identity, news, fundamentals, sector, or the broader market — ' +
  'and you must not assume any. Judge ONLY whether the technical setup supports ' +
  'entering a long position held 2–4 weeks. Respond with JSON only: ' +
  '{"direction":"long|neutral|avoid","confidence":0-100,"reason":"one short sentence"}. ' +
  'confidence is your conviction in your own call. Be skeptical of weak setups.';

export async function technicalVerdict(date: string, ticker: string, v: TechnicalView): Promise<AgentVerdict> {
  // ticker is used ONLY as a cache key — it is NOT sent to the model.
  return cached(`tech|${date}|${ticker}`, async () => {
    const user =
`A stock (identity withheld) triggered a ${v.strategy} setup. Point-in-time technicals:
Price: $${v.price.toFixed(2)} | Today's change: ${v.changePercent.toFixed(2)}%
RSI(14): ${n(v.rsi, 1)}
MACD: ${n(v.macd, 3)} (signal ${n(v.macdSignal, 3)})
SMA20: $${n(v.sma20)} | SMA50: $${n(v.sma50)} | SMA200: $${n(v.sma200)}
Trend: ${v.trend.toUpperCase()}
Distance below 52w high: ${v.pctTo52High.toFixed(1)}% | above 52w low: ${v.pctFrom52Low.toFixed(1)}%
Setup signals: ${v.setupReasons.join('; ') || 'none'}

Does this technical picture support a 2–4 week long entry?`;
    return parseVerdict(await callClaude(TECH_SYSTEM, user));
  });
}

// ── Regime agent ───────────────────────────────────────────
const REGIME_SYSTEM =
  'You are a market-regime strategist. You see ONLY broad-market context: the ' +
  'S&P 500 (SPY) relative to its own moving averages, as of a given date. You ' +
  'know NOTHING about any individual stock and must not guess at one. Judge the ' +
  'market posture for OPENING NEW LONG swing positions right now. Respond with ' +
  'JSON only: {"direction":"long|neutral|avoid","confidence":0-100,"reason":"one short sentence"}. ' +
  'direction "long" = favorable for new longs, "avoid" = hostile (risk-off), ' +
  '"neutral" = mixed. confidence is your conviction.';

export async function regimeVerdict(v: RegimeView): Promise<AgentVerdict> {
  return cached(`regime|${v.date}|SPY`, async () => {
    const user =
`Market context as of ${v.date} (SPY only):
SPY: $${v.spyPrice.toFixed(2)}
SPY vs 200-day SMA: ${v.pctVs200 == null ? 'N/A' : `${v.pctVs200 >= 0 ? '+' : ''}${v.pctVs200.toFixed(1)}%`} (SMA200 $${n(v.spySma200)})
SPY vs 50-day SMA: ${v.pctVs50 == null ? 'N/A' : `${v.pctVs50 >= 0 ? '+' : ''}${v.pctVs50.toFixed(1)}%`} (SMA50 $${n(v.spySma50)})
SPY 20-day change: ${v.chg20d == null ? 'N/A' : `${v.chg20d >= 0 ? '+' : ''}${v.chg20d.toFixed(1)}%`}
Computed trend: ${v.trend.toUpperCase()}

Is this a favorable regime for opening new long swing positions?`;
    return parseVerdict(await callClaude(REGIME_SYSTEM, user));
  });
}

// ── 0–100 "long score" (kept for reporting only) ───────────
// long → confidence; avoid → 100−confidence; neutral → 50.
export function longScore(v: AgentVerdict): number {
  if (v.direction === 'long') return v.confidence;
  if (v.direction === 'avoid') return 100 - v.confidence;
  return 50;
}

// ── Combination rule: AND-gate (no blended average) ────────
// A candidate survives ONLY if BOTH agents, independently, return a long
// call whose OWN confidence clears its floor. There is no averaging — a
// very confident technical read cannot rescue a weak/neutral/avoid regime,
// and vice-versa. Each agent is judged solely on its own verdict.
//
// `floor` is each agent's confidence floor; `regimeFloor` defaults to the
// same value so a single threshold gates both, but they can differ.
export function combine(
  tech: AgentVerdict, regime: AgentVerdict,
  floor: number, regimeFloor: number = floor,
): { pick: boolean; techPass: boolean; regimePass: boolean; techScore: number; regimeScore: number } {
  const techPass = tech.direction === 'long' && tech.confidence >= floor;
  const regimePass = regime.direction === 'long' && regime.confidence >= regimeFloor;
  return {
    pick: techPass && regimePass,
    techPass, regimePass,
    techScore: longScore(tech), regimeScore: longScore(regime),
  };
}
