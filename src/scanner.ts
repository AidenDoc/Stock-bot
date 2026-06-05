// ============================================================
// SCANNER — scores candidates across all market caps
// Includes large, mid, small cap + momentum/meme/biotech/sector
// Options Greek quality scoring for options picks
// ============================================================

import { StockQuote, TechnicalIndicators } from './types';
import { getQuote, getTechnicals, getCandidateTickers } from './marketData';
import { getStockNews } from './news';
import { analyzeStock } from './analyst';
import { StockPick } from './types';

interface ScoredCandidate {
  quote: StockQuote;
  technicals: TechnicalIndicators;
  score: number;
  optionsScore: number;  // separate score for options Greek quality
  reasons: string[];
}

async function scoreCandidate(ticker: string): Promise<ScoredCandidate | null> {
  const quote = await getQuote(ticker);
  if (!quote || quote.price < 3 || quote.price > 3000) return null;

  const technicals = await getTechnicals(ticker, quote.price);
  let score = 0;
  let optionsScore = 0;
  const reasons: string[] = [];

  // ── Trend & momentum ─────────────────────────────────────
  if (technicals.trend === 'bullish') {
    score += 20;
    reasons.push('bullish trend');
  }

  // RSI sweet spot
  if (technicals.rsi !== null) {
    if (technicals.rsi >= 45 && technicals.rsi <= 65) {
      score += 15;
      reasons.push(`RSI ${technicals.rsi.toFixed(0)} in ideal zone`);
    } else if (technicals.rsi < 35) {
      score += 10;
      reasons.push(`RSI ${technicals.rsi.toFixed(0)} oversold bounce potential`);
    } else if (technicals.rsi > 70) {
      score -= 5; // overbought penalty
    }
  }

  // Price above SMA50
  if (technicals.sma50 && quote.price > technicals.sma50) {
    score += 10;
    reasons.push('above SMA50');
  }

  // Room to run (not near 52w high)
  const distFrom52wHigh = (quote.week52High - quote.price) / quote.week52High;
  if (distFrom52wHigh > 0.10 && distFrom52wHigh < 0.60) {
    score += 10;
    reasons.push('room to 52w high');
  }

  // Near 52w low = avoid for calls
  const distFrom52wLow = (quote.price - quote.week52Low) / quote.price;
  if (distFrom52wLow < 0.05) {
    score -= 15; // near 52w low, avoid
  }

  // ── Options Greek quality scoring ────────────────────────
  // Good options candidates need: price $5-500, higher beta, decent volume

  // Price range sweet spot for options (not too cheap, not too expensive)
  if (quote.price >= 10 && quote.price <= 150) {
    optionsScore += 25;
    reasons.push('ideal options price range');
  } else if (quote.price > 150 && quote.price <= 500) {
    optionsScore += 15;
  } else if (quote.price < 10) {
    optionsScore -= 10; // cheap stocks have wide spreads
  }

  // Beta (higher = more premium, better for directional calls)
  if (quote.beta !== null) {
    if (quote.beta >= 1.5 && quote.beta <= 3.0) {
      optionsScore += 25;
      reasons.push(`beta ${quote.beta.toFixed(1)} = rich premium`);
    } else if (quote.beta >= 1.0 && quote.beta < 1.5) {
      optionsScore += 15;
      reasons.push(`beta ${quote.beta.toFixed(1)}`);
    } else if (quote.beta > 3.0) {
      optionsScore += 10; // too volatile = expensive spreads
    }
  } else {
    optionsScore += 10; // unknown beta, neutral
  }

  // Volume (need liquidity for options)
  if (quote.volume > 5000000) {
    optionsScore += 20;
    reasons.push('high volume = liquid options');
  } else if (quote.volume > 1000000) {
    optionsScore += 10;
  } else {
    optionsScore -= 15; // illiquid options = wide spreads
  }

  // RSI momentum for options (want momentum behind the move)
  if (technicals.rsi !== null && technicals.rsi >= 50 && technicals.rsi <= 68) {
    optionsScore += 15;
  }

  // Combine scores
  score += optionsScore * 0.3; // options score contributes to overall

  return { quote, technicals, score, optionsScore, reasons };
}

// ── Full weekly scan ───────────────────────────────────────
export async function runWeeklyScan(
  optionsCount: number = 3,
  stockCount: number = 4
): Promise<{ optionsPicks: StockPick[]; stockPicks: StockPick[] }> {

  console.log('[Scanner] Starting weekly scan...');
  const candidates = getCandidateTickers();

  console.log(`[Scanner] Scoring ${candidates.length} tickers...`);
  const scored: ScoredCandidate[] = [];

  for (const ticker of candidates) {
    const candidate = await scoreCandidate(ticker);
    if (candidate && candidate.score >= 25) {
      scored.push(candidate);
      console.log(`[Scanner] ${ticker}: score=${Math.round(candidate.score)} optionsScore=${candidate.optionsScore} (${candidate.reasons.slice(0,3).join(', ')})`);
    }
    await sleep(800); // Alpha Vantage free = 5 req/min, be careful
  }

  scored.sort((a, b) => b.score - a.score);
  console.log(`[Scanner] ${scored.length} candidates passed pre-screen`);

  if (scored.length === 0) {
    console.log('[Scanner] No candidates passed — market may be broadly weak');
    return { optionsPicks: [], stockPicks: [] };
  }

  const optionsPicks: StockPick[] = [];
  const stockPicks: StockPick[] = [];
  const analyzed = new Set<string>();

  // Best options candidates = highest optionsScore + bullish
  const optionsCandidates = [...scored]
    .sort((a, b) => b.optionsScore - a.optionsScore)
    .filter(c => c.optionsScore >= 30 && c.quote.price >= 5);

  console.log('[Scanner] Running AI analysis for options picks...');
  for (const candidate of optionsCandidates) {
    if (optionsPicks.length >= optionsCount) break;
    if (analyzed.has(candidate.quote.ticker)) continue;

    const news = await getStockNews(candidate.quote.ticker, candidate.quote.name);
    const pick = await analyzeStock(candidate.quote, candidate.technicals, news, 'OPTIONS_CALL');

    const optionsModelsWorking = pick ? (pick.voteBreakdown?.split('⚠️').length ?? 1) - 1 : 0;
    const fullEnsemble = optionsModelsWorking <= 1; // 3+ models working
    const optionsQualifies = pick && pick.confidenceScore >= 65 &&
      (fullEnsemble ? pick.riskRewardRatio >= 2.5 : pick.riskRewardRatio >= 1.5);
    if (optionsQualifies) {
      optionsPicks.push(pick!);
      console.log(`[Scanner] ✅ OPTIONS PICK: ${pick.ticker} (${pick.confidenceScore}/100)`);
    } else {
      console.log(`[Scanner] ❌ PASS: ${candidate.quote.ticker}`);
    }

    analyzed.add(candidate.quote.ticker);
    await sleep(2000);
  }

  // Stock picks from remaining top candidates
  console.log('[Scanner] Running AI analysis for stock picks...');
  for (const candidate of scored) {
    if (stockPicks.length >= stockCount) break;
    if (analyzed.has(candidate.quote.ticker)) continue;

    const news = await getStockNews(candidate.quote.ticker, candidate.quote.name);
    const pick = await analyzeStock(candidate.quote, candidate.technicals, news, 'STOCK_LONG');

    const stockModelsWorking = pick ? (pick.voteBreakdown?.split('⚠️').length ?? 1) - 1 : 0;
    const fullStockEnsemble = stockModelsWorking <= 1;
    const stockQualifies = pick && pick.confidenceScore >= 65 &&
      (fullStockEnsemble ? pick.riskRewardRatio >= 2.0 : pick.riskRewardRatio >= 1.5);
    if (stockQualifies) {
      stockPicks.push(pick!);
      console.log(`[Scanner] ✅ STOCK PICK: ${pick.ticker} (${pick.confidenceScore}/100)`);
    } else {
      console.log(`[Scanner] ❌ PASS: ${candidate.quote.ticker}`);
    }

    analyzed.add(candidate.quote.ticker);
    await sleep(2000);
  }

  console.log(`[Scanner] Scan complete: ${optionsPicks.length} options picks, ${stockPicks.length} stock picks`);
  return { optionsPicks, stockPicks };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
