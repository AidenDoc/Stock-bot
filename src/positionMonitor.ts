// ============================================================
// EXIT MONITOR — resolves V2 trade-plan positions on completed bars
// ------------------------------------------------------------
// For every open V2 position, walk the COMPLETED daily bars since
// entry (partial-bar rule: the in-progress day never counts, and the
// entry day's bar is excluded — its high/low include pre-entry trade):
//   low <= SL and high >= TP on the same bar → HIT_STOP (conservative)
//   high >= TP                              → HIT_TARGET at TP
//   low  <= SL                              → HIT_STOP at SL
//   horizonDays bars elapsed, no touch      → TIME_EXIT at that close
// Walking the full window (not just yesterday) makes the monitor
// self-healing: a missed run is caught up on the next one, exiting at
// the bar where the level was actually touched.
//
// On exit: close the tracker row, write the V2 scorecard grade (which
// also closes the memory-bank record), sell the paper position at the
// same price (T+1 settlement), and send the Telegram exit alert.
// Corporate-action guards (split rescale, frozen-window, ±50% return
// safety net) all apply before any exit is recorded.
// ============================================================

import { PortfolioPosition } from './types';
import { ExitOutcome, planFor } from './tradePlan';
import {
  getDailyOHLC, getSplitAdjustment, getCloseOnOrBefore, detectFrozenWindow,
} from './marketData';
import { recordTradePlanExit } from './scorecard';
import { paperApplyExits } from './paperAccount';
import { sendExitAlert, sendGradingReviewAlert, sendStaleQuoteAlert } from './telegram';
import fs from 'fs';
import path from 'path';

const DB_FILE = path.join(process.cwd(), 'data', 'portfolio.json');

// Same safety net as the weekly grader: a computed exit beyond ±50%
// is a corporate-action artifact until a human says otherwise.
const RETURN_SAFETY_THRESHOLD_PCT = 50;

export interface ExitEvent {
  ticker: string;
  strategy?: string;
  outcome: ExitOutcome;
  entryPrice: number;
  exitPrice: number;
  exitDate: string;         // YYYY-MM-DD of the exit bar
  daysHeld: number;         // trading days
  returnPct: number;
  excessReturn?: number;    // vs SPY over the actual hold, pp
}

export interface MonitorResult {
  exits: ExitEvent[];
  stillOpen: number;
}

function loadPortfolio(): PortfolioPosition[] {
  try {
    if (!fs.existsSync(DB_FILE)) return [];
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function savePortfolio(positions: PortfolioPosition[]): void {
  const dir = path.dirname(DB_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(positions, null, 2));
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Evaluate one position against its completed forward bars ─
// Pure walk — no I/O. Returns null while the plan is still alive.
export function evaluateExit(
  tp: number, sl: number, horizonDays: number,
  bars: { date: string; high: number; low: number; close: number }[],
): { outcome: ExitOutcome; exitDate: string; exitPrice: number; daysHeld: number } | null {
  const n = Math.min(horizonDays, bars.length);
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    const hitStop = b.low <= sl;
    const hitTarget = b.high >= tp;
    if (hitStop && hitTarget) return { outcome: 'HIT_STOP', exitDate: b.date, exitPrice: sl, daysHeld: i + 1 };
    if (hitTarget) return { outcome: 'HIT_TARGET', exitDate: b.date, exitPrice: tp, daysHeld: i + 1 };
    if (hitStop) return { outcome: 'HIT_STOP', exitDate: b.date, exitPrice: sl, daysHeld: i + 1 };
  }
  if (bars.length >= horizonDays) {
    const last = bars[horizonDays - 1];
    return { outcome: 'TIME_EXIT', exitDate: last.date, exitPrice: last.close, daysHeld: horizonDays };
  }
  return null;
}

// ── Run the monitor over every open V2 position ─────────────
// `frozenTickers`: symbols whose stale-quote guard tripped on today's
// daily check — never resolve an exit off a possibly-dead feed.
// `dryRun`: evaluate and report, write nothing anywhere.
export async function runExitMonitor(
  opts: { dryRun?: boolean; frozenTickers?: Set<string> } = {},
): Promise<MonitorResult> {
  const { dryRun = false, frozenTickers = new Set<string>() } = opts;
  const positions = loadPortfolio();
  const open = positions.filter(
    p => p.status !== 'CLOSED' && p.exitRegime === 'V2_TRADE_PLAN'
  );

  console.log(`[Monitor] Checking ${open.length} open V2 position(s)${dryRun ? ' [DRY RUN]' : ''}...`);
  const result: MonitorResult = { exits: [], stillOpen: 0 };
  if (open.length === 0) return result;

  let portfolioDirty = false;

  for (const pos of open) {
    if (frozenTickers.has(pos.ticker)) {
      console.warn(`[Monitor] ${pos.ticker}: frozen-quote guard tripped today — skipping exit evaluation`);
      result.stillOpen++;
      continue;
    }

    // Corporate-action guard 1: splits. Yahoo's bars arrive in TODAY's
    // scale; stored levels may still be in the scale they were set in.
    // Same incremental rescale as the daily check (splitAdjustedThrough
    // makes it idempotent) — persisted, so entry/exit stay on one scale.
    const { ratio, events } = await getSplitAdjustment(
      pos.ticker, pos.splitAdjustedThrough || pos.addedDate
    );
    let entry = pos.entryPrice, tp = pos.targetPrice, sl = pos.stopLoss;
    if (ratio !== 1) {
      entry /= ratio; tp /= ratio; sl /= ratio;
      if (!dryRun) {
        pos.entryPrice = entry; pos.targetPrice = tp; pos.stopLoss = sl;
        pos.notes += ` [rescaled for ${events.map(e => `${e.ratioText} split on ${e.date}`).join(', ')}]`;
        pos.splitAdjustedThrough = new Date().toISOString();
        portfolioDirty = true;
      }
      console.log(`[Monitor] ${pos.ticker}: rescaled plan levels for ${events.map(e => e.ratioText).join(', ')} split`);
    }

    const entryDay = pos.addedDate.slice(0, 10);
    const allBars = await getDailyOHLC(pos.ticker, pos.addedDate);
    await sleep(400); // Yahoo politeness
    if (!allBars) {
      console.warn(`[Monitor] ${pos.ticker}: no bar data — skipping`);
      result.stillOpen++;
      continue;
    }
    // Entry-day bar excluded: its high/low include pre-entry morning trade.
    const bars = allBars.filter(b => b.date > entryDay);

    // Corporate-action guard 2: frozen window (delisting/ticker change).
    // Only meaningful once the window spans ≥2 bars — a fresh position
    // with one bar is just young, not frozen.
    if (bars.length >= 2) {
      const frozen = detectFrozenWindow(bars);
      if (frozen) {
        console.warn(`[Monitor] ${pos.ticker}: ${frozen} — skipping exit evaluation, flagged for review`);
        if (!dryRun) {
          await sendStaleQuoteAlert(
            pos.ticker,
            `Open V2 position (entered ${entryDay} at $${entry.toFixed(2)}) — exit evaluation skipped.`,
            frozen
          );
        }
        result.stillOpen++;
        continue;
      }
    }

    const horizonDays = pos.horizonDays ?? planFor(pos.strategy).horizonDays;
    const exit = evaluateExit(tp, sl, horizonDays, bars);
    if (!exit) {
      result.stillOpen++;
      console.log(`[Monitor] ${pos.ticker} [${pos.strategy || 'n/a'}]: alive — day ${bars.length}/${horizonDays}, TP $${tp.toFixed(2)} / SL $${sl.toFixed(2)}`);
      continue;
    }

    const returnPct = ((exit.exitPrice - entry) / entry) * 100;

    // Corporate-action guard 3: ±50% safety net → manual review, no auto-exit.
    if (Math.abs(returnPct) > RETURN_SAFETY_THRESHOLD_PCT) {
      console.warn(`[Monitor] ${pos.ticker}: computed exit ${returnPct.toFixed(1)}% exceeds ±${RETURN_SAFETY_THRESHOLD_PCT}% safety threshold — flagged for review, NOT auto-exited`);
      if (!dryRun) {
        await sendGradingReviewAlert(pos.ticker, pos.addedDate, entry, exit.exitPrice, returnPct, events);
      }
      result.stillOpen++;
      continue;
    }

    // Benchmark over the ACTUAL holding window.
    const spyEntryPrice = pos.spyEntryPrice
      ?? (await getCloseOnOrBefore('SPY', pos.addedDate)) ?? undefined;
    const spyExitPrice = (await getCloseOnOrBefore('SPY', exit.exitDate)) ?? undefined;
    let excessReturn: number | undefined;
    if (spyEntryPrice && spyExitPrice && spyEntryPrice > 0) {
      const spyPct = ((spyExitPrice - spyEntryPrice) / spyEntryPrice) * 100;
      excessReturn = parseFloat((returnPct - spyPct).toFixed(2));
    }

    const event: ExitEvent = {
      ticker: pos.ticker,
      strategy: pos.strategy,
      outcome: exit.outcome,
      entryPrice: entry,
      exitPrice: exit.exitPrice,
      exitDate: exit.exitDate,
      daysHeld: exit.daysHeld,
      returnPct: parseFloat(returnPct.toFixed(2)),
      excessReturn,
    };
    result.exits.push(event);
    console.log(`[Monitor] ${pos.ticker} [${pos.strategy || 'n/a'}]: ${exit.outcome} @ $${exit.exitPrice.toFixed(2)} on ${exit.exitDate} (${event.returnPct >= 0 ? '+' : ''}${event.returnPct}% in ${exit.daysHeld}d)`);

    if (dryRun) continue;

    // 1) Close the tracker row.
    pos.status = 'CLOSED';
    pos.outcome = exit.outcome;
    pos.exitDate = exit.exitDate;
    pos.exitPrice = exit.exitPrice;
    pos.currentPrice = exit.exitPrice;
    pos.pnlPercent = event.returnPct;
    pos.spyEntryPrice = spyEntryPrice;
    pos.spyExitPrice = spyExitPrice;
    pos.excessReturn = excessReturn;
    portfolioDirty = true;

    // 2) Scorecard grade (also closes the trade-memory record).
    recordTradePlanExit(pos, {
      outcome: exit.outcome,
      exitDate: exit.exitDate,
      exitPrice: exit.exitPrice,
      daysHeld: exit.daysHeld,
      spyEntryPrice,
      spyExitPrice,
    });

    // 3) Paper account sells at the same exit price (T+1 settlement).
    paperApplyExits([{
      ticker: pos.ticker,
      strategy: pos.strategy,
      exitPrice: exit.exitPrice,
      reason: exit.outcome,
    }]);

    // 4) Tell the human.
    await sendExitAlert(event);
  }

  if (!dryRun && portfolioDirty) savePortfolio(positions);
  console.log(`[Monitor] Done: ${result.exits.length} exit(s), ${result.stillOpen} still open.`);
  return result;
}
