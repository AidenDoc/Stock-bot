// ============================================================
// SCANNER — TWO ENTRY STRATEGIES, RUN HEAD-TO-HEAD
// ------------------------------------------------------------
//  A) PULLBACK  — strong uptrend that has pulled back to support
//                 (buy strength on sale, not the spike)
//  B) BREAKOUT  — momentum, but REJECTS already-overextended names
//                 (the old logic, with guardrails on the worst entries)
//
// Each ticker is fetched ONCE, then both strategies score the
// cached data. Every pick is tagged with .strategy so the
// scorecard and dashboard can compare them separately.
// ============================================================

import { StockQuote, TechnicalIndicators, StockPick } from './types';
import { getQuote, getTechnicals, getCandidateTickers } from './marketData';
import { getStockNews, getNextEarningsDate, computeEarningsGap } from './news';
import { analyzeStock } from './analyst';
import { getDynamicMovers } from './screener';

export type StrategyTag = 'PULLBACK' | 'BREAKOUT';

export interface MarketRow {
  quote: StockQuote;
  technicals: TechnicalIndicators;
}

export interface ScoredCandidate extends MarketRow {
  score: number;
  optionsScore: number;
  reasons: string[];
  strategy: StrategyTag;
}

// ── Shared: options-contract quality (same for both strategies) ──
function optionsQuality(quote: StockQuote): { add: number; reasons: string[] } {
  let s = 0;
  const reasons: string[] = [];

  if (quote.price >= 10 && quote.price <= 150) { s += 25; reasons.push('ideal options price range'); }
  else if (quote.price > 150 && quote.price <= 500) s += 15;
  else if (quote.price < 10) s -= 10;

  if (quote.beta !== null) {
    if (quote.beta >= 1.5 && quote.beta <= 3.0) { s += 25; reasons.push(`beta ${quote.beta.toFixed(1)} = rich premium`); }
    else if (quote.beta >= 1.0 && quote.beta < 1.5) s += 15;
    else if (quote.beta > 3.0) s += 10;
  } else {
    s += 10;
  }

  if (quote.volume > 5000000) { s += 20; reasons.push('high volume = liquid options'); }
  else if (quote.volume > 1000000) s += 10;
  else s -= 15;

  return { add: s, reasons };
}

// ── Strategy B: BREAKOUT with overextension filter ─────────
// Returns null if the candidate is already too stretched to chase.
export function scoreBreakout(row: MarketRow): ScoredCandidate | null {
  const { quote, technicals } = row;

  // --- Overextension guardrails (the fix for the 0-for-14 problem) ---
  if (quote.changePercent != null && quote.changePercent > 8) return null;        // spiked hard today
  if (technicals.rsi != null && technicals.rsi > 70) return null;                  // overbought
  if (technicals.sma20 && quote.price > technicals.sma20 * 1.10) return null;      // gapped far above base

  let score = 0;
  const reasons: string[] = [];

  if (technicals.trend === 'bullish') { score += 20; reasons.push('bullish trend'); }

  if (technicals.rsi !== null) {
    if (technicals.rsi >= 45 && technicals.rsi <= 65) { score += 15; reasons.push(`RSI ${technicals.rsi.toFixed(0)} in ideal zone`); }
    else if (technicals.rsi < 35) { score += 10; reasons.push(`RSI ${technicals.rsi.toFixed(0)} oversold bounce`); }
  }

  if (technicals.sma50 && quote.price > technicals.sma50) { score += 10; reasons.push('above SMA50'); }

  const distFrom52wHigh = (quote.week52High - quote.price) / quote.week52High;
  if (distFrom52wHigh > 0.10 && distFrom52wHigh < 0.60) { score += 10; reasons.push('room to 52w high'); }

  const distFrom52wLow = (quote.price - quote.week52Low) / quote.price;
  if (distFrom52wLow < 0.05) score -= 15;

  const oq = optionsQuality(quote);
  reasons.push(...oq.reasons);
  const optionsScore = oq.add;
  score += optionsScore * 0.3;

  return { quote, technicals, score, optionsScore, reasons, strategy: 'BREAKOUT' };
}

// ── Strategy A: PULLBACK in a confirmed uptrend ────────────
// Only fires when a structurally strong stock has dipped to
// support and cooled off — the opposite of buying the spike.
export function scorePullback(row: MarketRow): ScoredCandidate | null {
  const { quote, technicals } = row;
  const { sma20, sma50, sma200, rsi, macd, macdSignal } = technicals;

  // 1) Confirmed uptrend structure
  if (!(sma50 && sma200 && quote.price > sma50 && sma50 > sma200)) return null;

  // 2) A pullback, NOT a spike (down/flat day, not a rip)
  if (quote.changePercent == null || quote.changePercent > 2 || quote.changePercent < -8) return null;

  // 3) Price pulled back to the 20-day (from ~6% below to ~4% above it)
  if (!sma20) return null;
  const distFromSma20 = (quote.price - sma20) / sma20;
  if (distFromSma20 > 0.04 || distFromSma20 < -0.06) return null;

  // 4) RSI has cooled off (reset), not still overbought
  if (rsi == null || rsi < 38 || rsi > 58) return null;

  let score = 0;
  const reasons: string[] = [];

  score += 25; reasons.push('uptrend intact (>SMA50>SMA200)');
  score += 15; reasons.push(`pulled back to SMA20 (${(distFromSma20 * 100).toFixed(1)}%)`);

  if (rsi >= 42 && rsi <= 52) { score += 15; reasons.push(`RSI ${rsi.toFixed(0)} reset`); }

  if (macd != null && macdSignal != null && macd > macdSignal) { score += 10; reasons.push('MACD still positive'); }

  const oq = optionsQuality(quote);
  reasons.push(...oq.reasons);
  const optionsScore = oq.add;
  score += optionsScore * 0.3;

  return { quote, technicals, score, optionsScore, reasons, strategy: 'PULLBACK' };
}

// ── Run AI analysis on a ranked candidate list for one type ──
async function runPicks(
  candidates: ScoredCandidate[],
  pickType: 'OPTIONS_CALL' | 'STOCK_LONG',
  count: number,
  strategyTag: StrategyTag,
  analyzed: Set<string>,
): Promise<StockPick[]> {
  const out: StockPick[] = [];

  for (const cand of candidates) {
    if (out.length >= count) break;
    if (analyzed.has(cand.quote.ticker)) continue;

    const news = await getStockNews(cand.quote.ticker, cand.quote.name);
    const pick = await analyzeStock(cand.quote, cand.technicals, news, pickType);

    const modelsWorking = pick ? (pick.voteBreakdown?.split('⚠️').length ?? 1) - 1 : 0;
    const fullEnsemble = modelsWorking <= 1; // 3+ models actually voted
    const rrFloor = pickType === 'OPTIONS_CALL'
      ? (fullEnsemble ? 2.5 : 1.5)
      : (fullEnsemble ? 2.0 : 1.5);

    const qualifies = pick && pick.confidenceScore >= 65 && pick.riskRewardRatio >= rrFloor;

    if (qualifies) {
      pick!.strategy = strategyTag;

      // Info-only earnings flag: resolve the next earnings date and
      // mark whether it lands inside the trade's hold window. Only
      // done for actual picks (saves Finnhub quota); never blocks.
      const earningsDate = await getNextEarningsDate(cand.quote.ticker);
      const gap = computeEarningsGap(earningsDate, pick!.timeHorizon, pickType);
      if (gap) {
        pick!.earningsGap = gap;
        if (gap.withinHorizon) {
          console.log(`[Scanner] ⚠️ ${pick!.ticker} earnings in ${gap.daysUntil}d — within ${pick!.timeHorizon} hold window`);
        }
      }

      out.push(pick!);
      console.log(`[Scanner] ✅ ${strategyTag} ${pickType === 'OPTIONS_CALL' ? 'OPTIONS' : 'STOCK'} PICK: ${pick!.ticker} (${pick!.confidenceScore}/100, R/R ${pick!.riskRewardRatio})`);
    } else {
      console.log(`[Scanner] ❌ PASS (${strategyTag}): ${cand.quote.ticker}`);
    }

    analyzed.add(cand.quote.ticker);
    await sleep(2000);
  }

  return out;
}

// ── Full weekly scan — runs BOTH strategies ────────────────
export async function runWeeklyScan(
  optionsCount: number = 3,
  stockCount: number = 4
): Promise<{ optionsPicks: StockPick[]; stockPicks: StockPick[] }> {

  console.log('[Scanner] Starting weekly scan (Pullback vs Breakout)...');
  const fixedList = getCandidateTickers();
  const movers = await getDynamicMovers();
  // Merge fixed universe + today's live movers, deduped.
  const candidates = [...new Set([...fixedList, ...movers])];
  console.log(`[Scanner] Universe: ${fixedList.length} fixed + ${movers.length} movers = ${candidates.length} unique`);

  // ── Pass 1: fetch each ticker's data ONCE ────────────────
  console.log(`[Scanner] Fetching data for ${candidates.length} tickers...`);
  const market: MarketRow[] = [];
  for (const ticker of candidates) {
    const quote = await getQuote(ticker);
    if (!quote || quote.price < 3 || quote.price > 3000) { await sleep(400); continue; }
    const technicals = await getTechnicals(ticker, quote.price);
    market.push({ quote, technicals });
    await sleep(800); // Yahoo politeness
  }
  console.log(`[Scanner] ${market.length} tickers with usable data`);

  // ── Pass 2: score every row under BOTH strategies ────────
  const breakout: ScoredCandidate[] = [];
  const pullback: ScoredCandidate[] = [];
  for (const row of market) {
    const b = scoreBreakout(row);
    if (b && b.score >= 25) breakout.push(b);
    const a = scorePullback(row);
    if (a && a.score >= 25) pullback.push(a);
  }
  console.log(`[Scanner] BREAKOUT candidates: ${breakout.length} | PULLBACK candidates: ${pullback.length}`);

  const optionsPicks: StockPick[] = [];
  const stockPicks: StockPick[] = [];

  // ── Pass 3: run AI for each strategy ─────────────────────
  // BREAKOUT
  console.log('[Scanner] --- BREAKOUT strategy ---');
  const bAnalyzed = new Set<string>();
  const bOptions = [...breakout].sort((a, b) => b.optionsScore - a.optionsScore).filter(c => c.optionsScore >= 30 && c.quote.price >= 5);
  const bStocks = [...breakout].sort((a, b) => b.score - a.score);
  optionsPicks.push(...await runPicks(bOptions, 'OPTIONS_CALL', optionsCount, 'BREAKOUT', bAnalyzed));
  stockPicks.push(...await runPicks(bStocks, 'STOCK_LONG', stockCount, 'BREAKOUT', bAnalyzed));

  // PULLBACK
  console.log('[Scanner] --- PULLBACK strategy ---');
  const aAnalyzed = new Set<string>();
  const aOptions = [...pullback].sort((a, b) => b.optionsScore - a.optionsScore).filter(c => c.optionsScore >= 30 && c.quote.price >= 5);
  const aStocks = [...pullback].sort((a, b) => b.score - a.score);
  optionsPicks.push(...await runPicks(aOptions, 'OPTIONS_CALL', optionsCount, 'PULLBACK', aAnalyzed));
  stockPicks.push(...await runPicks(aStocks, 'STOCK_LONG', stockCount, 'PULLBACK', aAnalyzed));

  const bCount = [...optionsPicks, ...stockPicks].filter(p => p.strategy === 'BREAKOUT').length;
  const aCount = [...optionsPicks, ...stockPicks].filter(p => p.strategy === 'PULLBACK').length;
  console.log(`[Scanner] Scan complete: ${optionsPicks.length} options, ${stockPicks.length} stock`);
  console.log(`[Scanner] By strategy → BREAKOUT: ${bCount} | PULLBACK: ${aCount}`);

  return { optionsPicks, stockPicks };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}