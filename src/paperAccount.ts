// ============================================================
// PAPER ACCOUNT — simulated cash account tracking the bot's picks
// ------------------------------------------------------------
// Mirrors what real money would do if deployed to the weekly picks:
// equal-notional fractional-share buys (via positionSizing — THE
// sizing module real execution will reuse), T+1 settlement on sale
// proceeds (Robinhood cash-account behavior), daily mark-to-market,
// and exits that follow the live tracker's target/stop calls and the
// weekly grading's force-closes.
//
// Strictly a CONSUMER of picks and prices — it never feeds the
// scorecard, memory bank, or grading. Every entry point is wrapped
// so a missing/corrupt account file can never fail a scan.
// ============================================================

import fs from 'fs';
import path from 'path';
import { StockPick } from './types';
// type-only: keeps the runtime import graph acyclic
// (telegram → paperAccount, and scorecard → telegram)
import type { GradedPick } from './scorecard';
import { sizePicks, SizingPick } from './positionSizing';
import { getCloseOnOrBefore } from './marketData';
import { etNow, nextTradingDay } from './marketCalendar';

const ACCOUNT_FILE = path.join(process.cwd(), 'data', 'paper-account.json');

function startingBalance(): number {
  const v = Number(process.env.PAPER_STARTING_BALANCE);
  return Number.isFinite(v) && v > 0 ? v : 200;
}

// ── State shape (data/paper-account.json) ───────────────────
export interface PendingSettlement {
  amount: number;
  availableDate: string;     // YYYY-MM-DD — first day the cash is spendable
}

export interface PaperPosition {
  ticker: string;
  strategy: string | null;
  shares: number;            // fractional, 5 decimal places
  entryPrice: number;
  entryDate: string;         // ISO timestamp
  costBasis: number;
  targetPrice: number;
  stopLoss: number;
  // Mark-to-market bookkeeping (not part of the order itself):
  lastMark: number;          // last GOOD price seen (starts at entryPrice)
  lastMarkDate: string;      // YYYY-MM-DD of that mark
  markFrozen: boolean;       // true while the stale-quote guard is tripped
  // V2 trade-plan positions: exits come ONLY from the exit monitor
  // (completed-bar TP/SL/expiry via paperApplyExits) — the daily mark
  // never self-closes them off a live quote. Absent = legacy position.
  exitRegime?: string;
  horizonDays?: number;
  expiryDate?: string;       // YYYY-MM-DD — /paper shows days remaining
}

export interface EquityPoint {
  date: string;              // YYYY-MM-DD, one point per daily check
  equity: number;            // cash + invested (invested marked at lastMark)
  cash: number;              // ALL cash: settled + pending settlement — so
                             // cash + invested = equity always reconciles
  invested: number;
  spyClose: number | null;   // benchmark column (null if SPY fetch failed)
}

export interface ClosedTrade {
  ticker: string;
  strategy: string | null;
  shares: number;
  entryPrice: number;
  exitPrice: number;
  entryDate: string;
  exitDate: string;
  pnlDollars: number;
  pnlPct: number;
  // WEEK_CLOSE survives on legacy V1 closes; TIME_EXIT is the V2
  // horizon-expiry outcome.
  reason: 'HIT_TARGET' | 'HIT_STOP' | 'WEEK_CLOSE' | 'TIME_EXIT';
}

export interface PaperAccount {
  startingBalance: number;
  createdAt: string;
  cash: number;              // settled, spendable now
  pendingSettlement: PendingSettlement[];
  positions: PaperPosition[];
  equityHistory: EquityPoint[];
  closedTrades: ClosedTrade[];
}

// ── Load / save ─────────────────────────────────────────────
function freshAccount(): PaperAccount {
  return {
    startingBalance: startingBalance(),
    createdAt: new Date().toISOString(),
    cash: startingBalance(),
    pendingSettlement: [],
    positions: [],
    equityHistory: [],
    closedTrades: [],
  };
}

// Missing file → brand-new account (first run). Corrupt file → null:
// every lifecycle entry point then no-ops, so the bot keeps running
// and the broken file survives on disk for manual inspection instead
// of being clobbered by a fresh one.
export function loadPaperAccount(): PaperAccount | null {
  try {
    if (!fs.existsSync(ACCOUNT_FILE)) return freshAccount();
    const acct = JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf-8'));
    if (typeof acct?.cash !== 'number' || !Array.isArray(acct?.positions)) {
      console.error('[Paper] paper-account.json parsed but has the wrong shape — skipping paper ops (file left untouched)');
      return null;
    }
    return acct as PaperAccount;
  } catch (err: any) {
    console.error('[Paper] paper-account.json unreadable — skipping paper ops (file left untouched):', err?.message);
    return null;
  }
}

// Atomic tmp+rename, same pattern as current-picks.json.
export function savePaperAccount(acct: PaperAccount, filePath: string = ACCOUNT_FILE): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(acct, null, 2));
  fs.renameSync(tmp, filePath);
}

function r2(x: number): number { return Math.round(x * 100) / 100; }

// ── Settlement sweep — matured T+1 proceeds become spendable ─
export function sweepSettlements(acct: PaperAccount, today: string): number {
  let swept = 0;
  const stillPending: PendingSettlement[] = [];
  for (const p of acct.pendingSettlement) {
    if (p.availableDate <= today) swept = r2(swept + p.amount);
    else stillPending.push(p);
  }
  if (swept > 0) {
    acct.cash = r2(acct.cash + swept);
    acct.pendingSettlement = stillPending;
    console.log(`[Paper] Settled $${swept.toFixed(2)} of sale proceeds into cash`);
  }
  return swept;
}

function pendingTotal(acct: PaperAccount): number {
  return r2(acct.pendingSettlement.reduce((s, p) => s + p.amount, 0));
}

function investedValue(acct: PaperAccount): number {
  return r2(acct.positions.reduce((s, p) => s + p.shares * p.lastMark, 0));
}

export function accountEquity(acct: PaperAccount): number {
  return r2(acct.cash + pendingTotal(acct) + investedValue(acct));
}

// ── Close a position → proceeds settle T+1 ──────────────────
function closePosition(
  acct: PaperAccount, pos: PaperPosition, exitPrice: number,
  reason: ClosedTrade['reason'], today: string,
): void {
  const proceeds = r2(pos.shares * exitPrice);
  const pnlDollars = r2(proceeds - pos.costBasis);
  acct.pendingSettlement.push({ amount: proceeds, availableDate: nextTradingDay(today) });
  acct.closedTrades.push({
    ticker: pos.ticker,
    strategy: pos.strategy,
    shares: pos.shares,
    entryPrice: pos.entryPrice,
    exitPrice: r2(exitPrice),
    entryDate: pos.entryDate,
    exitDate: today,
    pnlDollars,
    pnlPct: pos.costBasis > 0 ? r2((pnlDollars / pos.costBasis) * 100) : 0,
    reason,
  });
  acct.positions = acct.positions.filter(p => p !== pos);
  console.log(`[Paper] ${reason} ${pos.ticker}: sold ${pos.shares} sh @ $${exitPrice.toFixed(2)} → $${proceeds.toFixed(2)} (P&L ${pnlDollars >= 0 ? '+' : ''}$${pnlDollars.toFixed(2)}), settles ${nextTradingDay(today)}`);
}

// ── Buy the scan's picks with settled cash ──────────────────
// Called after picks are finalized — the initial 5-slot fill and every
// rolling single-slot replacement alike. Settled cash only — pending
// T+1 proceeds are not spendable yet, exactly like a real Robinhood
// cash account. sizePicks splits the settled cash equally across the
// slots being filled this run ($5 minimum notional per position).
export function paperBuyPicks(picks: StockPick[], today: string = etNow().date): void {
  try {
    const acct = loadPaperAccount();
    if (!acct) return;
    sweepSettlements(acct, today);

    // Never double-buy a ticker+strategy the account already holds
    // (the weekly scan re-picks names that are still setting up).
    const held = new Set(acct.positions.map(p => `${p.ticker}|${p.strategy ?? ''}`));
    const candidates: SizingPick[] = [];
    const heldPicks: StockPick[] = [];
    for (const p of picks) {
      if (held.has(`${p.ticker}|${p.strategy ?? ''}`)) heldPicks.push(p);
      else candidates.push({
        ticker: p.ticker,
        entryPrice: p.currentPrice,
        confidenceScore: p.confidenceScore,
        strategy: p.strategy,
      });
    }
    for (const p of heldPicks) console.log(`[Paper] ${p.ticker} (${p.strategy ?? 'n/a'}) already held — not re-buying`);

    const byTicker = new Map(picks.map(p => [`${p.ticker}|${p.strategy ?? ''}`, p]));
    const { orders, skipped, totalCost } = sizePicks(acct.cash, candidates);
    for (const s of skipped) console.log(`[Paper] SKIP ${s.ticker}: ${s.reason}`);

    for (const o of orders) {
      const src = byTicker.get(`${o.ticker}|${o.strategy ?? ''}`)!;
      acct.positions.push({
        ticker: o.ticker,
        strategy: o.strategy ?? null,
        shares: o.shares,
        entryPrice: o.entryPrice,
        entryDate: new Date().toISOString(),
        costBasis: o.costBasis,
        targetPrice: src.targetPrice,
        stopLoss: src.stopLoss,
        lastMark: o.entryPrice,
        lastMarkDate: today,
        markFrozen: false,
        exitRegime: src.exitRegime,
        horizonDays: src.horizonDays,
        expiryDate: src.expiryDate,
      });
      console.log(`[Paper] FILL ${o.ticker}: ${o.shares} sh @ $${o.entryPrice.toFixed(2)} = $${o.costBasis.toFixed(2)}`);
    }
    acct.cash = r2(acct.cash - totalCost);
    savePaperAccount(acct);
    console.log(`[Paper] Buys done: ${orders.length} fill(s), $${totalCost.toFixed(2)} deployed, $${acct.cash.toFixed(2)} cash left`);
  } catch (err: any) {
    console.error('[Paper] buy error (scan unaffected):', err?.message);
  }
}

// ── Daily: mark to market with the tracker's prices ─────────
// `prices` is the ticker→price map the portfolio monitor already
// fetched (no extra API calls). `frozenTickers` are symbols whose
// stale-quote guard tripped: their positions keep the last good
// mark and get flagged instead of marking on a frozen price.
// Exits mirror the tracker's calls: price ≥ target → sell at the
// target price; price ≤ stop → sell at the stop price.
export async function paperDailyMark(
  prices: Record<string, number>,
  frozenTickers: Set<string>,
  opts: { today?: string; spyClose?: number | null } = {},
): Promise<void> {
  try {
    const acct = loadPaperAccount();
    if (!acct) return;
    const today = opts.today ?? etNow().date;
    sweepSettlements(acct, today);

    for (const pos of [...acct.positions]) {
      if (frozenTickers.has(pos.ticker)) {
        pos.markFrozen = true;   // dashboard flag; lastMark carries unchanged
        console.warn(`[Paper] ${pos.ticker}: frozen quote — carrying last good mark $${pos.lastMark.toFixed(2)} from ${pos.lastMarkDate}`);
        continue;
      }
      const price = prices[pos.ticker];
      if (price == null || !Number.isFinite(price) || price <= 0) continue; // no data today — carry the mark
      pos.markFrozen = false;

      // V2 trade-plan positions only MARK here — their exits come from
      // the completed-bar exit monitor (paperApplyExits), never from an
      // intraday quote, so paper stays in lockstep with the official
      // scorecard record.
      if (pos.exitRegime === 'V2_TRADE_PLAN') {
        pos.lastMark = price;
        pos.lastMarkDate = today;
      } else if (price >= pos.targetPrice) {
        closePosition(acct, pos, pos.targetPrice, 'HIT_TARGET', today);
      } else if (price <= pos.stopLoss) {
        closePosition(acct, pos, pos.stopLoss, 'HIT_STOP', today);
      } else {
        pos.lastMark = price;
        pos.lastMarkDate = today;
      }
    }

    // Benchmark column: SPY close (caller/test may inject; live path
    // reuses the same helper the scorecard benchmark uses).
    const spyClose = opts.spyClose !== undefined
      ? opts.spyClose
      : await getCloseOnOrBefore('SPY', today).catch(() => null);

    const point: EquityPoint = {
      date: today,
      equity: accountEquity(acct),
      cash: r2(acct.cash + pendingTotal(acct)),
      invested: investedValue(acct),
      spyClose: spyClose ?? null,
    };
    // One point per day — a re-run replaces today's point instead of duplicating.
    const last = acct.equityHistory[acct.equityHistory.length - 1];
    if (last && last.date === today) acct.equityHistory[acct.equityHistory.length - 1] = point;
    else acct.equityHistory.push(point);

    savePaperAccount(acct);
    console.log(`[Paper] Marked: equity $${point.equity.toFixed(2)} (cash $${point.cash.toFixed(2)} + invested $${point.invested.toFixed(2)})`);
  } catch (err: any) {
    console.error('[Paper] daily mark error (check unaffected):', err?.message);
  }
}

// ── V2 exit-monitor closes ──────────────────────────────────
// The monitor resolved these positions on completed bars (TP, SL, or
// time expiry) — sell the matching paper positions at the SAME exit
// price so paper equity tracks the official record. Proceeds settle
// T+1 as always. Consumer only: paper errors never affect the monitor.
export interface PaperExit {
  ticker: string;
  strategy?: string | null;
  exitPrice: number;
  reason: 'HIT_TARGET' | 'HIT_STOP' | 'TIME_EXIT';
}

export function paperApplyExits(exits: PaperExit[], today: string = etNow().date): void {
  try {
    if (exits.length === 0) return;
    const acct = loadPaperAccount();
    if (!acct) return;
    let closed = 0;
    for (const e of exits) {
      const pos = acct.positions.find(p =>
        p.ticker === e.ticker && (p.strategy ?? '') === (e.strategy ?? ''));
      if (!pos) continue;
      closePosition(acct, pos, e.exitPrice, e.reason, today);
      closed++;
    }
    if (closed > 0) savePaperAccount(acct);
  } catch (err: any) {
    console.error('[Paper] exit-close error (monitor unaffected):', err?.message);
  }
}

// ── Weekly grading force-closes ─────────────────────────────
// When gradePicks resolves a pick the paper account still holds,
// sell at the graded final price. (Target/stop exits normally fire
// from the daily mark first; anything left is a WEEK_CLOSE.)
export function paperApplyGrades(graded: GradedPick[], today: string = etNow().date): void {
  try {
    if (graded.length === 0) return;
    const acct = loadPaperAccount();
    if (!acct) return;
    let closed = 0;
    for (const g of graded) {
      const pos = acct.positions.find(p =>
        p.ticker === g.ticker && (p.strategy ?? '') === (g.strategy ?? ''));
      if (!pos) continue;
      closePosition(acct, pos, g.finalPrice, 'WEEK_CLOSE', today);
      closed++;
    }
    if (closed > 0) savePaperAccount(acct);
  } catch (err: any) {
    console.error('[Paper] grade-close error (grading unaffected):', err?.message);
  }
}

// ── Reset (Telegram /paperreset, after confirmation) ────────
// Archives the current file before starting fresh.
export function paperReset(): { archivedTo: string | null; newBalance: number } {
  let archivedTo: string | null = null;
  if (fs.existsSync(ACCOUNT_FILE)) {
    archivedTo = path.join(
      path.dirname(ACCOUNT_FILE),
      `paper-account.archive-${etNow().date}.json`,
    );
    fs.copyFileSync(ACCOUNT_FILE, archivedTo);
  }
  const fresh = freshAccount();
  savePaperAccount(fresh);
  console.log(`[Paper] Reset to $${fresh.startingBalance}${archivedTo ? ` (old file archived to ${archivedTo})` : ''}`);
  return { archivedTo, newBalance: fresh.startingBalance };
}

// ── Summary (Telegram /paper, weekly footer, dashboard help) ─
export interface PaperSummary {
  equity: number;
  startingBalance: number;
  returnPct: number;
  spyReturnPct: number | null;   // SPY over the same period, from equityHistory
  cash: number;                  // settled
  pending: PendingSettlement[];
  positions: {
    ticker: string; strategy: string | null; shares: number; costBasis: number;
    value: number; pnlDollars: number; pnlPct: number; markFrozen: boolean;
    // V2 plan context for /paper (absent on legacy positions):
    targetPrice: number; stopLoss: number; lastMark: number;
    expiryDate?: string; horizonDays?: number;
  }[];
  closedTrades: ClosedTrade[];
}

export function getPaperSummary(): PaperSummary | null {
  const acct = loadPaperAccount();
  if (!acct) return null;
  const equity = accountEquity(acct);
  const spyPoints = acct.equityHistory.filter(p => p.spyClose != null);
  const spyReturnPct = spyPoints.length >= 2
    ? r2(((spyPoints[spyPoints.length - 1].spyClose! - spyPoints[0].spyClose!) / spyPoints[0].spyClose!) * 100)
    : null;
  return {
    equity,
    startingBalance: acct.startingBalance,
    returnPct: acct.startingBalance > 0 ? r2(((equity - acct.startingBalance) / acct.startingBalance) * 100) : 0,
    spyReturnPct,
    cash: acct.cash,
    pending: acct.pendingSettlement,
    positions: acct.positions.map(p => {
      const value = r2(p.shares * p.lastMark);
      const pnl = r2(value - p.costBasis);
      return {
        ticker: p.ticker, strategy: p.strategy, shares: p.shares,
        costBasis: p.costBasis, value, pnlDollars: pnl,
        pnlPct: p.costBasis > 0 ? r2((pnl / p.costBasis) * 100) : 0,
        markFrozen: p.markFrozen,
        targetPrice: p.targetPrice, stopLoss: p.stopLoss, lastMark: p.lastMark,
        expiryDate: p.expiryDate, horizonDays: p.horizonDays,
      };
    }),
    closedTrades: acct.closedTrades,
  };
}
