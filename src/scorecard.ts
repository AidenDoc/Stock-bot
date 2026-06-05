// ============================================================
// SCORECARD — grades past picks against real outcomes
// Tracks win/loss record so you don't have to check manually
// ============================================================

import fs from 'fs';
import path from 'path';
import { PortfolioPosition } from './types';
import { getQuote } from './marketData';

const DB_FILE = path.join(process.cwd(), 'data', 'portfolio.json');
const HISTORY_FILE = path.join(process.cwd(), 'data', 'scorecard.json');

export interface GradedPick {
  ticker: string;
  pickType: 'OPTIONS_CALL' | 'STOCK_LONG';
  entryPrice: number;       // stock price when picked
  targetPrice: number;
  stopLoss: number;
  finalPrice: number;       // stock price at grading time
  pickedDate: string;
  gradedDate: string;
  outcome: 'WIN' | 'LOSS' | 'OPEN';   // hit target = WIN, hit stop = LOSS, else OPEN
  stockReturnPct: number;   // % move in the underlying stock
  note: string;
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

    const finalPrice = quote.price;
    const entry = pos.entryPrice;
    const stockReturnPct = ((finalPrice - entry) / entry) * 100;

    // Determine outcome based on whether stock hit target or stop
    let outcome: 'WIN' | 'LOSS' | 'OPEN' = 'OPEN';
    let note = '';
    if (finalPrice >= pos.targetPrice) {
      outcome = 'WIN';
      note = `Hit target $${pos.targetPrice.toFixed(2)}`;
    } else if (finalPrice <= pos.stopLoss) {
      outcome = 'LOSS';
      note = `Hit stop $${pos.stopLoss.toFixed(2)}`;
    } else {
      // Didn't hit either — grade by direction
      outcome = stockReturnPct >= 0 ? 'WIN' : 'LOSS';
      note = `Closed between levels (${stockReturnPct >= 0 ? 'up' : 'down'})`;
    }

    const graded: GradedPick = {
      ticker: pos.ticker,
      pickType: pos.pickType,
      entryPrice: entry,
      targetPrice: pos.targetPrice,
      stopLoss: pos.stopLoss,
      finalPrice,
      pickedDate: pos.addedDate,
      gradedDate: new Date().toISOString(),
      outcome,
      stockReturnPct: parseFloat(stockReturnPct.toFixed(2)),
      note,
    };

    history.graded.push(graded);
    newlyGraded.push(graded);
    console.log(`[Scorecard] ${pos.ticker}: ${outcome} (${stockReturnPct.toFixed(1)}% stock move)`);
  }

  saveHistory(history);
  console.log(`[Scorecard] Graded ${newlyGraded.length} new picks`);
  return newlyGraded;
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
} {
  const history = loadHistory();
  const graded = history.graded.filter(g => g.outcome !== 'OPEN');

  const wins = graded.filter(g => g.outcome === 'WIN').length;
  const losses = graded.filter(g => g.outcome === 'LOSS').length;
  const total = wins + losses;
  const avgStockReturn = total > 0
    ? graded.reduce((sum, g) => sum + g.stockReturnPct, 0) / total
    : 0;

  const opts = graded.filter(g => g.pickType === 'OPTIONS_CALL');
  const stocks = graded.filter(g => g.pickType === 'STOCK_LONG');

  return {
    total,
    wins,
    losses,
    winRate: total > 0 ? (wins / total) * 100 : 0,
    avgStockReturn: parseFloat(avgStockReturn.toFixed(2)),
    optionsRecord: {
      wins: opts.filter(g => g.outcome === 'WIN').length,
      losses: opts.filter(g => g.outcome === 'LOSS').length,
    },
    stockRecord: {
      wins: stocks.filter(g => g.outcome === 'WIN').length,
      losses: stocks.filter(g => g.outcome === 'LOSS').length,
    },
  };
}

export function getRecentGraded(limit: number = 8): GradedPick[] {
  const history = loadHistory();
  return history.graded.slice(-limit).reverse();
}
