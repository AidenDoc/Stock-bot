// ============================================================
// LIVE NEWS AGENT — an INDEPENDENT catalyst view (Phase 2 asymmetry)
// ------------------------------------------------------------
// This is deliberately NOT part of analyzeStock's 4-model ensemble.
// It is a separate, single-model read that sees ONLY the news — no
// price, no technicals, no quote. Its whole job is: "what does the
// catalyst/headline picture say about this name, in isolation?"
//
// Kept distinct so the news view and the technical read stay two
// independent opinions whose agreement / disagreement is visible.
// Information-only for now — surfaced, never gated on.
//
// Fail-soft, same discipline as the earnings flag: empty news or a
// failed LLM call returns null and logs — it must NEVER block a pick.
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import { NewsArticle } from './types';

export interface NewsView {
  direction: 'bullish' | 'neutral' | 'bearish';
  confidence: number;   // 0-100
  rationale: string;    // one line, cites the actual headlines
}

// News-only system prompt. The hard rules push the model AWAY from
// rubber-stamping bullish: no real catalyst → neutral; mixed → neutral.
const SYSTEM_PROMPT = `You are a financial NEWS & CATALYST analyst.
You will be shown ONLY recent news headlines for a single company — no price, no chart, no technicals, no valuation. Judge what the CATALYST / HEADLINE picture ALONE implies for the stock over the next 1-4 weeks, in isolation.

Rules:
- Use ONLY the supplied headlines. Invent nothing.
- Default to "neutral". Only go directional when the headlines clearly lean.
- "bullish": clear positive catalysts — earnings beat, guidance raise, upgrades, major contract/product win, favorable ruling.
- "bearish": clear negative catalysts — miss, guidance cut, downgrades, lawsuit/investigation, layoffs, regulatory hit.
- Mixed or conflicting headlines, or only generic market/macro noise with nothing company-specific → "neutral", low confidence.
- confidence (0-100) reflects how STRONG and ONE-SIDED the catalyst picture is — NOT how many headlines there are. Sparse or vague news = low confidence.
- Be willing to disagree with what a chart might say; you only see news.

Respond with ONLY a JSON object, no markdown, no preamble:
{"direction":"bullish|neutral|bearish","confidence":0-100,"rationale":"one sentence citing the actual headlines"}`;

function parseJSON(text: string): any {
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

function clampConfidence(n: any): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

// Returns an independent, news-only verdict for `ticker`, or null when
// there is no usable news or the call fails (fail-soft — never throws).
export async function getNewsView(ticker: string, news: NewsArticle[]): Promise<NewsView | null> {
  if (!news || news.length === 0) {
    console.log(`[NewsAgent] ${ticker}: no news — skipping news view (neutral/null)`);
    return null;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[NewsAgent] ANTHROPIC_API_KEY not set — skipping news view');
    return null;
  }

  const headlines = news.map((n, i) =>
    `${i + 1}. [${n.sentiment.toUpperCase()}] ${n.source}: ${n.title}${n.summary && n.summary !== n.title ? ` — ${n.summary}` : ''}`
  ).join('\n');

  const userContent = `Company ticker: ${ticker}
Recent news headlines (last few days):
${headlines}

Give your news-only verdict as JSON.`;

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 300,
      temperature: 0.2,           // low temp — stable, not creative
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    });

    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const parsed = parseJSON(text);

    const dir = String(parsed.direction || '').toLowerCase();
    const direction: NewsView['direction'] =
      dir === 'bullish' || dir === 'bearish' ? dir : 'neutral';

    return {
      direction,
      confidence: clampConfidence(parsed.confidence),
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale.trim() : '',
    };
  } catch (err: any) {
    console.warn(`[NewsAgent] ${ticker}: news view failed — ${err?.message}`);
    return null;
  }
}
