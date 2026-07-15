// ============================================================
// PORTFOLIO TRACKER — tracks open positions, checks targets
// Persists to a JSON file (same pattern as Kalshi bot)
// ============================================================

import fs from 'fs';
import path from 'path';
import { PortfolioPosition, StockPick, DailyUpdate } from './types';
import { getQuote, getSplitAdjustment } from './marketData';
import { getStockNews } from './news';
import { generatePositionUpdate } from './analyst';
import {
  sendTargetHitAlert,
  sendStopLossAlert,
  sendStaleQuoteAlert,
  sendDailyUpdate
} from './telegram';

const DB_FILE = path.join(process.cwd(), 'data', 'portfolio.json');
const SCORECARD_FILE = path.join(process.cwd(), 'data', 'scorecard.json');

// Consecutive daily checks at an EXACTLY identical price before flagging a
// possible delisting/ticker change. 2 repeats = 3 identical checks in a row;
// an intraday quote landing on the same cent that many times is a frozen
// feed (e.g. LC after the HAPN rename), not a quiet stock.
const STALE_PRICE_CHECK_THRESHOLD = 2;

// ── Load / Save ────────────────────────────────────────────
function loadPortfolio(): PortfolioPosition[] {
  try {
    if (!fs.existsSync(DB_FILE)) return [];
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

// Minimal shape of a graded pick — we only read it here (grading itself
// lives in scorecard.ts and is left untouched).
interface GradedLite {
  ticker: string;
  pickedDate: string;   // === the position's addedDate at grade time
  finalPrice?: number;
  stockReturnPct?: number;
}

function loadGraded(): GradedLite[] {
  try {
    if (!fs.existsSync(SCORECARD_FILE)) return [];
    const h = JSON.parse(fs.readFileSync(SCORECARD_FILE, 'utf-8'));
    return Array.isArray(h?.graded) ? h.graded : [];
  } catch {
    return [];
  }
}

function savePortfolio(positions: PortfolioPosition[]): void {
  const dir = path.dirname(DB_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(positions, null, 2));
}

// Two open rows are "the same pick" when they share ticker AND strategy and
// neither has resolved yet. (Legacy rows have no strategy → treated as ''.)
function sameOpenPick(p: PortfolioPosition, ticker: string, strategy?: string): boolean {
  return p.status !== 'CLOSED'
    && p.ticker === ticker
    && (p.strategy ?? '') === (strategy ?? '');
}

// ── Add position from a pick ───────────────────────────────
export function addPosition(pick: StockPick): void {
  const positions = loadPortfolio();

  // One row per ticker+strategy while a pick is still being evaluated.
  // If we're already tracking this name+strategy, refresh that row in place
  // rather than appending a duplicate (the weekly scan re-picks names).
  const existing = positions.find(p => sameOpenPick(p, pick.ticker, pick.strategy));
  if (existing) {
    // Keep the original entryPrice + addedDate so the P&L basis and the
    // grading/evaluation clock stay anchored to the FIRST time we logged it;
    // just freshen the live targets and the info-only reads.
    existing.currentPrice = pick.currentPrice;
    existing.targetPrice  = pick.targetPrice;
    existing.stopLoss     = pick.stopLoss;
    existing.pickType     = pick.pickType;
    existing.notes        = pick.summary;
    existing.techTrend    = pick.technicals?.trend;
    existing.newsView     = pick.newsView;
    savePortfolio(positions);
    console.log(`[Portfolio] ${pick.ticker} (${pick.strategy || 'n/a'}) already tracked — refreshed in place`);
    return;
  }

  const position: PortfolioPosition = {
    ticker: pick.ticker,
    pickType: pick.pickType,
    entryPrice: pick.currentPrice,  // Use current price as entry (you confirm in Robinhood)
    currentPrice: pick.currentPrice,
    targetPrice: pick.targetPrice,
    stopLoss: pick.stopLoss,
    addedDate: new Date().toISOString(),
    status: 'WATCHING',  // WATCHING = not entered yet, ACTIVE = you're in the trade
    pnlPercent: 0,
    notes: pick.summary,
    strategy: pick.strategy,  // carry the PULLBACK / BREAKOUT tag through for grading
    techTrend: pick.technicals?.trend,   // technical read at pick time
    newsView: pick.newsView,             // independent news-only view (info-only)
  };

  positions.push(position);
  savePortfolio(positions);
  console.log(`[Portfolio] Added ${pick.ticker} (${pick.strategy || 'n/a'}) to watchlist`);
}

// ── Mark as entered (call this when you actually buy) ──────
export function enterPosition(ticker: string, entryPrice: number): void {
  const positions = loadPortfolio();
  const pos = positions.find(p => p.ticker === ticker && p.status === 'WATCHING');
  if (!pos) {
    console.log(`[Portfolio] ${ticker} not found in watchlist`);
    return;
  }

  pos.status = 'ACTIVE';
  pos.entryPrice = entryPrice;
  savePortfolio(positions);
  console.log(`[Portfolio] ${ticker} marked as ACTIVE at $${entryPrice}`);
}

// ── Close a position ──────────────────────────────────────
export function closePosition(ticker: string, exitPrice?: number): void {
  const positions = loadPortfolio();
  const pos = positions.find(p => p.ticker === ticker && p.status !== 'CLOSED');
  if (!pos) return;

  if (exitPrice) {
    pos.pnlPercent = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;
  }
  pos.status = 'CLOSED';
  savePortfolio(positions);
  console.log(`[Portfolio] ${ticker} closed. P&L: ${pos.pnlPercent.toFixed(1)}%`);
}

// ── Reconcile the tracker so "active picks" stays honest ───
// Two clean-ups, both idempotent and safe to run every pipeline:
//   1. RESOLVE — any position that already has a graded record is settled.
//      It belongs in the graded Results, not in the live list, so close it.
//      (Grading itself is untouched; we only follow it.)
//   2. DEDUPE — collapse legacy duplicate open rows for the same
//      ticker+strategy into one canonical row (older code appended a new row
//      on every weekly scan). Earliest add keeps the evaluation clock; the
//      newest pick supplies the current targets/notes.
export function reconcilePortfolio(): { closed: number; deduped: number } {
  const positions = loadPortfolio();
  let closed = 0;
  let deduped = 0;

  // 1) Resolve already-graded picks → CLOSED.
  const gradedByKey = new Map<string, GradedLite>();
  for (const g of loadGraded()) gradedByKey.set(`${g.ticker}_${g.pickedDate}`, g);

  for (const p of positions) {
    if (p.status === 'CLOSED') continue;
    const g = gradedByKey.get(`${p.ticker}_${p.addedDate}`);
    if (g) {
      p.status = 'CLOSED';
      if (typeof g.finalPrice === 'number') p.currentPrice = g.finalPrice;
      if (typeof g.stockReturnPct === 'number') p.pnlPercent = g.stockReturnPct;
      closed++;
    }
  }

  // 2) Dedupe the still-open rows by ticker+strategy.
  const groups = new Map<string, PortfolioPosition[]>();
  for (const p of positions) {
    if (p.status === 'CLOSED') continue;
    const key = `${p.ticker}|${p.strategy ?? ''}`;
    const grp = groups.get(key);
    if (grp) grp.push(p); else groups.set(key, [p]);
  }

  const drop = new Set<PortfolioPosition>();
  for (const grp of groups.values()) {
    if (grp.length < 2) continue;
    const sorted = [...grp].sort(
      (a, b) => new Date(a.addedDate).getTime() - new Date(b.addedDate).getTime()
    );
    const canonical = sorted[0];                 // earliest add = canonical
    const newest = sorted[sorted.length - 1];    // newest pick = fresh targets
    canonical.currentPrice = newest.currentPrice;
    canonical.targetPrice  = newest.targetPrice;
    canonical.stopLoss     = newest.stopLoss;
    canonical.pickType     = newest.pickType;
    canonical.notes        = newest.notes;
    canonical.techTrend    = newest.techTrend;
    canonical.newsView     = newest.newsView;
    for (let i = 1; i < sorted.length; i++) { drop.add(sorted[i]); deduped++; }
  }

  const cleaned = positions.filter(p => !drop.has(p));
  savePortfolio(cleaned);
  console.log(`[Portfolio] Reconcile: closed ${closed} resolved pick(s), removed ${deduped} duplicate row(s)`);
  return { closed, deduped };
}

// ── Daily check — update prices, fire alerts ──────────────
export async function runDailyCheck(): Promise<void> {
  console.log('[Portfolio] Running daily position check...');
  const positions = loadPortfolio().filter(p => p.status !== 'CLOSED');

  if (positions.length === 0) {
    console.log('[Portfolio] No active positions to check');
    await sendDailyUpdate([]);
    return;
  }

  const updates: DailyUpdate[] = [];

  for (const pos of positions) {
    const quote = await getQuote(pos.ticker);
    if (!quote) continue;

    // A split since this position was opened (or last checked) leaves its
    // stored entry/target/stop stuck at the pre-split scale while every new
    // quote comes back post-split — rescale them down once so comparisons
    // (and the alerts below) stay accurate instead of tripping a false
    // stop-loss warning. Tracked incrementally via splitAdjustedThrough so
    // a daily re-check never double-adjusts the same split.
    const { ratio: splitRatio, events: splitEvents } = await getSplitAdjustment(
      pos.ticker, pos.splitAdjustedThrough || pos.addedDate
    );
    if (splitRatio !== 1) {
      pos.entryPrice /= splitRatio;
      pos.targetPrice /= splitRatio;
      pos.stopLoss /= splitRatio;
      pos.notes += ` [rescaled for ${splitEvents.map(e => `${e.ratioText} split on ${e.date}`).join(', ')}]`;
      console.log(`[Portfolio] ${pos.ticker}: rescaled entry/target/stop for ${splitEvents.map(e => e.ratioText).join(', ')} split`);
    }
    pos.splitAdjustedThrough = new Date().toISOString();

    const currentPrice = quote.price;
    pos.currentPrice = currentPrice;
    pos.pnlPercent = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

    // Frozen-quote guard: a delisted/renamed symbol serves its last trade
    // forever, which reads as "no movement" day after day. Track consecutive
    // identical quotes and alert instead of silently reporting a flat hold.
    // Deliberately re-alerts on every check while frozen — this condition
    // needs a human to act, and it clears itself the moment the price moves.
    if (pos.lastCheckPrice != null && currentPrice === pos.lastCheckPrice) {
      pos.stalePriceChecks = (pos.stalePriceChecks ?? 0) + 1;
    } else {
      pos.stalePriceChecks = 0;
    }
    pos.lastCheckPrice = currentPrice;
    if (pos.stalePriceChecks >= STALE_PRICE_CHECK_THRESHOLD) {
      const checksSeen = pos.stalePriceChecks + 1;
      console.warn(`[Portfolio] ${pos.ticker}: price frozen at $${currentPrice.toFixed(2)} across ${checksSeen} consecutive daily checks — possible delisting/ticker change`);
      await sendStaleQuoteAlert(
        pos.ticker,
        `Open position (added ${pos.addedDate.slice(0, 10)}) — the daily check price has stopped moving.`,
        `quote frozen at $${currentPrice.toFixed(2)} across ${checksSeen} consecutive daily checks`
      );
    }

    // Check target hit (for ACTIVE positions)
    if (pos.status === 'ACTIVE' && currentPrice >= pos.targetPrice) {
      await sendTargetHitAlert(pos.ticker, currentPrice, pos.pnlPercent);
    }

    // Check stop loss warning (within 2% of stop)
    if (pos.status === 'ACTIVE' && currentPrice <= pos.stopLoss * 1.02) {
      await sendStopLossAlert(pos.ticker, currentPrice, pos.stopLoss);
    }

    // Generate AI update for active positions
    let aiUpdate = { action: 'HOLD', update: 'Hold per original plan.' };
    if (pos.status === 'ACTIVE') {
      const news = await getStockNews(pos.ticker, pos.ticker);
      aiUpdate = await generatePositionUpdate(
        pos.ticker,
        pos.pickType,
        pos.entryPrice,
        currentPrice,
        pos.targetPrice,
        pos.stopLoss,
        news
      );
    }

    updates.push({
      date: new Date().toISOString(),
      ticker: pos.ticker,
      currentPrice,
      entryPrice: pos.entryPrice,
      targetPrice: pos.targetPrice,
      stopLoss: pos.stopLoss,
      pnlPercent: pos.pnlPercent,
      status: pos.status === 'ACTIVE' ? 'ENTERED' : 'WATCHING',
      update: aiUpdate.update,
      action: aiUpdate.action as any,
    });
  }

  savePortfolio(positions);
  await sendDailyUpdate(updates);
  console.log(`[Portfolio] Daily check complete. ${updates.length} positions updated.`);
}

// ── Get portfolio summary ─────────────────────────────────
export function getPortfolioSummary(): { total: number; active: number; watching: number; avgPnl: number } {
  const positions = loadPortfolio();
  const active = positions.filter(p => p.status === 'ACTIVE');
  const watching = positions.filter(p => p.status === 'WATCHING');
  const avgPnl = active.length
    ? active.reduce((sum, p) => sum + p.pnlPercent, 0) / active.length
    : 0;

  return {
    total: positions.length,
    active: active.length,
    watching: watching.length,
    avgPnl,
  };
}