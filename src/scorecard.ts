// ============================================================
// SCORECARD — grades past picks against real outcomes
// Tracks win/loss record so you don't have to check manually
// Now also breaks the record down by entry strategy
// (PULLBACK vs BREAKOUT) for the head-to-head comparison.
// ============================================================

import fs from 'fs';
import path from 'path';
import { PortfolioPosition } from './types';
import { ExitRegime, ExitOutcome } from './tradePlan';
import { getQuote, getSplitAdjustment, getCloseOnOrBefore, getDailyBars, detectFrozenWindow, SplitEvent } from './marketData';
import { recordOutcome } from './memory/tradeMemory';
import { sendGradingReviewAlert, sendStaleQuoteAlert } from './telegram';

// Picks whose computed return exceeds this magnitude don't get auto-graded —
// they're flagged for manual review instead (split-adjustment fixes normal
// splits; this catches anything else: bad data, unhandled corporate actions).
const RETURN_SAFETY_THRESHOLD_PCT = 50;

const DB_FILE = path.join(process.cwd(), 'data', 'portfolio.json');
const HISTORY_FILE = path.join(process.cwd(), 'data', 'scorecard.json');

type Strategy = 'PULLBACK' | 'BREAKOUT' | undefined;

export interface GradedPick {
  ticker: string;
  // 'OPTIONS_CALL' survives only on historical scorecard entries — the bot
  // stopped generating options picks in July 2026, but old grades keep that
  // value forever and stay in the public track record. Never narrow this union.
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
  // Benchmark: this pick's stockReturnPct minus SPY's return over the same
  // pickedDate → gradedDate window. Absent on picks graded before this field
  // existed.
  excessReturnPct?: number;
  // Set (by a manual fix script) on records later found to be corporate-action
  // artifacts — e.g. the LC → HAPN phantom picks graded off a frozen quote.
  // Kept as audit history; every stats consumer must exclude these.
  invalid?: boolean;

  // ── V2 trade-plan fields ────────────────────────────────────
  // Absent exitRegime = legacy V1_WEEKLY grade (weekly drift scoring);
  // stats must never mix the two regimes. outcome above stays WIN/LOSS
  // for every legacy consumer; exitOutcome is the V2 truth
  // (HIT_TARGET / HIT_STOP / TIME_EXIT).
  exitRegime?: ExitRegime;
  exitOutcome?: ExitOutcome;
  rr?: number;
  horizonDays?: number;
  daysHeld?: number;               // trading days actually held
  spyEntryPrice?: number;
  spyExitPrice?: number;
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
    // V2 trade-plan positions resolve through the exit monitor (TP/SL/
    // time expiry on completed bars) — the weekly drift grader must
    // never touch them. It keeps draining legacy V1 rows only.
    if (pos.exitRegime === 'V2_TRADE_PLAN') continue;

    const ageMs = Date.now() - new Date(pos.addedDate).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    if (ageDays < minDays) continue;  // too fresh to grade

    const key = `${pos.ticker}_${pos.addedDate}`;
    if (alreadyGraded.has(key)) continue;  // don't double-grade

    const quote = await getQuote(pos.ticker);
    if (!quote) continue;

    // Frozen-price guard (sibling of the ±50% split guard below): a delisted
    // or renamed symbol (e.g. LC → HAPN) keeps serving its last trade as a
    // live quote, which would grade as a fake flat week. If the hold window
    // shows no actual trading — identical closes, zero volume, or fewer than
    // 2 distinct trading days — flag for manual review instead of grading.
    const bars = await getDailyBars(pos.ticker, pos.addedDate);
    const frozenReason = detectFrozenWindow(bars);
    if (frozenReason) {
      console.warn(`[Scorecard] ${pos.ticker}: ${frozenReason} — skipping auto-grade, flagged for review`);
      await sendStaleQuoteAlert(
        pos.ticker,
        `Picked ${pos.addedDate.slice(0, 10)} at $${pos.entryPrice.toFixed(2)} — grading skipped.`,
        frozenReason
      );
      continue;  // leave ungraded — retried on the next grading run
    }

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

// ── V2: record a trade-plan exit as a graded pick ───────────
// Called by the exit monitor when a position resolves on TP, SL, or
// time expiry. WIN/LOSS stays populated so every legacy consumer
// (Telegram /record, dashboard, evaluation) keeps working; exitOutcome
// carries the V2 truth. Idempotent on ticker+pickedDate like gradePicks.
export interface TradePlanExit {
  outcome: ExitOutcome;
  exitDate: string;          // YYYY-MM-DD of the exit bar
  exitPrice: number;
  daysHeld: number;          // trading days actually held
  spyEntryPrice?: number;
  spyExitPrice?: number;
}

export function recordTradePlanExit(
  pos: PortfolioPosition, exit: TradePlanExit,
): GradedPick | null {
  const history = loadHistory();
  const key = `${pos.ticker}_${pos.addedDate}`;
  if (history.graded.some(g => `${g.ticker}_${g.pickedDate}` === key)) {
    return null;  // already recorded — the monitor re-running can't double-grade
  }

  const stockReturnPct = ((exit.exitPrice - pos.entryPrice) / pos.entryPrice) * 100;
  const outcome: 'WIN' | 'LOSS' =
    exit.outcome === 'HIT_TARGET' ? 'WIN'
      : exit.outcome === 'HIT_STOP' ? 'LOSS'
      : stockReturnPct >= 0 ? 'WIN' : 'LOSS';
  const note =
    exit.outcome === 'HIT_TARGET' ? `Hit target $${pos.targetPrice.toFixed(2)} on day ${exit.daysHeld}`
      : exit.outcome === 'HIT_STOP' ? `Hit stop $${pos.stopLoss.toFixed(2)} on day ${exit.daysHeld}`
      : `Time exit at $${exit.exitPrice.toFixed(2)} after ${exit.daysHeld} trading days`;

  let excessReturnPct: number | undefined;
  if (exit.spyEntryPrice && exit.spyExitPrice && exit.spyEntryPrice > 0) {
    const spyReturnPct = ((exit.spyExitPrice - exit.spyEntryPrice) / exit.spyEntryPrice) * 100;
    excessReturnPct = parseFloat((stockReturnPct - spyReturnPct).toFixed(2));
  }

  const graded: GradedPick = {
    ticker: pos.ticker,
    pickType: pos.pickType,
    strategy: pos.strategy,
    entryPrice: pos.entryPrice,
    targetPrice: pos.targetPrice,
    stopLoss: pos.stopLoss,
    finalPrice: parseFloat(exit.exitPrice.toFixed(2)),
    pickedDate: pos.addedDate,
    gradedDate: new Date().toISOString(),
    outcome,
    stockReturnPct: parseFloat(stockReturnPct.toFixed(2)),
    note,
    excessReturnPct,
    exitRegime: 'V2_TRADE_PLAN',
    exitOutcome: exit.outcome,
    rr: pos.rr,
    horizonDays: pos.horizonDays,
    daysHeld: exit.daysHeld,
    spyEntryPrice: exit.spyEntryPrice,
    spyExitPrice: exit.spyExitPrice,
  };

  history.graded.push(graded);
  saveHistory(history);

  // Close the matching memory record with the same verdict. Idempotent.
  recordOutcome({
    ticker: pos.ticker,
    strategy: pos.strategy,
    scanDate: pos.addedDate,
    status: exit.outcome === 'TIME_EXIT' ? 'TIME_EXIT' : exit.outcome,
    exitDate: exit.exitDate,
    exitPrice: exit.exitPrice,
  });

  console.log(`[Scorecard] V2 exit ${pos.ticker} [${pos.strategy || 'n/a'}]: ${exit.outcome} (${stockReturnPct.toFixed(1)}% in ${exit.daysHeld}d)`);
  return graded;
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
  // invalid === true = corporate-action artifact kept only as audit history
  // (e.g. the LC → HAPN phantom picks) — never counted in the record.
  const graded = history.graded.filter(g => g.outcome !== 'OPEN' && g.invalid !== true);

  const overall = tally(graded);
  // OPTIONS_CALL is a closed historical category (no new options picks since
  // July 2026) — old grades still count toward the public record.
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
  return history.graded.filter(g => g.invalid !== true).slice(-limit).reverse();
}