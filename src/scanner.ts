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

import { StockQuote, TechnicalIndicators, StockPick, NewsArticle } from './types';
import { getQuote, getTechnicals, getCandidateTickers } from './marketData';
import { getStockNews, getNextEarningsDate, computeEarningsGap } from './news';
import { getNewsView } from './newsAgent';
import { analyzeStock } from './analyst';
import { getDynamicMovers } from './screener';
import { getMemoryContext, recordPick, TradeFeatures, NewsVerdict } from './memory/tradeMemory';
import { computePlan, CURRENT_EXIT_REGIME } from './tradePlan';
import { etNow, addTradingDays } from './marketCalendar';

export type StrategyTag = 'PULLBACK' | 'BREAKOUT';

// A ticker whose newest daily bar is older than this has produced no bar
// for at least the last 5 trading days (9 calendar days covers weekends +
// a holiday) — it's delisted or renamed (e.g. LC → HAPN), even though
// Yahoo still serves its frozen last-trade price as a live-looking quote.
const MAX_BAR_AGE_MS = 9 * 24 * 60 * 60 * 1000;

export interface MarketRow {
  quote: StockQuote;
  technicals: TechnicalIndicators;
}

export interface ScoredCandidate extends MarketRow {
  score: number;
  reasons: string[];
  strategy: StrategyTag;
}

// ── Shared: liquidity/quality score (same for both strategies) ──
// Same numbers the old options-quality screen used — kept intact (×0.3
// into the strategy score) so candidate ranking doesn't shift with the
// options removal. It always measured tradability: price tier, beta, volume.
function liquidityQuality(quote: StockQuote): { add: number; reasons: string[] } {
  let s = 0;
  const reasons: string[] = [];

  if (quote.price >= 10 && quote.price <= 150) { s += 25; reasons.push('ideal price range'); }
  else if (quote.price > 150 && quote.price <= 500) s += 15;
  else if (quote.price < 10) s -= 10;

  if (quote.beta !== null) {
    if (quote.beta >= 1.5 && quote.beta <= 3.0) { s += 25; reasons.push(`beta ${quote.beta.toFixed(1)} = high energy`); }
    else if (quote.beta >= 1.0 && quote.beta < 1.5) s += 15;
    else if (quote.beta > 3.0) s += 10;
  } else {
    s += 10;
  }

  if (quote.volume > 5000000) { s += 20; reasons.push('high volume = liquid'); }
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

  const lq = liquidityQuality(quote);
  reasons.push(...lq.reasons);
  score += lq.add * 0.3;

  return { quote, technicals, score, reasons, strategy: 'BREAKOUT' };
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

  const lq = liquidityQuality(quote);
  reasons.push(...lq.reasons);
  score += lq.add * 0.3;

  return { quote, technicals, score, reasons, strategy: 'PULLBACK' };
}

// ── Trade-memory feature capture ────────────────────────────
// The pullback/breakout screens already compute RSI, SMA distance and
// volume — this captures them at the moment of the pick instead of
// discarding them, so the memory bank can find similar past setups.
function pickFeatures(cand: ScoredCandidate, newsVerdict: NewsVerdict): TradeFeatures {
  const { quote, technicals } = cand;
  return {
    rsi: technicals.rsi,
    pctFromSma20: technicals.sma20
      ? ((quote.price - technicals.sma20) / technicals.sma20) * 100
      : null,
    volumeRatio: quote.avgVolume > 0 ? quote.volume / quote.avgVolume : null,
    change5dPct: quote.change5dPct ?? null,
    newsVerdict,
  };
}

// Cheap headline-sentiment majority, used only as the retrieval query's
// news verdict. The live news agent (getNewsView) runs AFTER a pick
// qualifies (to save LLM quota), so its authoritative verdict is what
// gets STORED on the record; this proxy just steers the similarity bonus.
function newsVerdictFromSentiment(news: NewsArticle[]): NewsVerdict {
  if (news.length === 0) return 'none';
  const pos = news.filter(n => n.sentiment === 'positive').length;
  const neg = news.filter(n => n.sentiment === 'negative').length;
  if (pos > neg) return 'bullish';
  if (neg > pos) return 'bearish';
  return 'neutral';
}

// ── V2 trade plan: stamp deterministic exit levels on a pick ──
// The ensemble's own target/stop/RR gate QUALIFICATION (rrFloor below);
// once a pick qualifies, the deterministic per-strategy plan REPLACES
// those levels as the actual exit contract. One source of truth:
// tradePlan.ts. spyPrice (live SPY quote at scan time) is the
// benchmark basis for this pick's eventual excess-return calc.
function applyTradePlan(pick: StockPick, spyPrice: number | null): void {
  const plan = computePlan(pick.currentPrice, pick.strategy);
  pick.targetPrice = plan.tp;
  pick.stopLoss = plan.sl;
  pick.riskRewardRatio = plan.rr;
  pick.horizonDays = plan.horizonDays;
  pick.expiryDate = addTradingDays(etNow().date, plan.horizonDays);
  // Keep this string free of extra digits — news.parseHorizonDays takes
  // the max number it finds ("by 2026-08-12" would read as 2026 days).
  pick.timeHorizon = `${plan.horizonDays} trading days`;
  pick.exitRegime = CURRENT_EXIT_REGIME;
  if (spyPrice != null && spyPrice > 0) pick.spyEntryPrice = spyPrice;
}

// ── Run AI analysis on a ranked candidate list ──────────────
// Candidates may mix strategies (rolling scans rank BREAKOUT and
// PULLBACK together by score); each is analyzed under its own tag.
async function runPicks(
  candidates: ScoredCandidate[],
  count: number,
  analyzed: Set<string>,
  spyPrice: number | null,
  dryRun: boolean,
): Promise<StockPick[]> {
  const out: StockPick[] = [];

  for (const cand of candidates) {
    if (out.length >= count) break;
    if (analyzed.has(cand.quote.ticker)) continue;
    const strategyTag = cand.strategy;

    const news = await getStockNews(cand.quote.ticker, cand.quote.name);

    // Pull similar past graded trades for this strategy (unavailable until
    // 10 closed trades exist per strategy — that's intentional) and show
    // them to the ensemble alongside the market data.
    const features = pickFeatures(cand, newsVerdictFromSentiment(news));
    const memCtx = getMemoryContext(strategyTag, features);
    if (memCtx.available) {
      console.log(`[Scanner] 🧠 ${cand.quote.ticker}: showing ${memCtx.neighbors.length} similar past ${strategyTag} trades to the ensemble`);
    }

    const pick = await analyzeStock(cand.quote, cand.technicals, news,
      memCtx.available ? memCtx.promptBlock : undefined);

    const modelsWorking = pick ? (pick.voteBreakdown?.split('⚠️').length ?? 1) - 1 : 0;
    const fullEnsemble = modelsWorking <= 1; // 3+ models actually voted
    const rrFloor = fullEnsemble ? 2.0 : 1.5;

    const qualifies = pick && pick.confidenceScore >= 65 && pick.riskRewardRatio >= rrFloor;

    if (qualifies) {
      pick!.strategy = strategyTag;

      // Qualification passed on the ensemble's own levels — now the
      // deterministic per-strategy trade plan becomes the actual
      // TP/SL/RR/horizon contract for this position.
      applyTradePlan(pick!, spyPrice);

      // Info-only earnings flag: resolve the next earnings date and
      // mark whether it lands inside the trade's hold window. Only
      // done for actual picks (saves Finnhub quota); never blocks.
      const earningsDate = await getNextEarningsDate(cand.quote.ticker);
      const gap = computeEarningsGap(earningsDate, pick!.timeHorizon);
      if (gap) {
        // The plan has an exact trading-day expiry — use it instead of
        // the string-parsed calendar approximation.
        if (pick!.expiryDate) gap.withinHorizon = gap.date <= pick!.expiryDate;
        pick!.earningsGap = gap;
        if (gap.withinHorizon) {
          console.log(`[Scanner] ⚠️ ${pick!.ticker} earnings in ${gap.daysUntil}d — within ${pick!.timeHorizon} hold window`);
        }
      }

      // Info-only INDEPENDENT news view: a news-only catalyst read kept
      // separate from the technical/ensemble vote. Reuses the news already
      // fetched above; never blocks (null on empty news / LLM failure).
      const newsView = await getNewsView(cand.quote.ticker, news);
      if (newsView) {
        pick!.newsView = newsView;
        const tech = pick!.technicals.trend;
        const diverges = newsView.direction !== 'neutral' && newsView.direction !== tech;
        console.log(`[Scanner] ${diverges ? '🔀 DIVERGENCE' : '🧭'} ${pick!.ticker} news=${newsView.direction}(${newsView.confidence}) vs tech=${tech}`);
      }

      // Record the accepted pick in the trade memory bank. Stored
      // newsVerdict comes from the live news agent when it produced a
      // view; memoryShown is the A/B flag for the head-to-head eval.
      // Dry runs record nothing anywhere.
      if (!dryRun) recordPick({
        ticker: pick!.ticker,
        strategy: strategyTag,
        scanDate: pick!.addedAt,
        entry: pick!.currentPrice,
        target: pick!.targetPrice,
        stop: pick!.stopLoss,
        features: {
          ...features,
          newsVerdict: pick!.newsView ? pick!.newsView.direction : features.newsVerdict,
        },
        ensemble: { consensusScore: pick!.confidenceScore, votes: pick!.voteBreakdown ?? '' },
        memoryShown: memCtx.available,
      });

      out.push(pick!);
      console.log(`[Scanner] ✅ ${strategyTag} STOCK PICK: ${pick!.ticker} (${pick!.confidenceScore}/100, R/R ${pick!.riskRewardRatio})`);
    } else {
      console.log(`[Scanner] ❌ PASS (${strategyTag}): ${cand.quote.ticker}`);
    }

    analyzed.add(cand.quote.ticker);
    await sleep(2000);
  }

  return out;
}

// ── Full scan — runs BOTH strategies, fills open slots ─────
// Rolling-replacement scan: `maxPicks` = number of open slots to fill
// (usually 1; up to MAX_SLOTS on the first run under the new regime).
// Both strategies are scored and their candidates ranked TOGETHER by
// score, so a freed slot goes to the best setup available today
// regardless of which strategy produced it. Never lowers the 0.65
// consensus bar to fill a slot — fewer qualifying picks than slots
// just leaves slots open for the next scan.
export interface ScanOptions {
  dryRun?: boolean;               // analyze but write nothing (no memory records)
  excludeTickers?: Set<string>;   // tickers already held — never double-enter
  universeLimit?: number;         // cap the universe (fast dry-run smoke tests)
}

export async function runScan(
  maxPicks: number,
  opts: ScanOptions = {},
): Promise<{ stockPicks: StockPick[] }> {
  const { dryRun = false, excludeTickers = new Set<string>(), universeLimit } = opts;

  console.log(`[Scanner] Starting scan (Pullback vs Breakout) — filling up to ${maxPicks} slot(s)${dryRun ? ' [DRY RUN]' : ''}...`);
  const fixedList = getCandidateTickers();
  const movers = await getDynamicMovers();
  // Merge fixed universe + today's live movers, deduped; drop held names.
  let candidates = [...new Set([...fixedList, ...movers])]
    .filter(t => !excludeTickers.has(t));
  if (universeLimit && universeLimit > 0) candidates = candidates.slice(0, universeLimit);
  console.log(`[Scanner] Universe: ${fixedList.length} fixed + ${movers.length} movers = ${candidates.length} scannable (${excludeTickers.size} held excluded)`);

  // Live SPY quote — the benchmark basis stamped on each new pick,
  // matching the live-quote entry price convention.
  const spyQuote = await getQuote('SPY');
  const spyPrice = spyQuote?.price ?? null;

  // ── Pass 1: fetch each ticker's data ONCE ────────────────
  console.log(`[Scanner] Fetching data for ${candidates.length} tickers...`);
  const market: MarketRow[] = [];
  for (const ticker of candidates) {
    const quote = await getQuote(ticker);
    if (!quote || quote.price < 3 || quote.price > 3000) { await sleep(400); continue; }

    // Staleness guard: no bar in the last 5 trading days = dead symbol —
    // skip it instead of scoring a frozen quote (uses the 5d bars getQuote
    // already fetched, so this costs no extra request).
    if (!quote.lastBarDate || Date.now() - new Date(quote.lastBarDate).getTime() > MAX_BAR_AGE_MS) {
      console.warn(`[Scanner] ⚠️ ${ticker}: no bar data in the last 5 trading days (last bar: ${quote.lastBarDate ?? 'none'}) — skipping stale/dead symbol`);
      await sleep(400);
      continue;
    }

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

  // ── Pass 3: run AI down the MERGED ranking until slots fill ──
  // A ticker scoring under both strategies is analyzed once, under its
  // higher-scoring strategy (the merged sort puts that one first; the
  // shared `analyzed` set skips the second entry).
  const merged = [...breakout, ...pullback].sort((a, b) => b.score - a.score);
  const stockPicks = await runPicks(merged, maxPicks, new Set<string>(), spyPrice, dryRun);

  const bCount = stockPicks.filter(p => p.strategy === 'BREAKOUT').length;
  const aCount = stockPicks.filter(p => p.strategy === 'PULLBACK').length;
  console.log(`[Scanner] Scan complete: ${stockPicks.length} stock picks (${maxPicks} slot(s) requested)`);
  console.log(`[Scanner] By strategy → BREAKOUT: ${bCount} | PULLBACK: ${aCount}`);

  return { stockPicks };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}