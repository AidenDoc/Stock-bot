// ============================================================
// SCORECARD — grades past picks against real outcomes
// Tracks win/loss record so you don't have to check manually
// Now also breaks the record down by entry strategy
// (PULLBACK vs BREAKOUT) for the head-to-head comparison.
// ============================================================

import fs from 'fs';
import path from 'path';
import { PortfolioPosition } from './types';
import { getQuote, getSplitAdjustment, getCloseOnOrBefore, SplitEvent } from './marketData';
import { recordOutcome } from './memory/tradeMemory';
import { sendGradingReviewAlert } from './telegram';

// Picks whose computed return exceeds this magnitude don't get auto-graded —
// they're flagged for manual review instead (split-adjustment fixes normal
// splits; this catches anything else: bad data, unhandled corporate actions).
const RETURN_SAFETY_THRESHOLD_PCT = 50;

const DB_FILE = path.join(process.cwd(), 'data', 'portfolio.json');
const HISTORY_FILE = path.join(process.cwd(), 'data', 'scorecard.json');

type Strategy = 'PULLBACK' | 'BREAKOUT' | undefined;

export interface GradedPick {
  ticker: string;
  pickType: 'OPTIONS_CALL' | 'STOCK_LONG';
  strategy?: 'PULLBACK' | 'BREAKOUT';
  entryPrice: number;
  targetPrice: number;
  stopLoss: number;
  finalPrice: number;
  pickedDate: string;
  gradedDate: string;
  outcome: 'WIN' | 'LOSS' | 'OPEN';
  stockReturnPct: number;
  note: string;
  // ── Options-grading arm (backtest only; optional, set alongside the
  //    existing stock-drift grade, never replacing it) ──
  optReturnPct?: number;            // Black-Scholes contract P&L % over the same hold
  optOutcome?: 'WIN' | 'LOSS';      // option WIN/LOSS by contract P&L sign (≠ stock outcome)
  // Benchmark: this pick's stockReturnPct minus SPY's return over the same
  // pickedDate → gradedDate window. Absent on picks graded before this field
  // existed.
  excessReturnPct?: number;
}

interface ScorecardHistory {
  graded: GradedPick[];
}

function loadPortfolio(): PortfolioPosition[] {
  try {
    if (!fs.existsSync(DB_FILE)) return [];
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function loadHistory(): ScorecardHistory {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return { graded: [] };
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
  } catch {
    return { graded: [] };
  }
}

function saveHistory(history: ScorecardHistory): void {
  const dir = path.dirname(HISTORY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

// ── Grade all positions that are at least `minDays` old ────
export async function gradePicks(minDays: number = 5): Promise<GradedPick[]> {
  console.log('[Scorecard] Grading picks...');
  const positions = loadPortfolio();
  const history = loadHistory();
  const alreadyGraded = new Set(
    history.graded.map(g => `${g.ticker}_${g.pickedDate}`)
  );

  const newlyGraded: GradedPick[] = [];

  for (const pos of positions) {
    const ageMs = Date.now() - new Date(pos.addedDate).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    if (ageDays < minDays) continue;  // too fresh to grade

    const key = `${pos.ticker}_${pos.addedDate}`;
    if (alreadyGraded.has(key)) continue;  // don't double-grade

    const quote = await getQuote(pos.ticker);
    if (!quote) continue;

    // A split between pickedDate and now silently rescales every later raw
    // quote — bring it back to the scale entry/target/stop were set in
    // before comparing against them.
    const { ratio: splitRatio, events: splitEvents } = await getSplitAdjustment(pos.ticker, pos.addedDate);
    const finalPrice = parseFloat((quote.price * splitRatio).toFixed(2));
    const entry = pos.entryPrice;
    const stockReturnPct = ((finalPrice - entry) / entry) * 100;

    // Safety net: split-adjustment fixes normal splits, but anything else
    // producing a huge move (bad data, an unhandled corporate action) gets
    // flagged for manual review instead of silently auto-grading.
    if (Math.abs(stockReturnPct) > RETURN_SAFETY_THRESHOLD_PCT) {
      console.warn(`[Scorecard] ${pos.ticker}: computed return ${stockReturnPct.toFixed(1)}% exceeds ±${RETURN_SAFETY_THRESHOLD_PCT}% safety threshold — skipping auto-grade, flagged for review`);
      await sendGradingReviewAlert(pos.ticker, pos.addedDate, entry, finalPrice, stockReturnPct, splitEvents);
      continue;  // leave ungraded — retried on the next grading run
    }

    let outcome: 'WIN' | 'LOSS' | 'OPEN' = 'OPEN';
    let note = '';
    if (finalPrice >= pos.targetPrice) {
      outcome = 'WIN';
      note = `Hit target $${pos.targetPrice.toFixed(2)}`;
    } else if (finalPrice <= pos.stopLoss) {
      outcome = 'LOSS';
      note = `Hit stop $${pos.stopLoss.toFixed(2)}`;
    } else {
      outcome = stockReturnPct >= 0 ? 'WIN' : 'LOSS';
      note = `Closed between levels (${stockReturnPct >= 0 ? 'up' : 'down'})`;
    }
    if (splitEvents.length) {
      note += ` (adjusted for ${splitEvents.map((e: SplitEvent) => `${e.ratioText} split on ${e.date}`).join(', ')})`;
    }

    const gradedDate = new Date().toISOString();

    // Benchmark: excess return vs SPY over the same hold window.
    let excessReturnPct: number | undefined;
    const spyStart = await getCloseOnOrBefore('SPY', pos.addedDate);
    const spyEnd = await getCloseOnOrBefore('SPY', gradedDate);
    if (spyStart && spyEnd) {
      const spyReturnPct = ((spyEnd - spyStart) / spyStart) * 100;
      excessReturnPct = parseFloat((stockReturnPct - spyReturnPct).toFixed(2));
    }

    const graded: GradedPick = {
      ticker: pos.ticker,
      pickType: pos.pickType,
      strategy: pos.strategy,           // carry the tag onto the graded record
      entryPrice: entry,
      targetPrice: pos.targetPrice,
      stopLoss: pos.stopLoss,
      finalPrice,
      pickedDate: pos.addedDate,
      gradedDate,
      outcome,
      stockReturnPct: parseFloat(stockReturnPct.toFixed(2)),
      note,
      excessReturnPct,
    };

    history.graded.push(graded);
    newlyGraded.push(graded);

    // Close the matching trade-memory record with the same verdict the
    // scorecard just reached. Idempotent — regrades/reconciles can't
    // double-close it.
    recordOutcome({
      ticker: pos.ticker,
      strategy: pos.strategy,
      scanDate: pos.addedDate,
      status: finalPrice >= pos.targetPrice ? 'HIT_TARGET'
        : finalPrice <= pos.stopLoss ? 'HIT_STOP'
        : 'CLOSED_FLAT',
      exitDate: graded.gradedDate,
      exitPrice: finalPrice,
    });

    console.log(`[Scorecard] ${pos.ticker} [${pos.strategy || 'n/a'}]: ${outcome} (${stockReturnPct.toFixed(1)}% stock move)`);
  }

  saveHistory(history);
  console.log(`[Scorecard] Graded ${newlyGraded.length} new picks`);
  return newlyGraded;
}

// ── Helper: tally a subset of graded picks ─────────────────
function tally(graded: GradedPick[]) {
  const closed = graded.filter(g => g.outcome !== 'OPEN');
  const wins = closed.filter(g => g.outcome === 'WIN').length;
  const losses = closed.filter(g => g.outcome === 'LOSS').length;
  const total = wins + losses;
  const avgStockReturn = total > 0
    ? closed.reduce((sum, g) => sum + g.stockReturnPct, 0) / total
    : 0;
  return {
    total,
    wins,
    losses,
    winRate: total > 0 ? (wins / total) * 100 : 0,
    avgStockReturn: parseFloat(avgStockReturn.toFixed(2)),
  };
}

// ── Build the running record summary ───────────────────────
export function getRecord(): {
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  avgStockReturn: number;
  optionsRecord: { wins: number; losses: number };
  stockRecord: { wins: number; losses: number };
  byStrategy: {
    pullback: { total: number; wins: number; losses: number; winRate: number; avgStockReturn: number };
    breakout: { total: number; wins: number; losses: number; winRate: number; avgStockReturn: number };
  };
} {
  const history = loadHistory();
  const graded = history.graded.filter(g => g.outcome !== 'OPEN');

  const overall = tally(graded);
  const opts = graded.filter(g => g.pickType === 'OPTIONS_CALL');
  const stocks = graded.filter(g => g.pickType === 'STOCK_LONG');

  return {
    total: overall.total,
    wins: overall.wins,
    losses: overall.losses,
    winRate: overall.winRate,
    avgStockReturn: overall.avgStockReturn,
    optionsRecord: {
      wins: opts.filter(g => g.outcome === 'WIN').length,
      losses: opts.filter(g => g.outcome === 'LOSS').length,
    },
    stockRecord: {
      wins: stocks.filter(g => g.outcome === 'WIN').length,
      losses: stocks.filter(g => g.outcome === 'LOSS').length,
    },
    byStrategy: {
      pullback: tally(graded.filter(g => g.strategy === 'PULLBACK')),
      breakout: tally(graded.filter(g => g.strategy === 'BREAKOUT')),
    },
  };
}

export function getRecentGraded(limit: number = 8): GradedPick[] {
  const history = loadHistory();
  return history.graded.slice(-limit).reverse();
}