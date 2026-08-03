// ============================================================
// RETROACTIVE HORIZON RE-SCORE — validates the trade-plan premise
// Run with: npm run rescore
// ------------------------------------------------------------
// Replays every historical pick at 5 / 10 / 15 / 20 trading-day
// horizons against real daily OHLC, with the pick's ORIGINAL
// TP/SL levels (or a stated +8%/−4% default when none recorded).
// Exit rules per completed daily bar, in order:
//   low <= SL AND high >= TP on the same bar → STOP hit first
//     (conservative — we never assume the target filled)
//   high >= TP → HIT_TARGET at TP
//   low  <= SL → HIT_STOP at SL
//   horizon reached with neither touched → TIME_EXIT at close
// Answers: do longer horizons raise the TP-hit rate, or just
// give losers more time to find the stop?
// ============================================================

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import {
  getDailyOHLC, DailyOHLCBar, getSplitAdjustment, detectFrozenWindow,
} from './marketData';
import { GradedPick } from './scorecard';
import { PortfolioPosition } from './types';

const HORIZONS = [5, 10, 15, 20];

// Stated defaults for picks with no usable recorded TP/SL.
const DEFAULT_TP_PCT = 8;
const DEFAULT_SL_PCT = 4;

// Same safety net as scorecard.ts: a simulated move beyond ±50% is a
// corporate-action artifact or bad data, not a trade — exclude it.
const RETURN_SAFETY_THRESHOLD_PCT = 50;

const SCORECARD_FILE = path.join(process.cwd(), 'data', 'scorecard.json');
const PORTFOLIO_FILE = path.join(process.cwd(), 'data', 'portfolio.json');

interface HistoricalPick {
  ticker: string;
  strategy: string;          // 'PULLBACK' | 'BREAKOUT' | 'LEGACY' (pre-redesign, no tag)
  entryDate: string;         // YYYY-MM-DD
  entry: number;
  tp: number;
  sl: number;
  levelsSource: 'recorded' | 'default';
  source: 'scorecard' | 'portfolio';
}

interface SimResult {
  pick: HistoricalPick;
  outcome: 'HIT_TARGET' | 'HIT_STOP' | 'TIME_EXIT';
  exitDate: string;
  returnPct: number;
  excessPct: number | null;
}

function loadJSON<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}

function day(iso: string): string { return (iso || '').slice(0, 10); }

// ── Collect historical picks ────────────────────────────────
// Preferred source: closed scorecard grades (real resolved picks).
// Fallback: the portfolio pick log — every pick has recorded
// entry/TP/SL even if grading hasn't resolved it yet. Both are
// deduped on ticker+entry day.
function collectPicks(): { picks: HistoricalPick[]; source: string } {
  const seen = new Set<string>();
  const out: HistoricalPick[] = [];

  const graded = loadJSON<{ graded: GradedPick[] }>(SCORECARD_FILE, { graded: [] }).graded
    .filter(g => g.outcome !== 'OPEN' && g.invalid !== true);
  for (const g of graded) {
    const key = `${g.ticker}_${day(g.pickedDate)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const levelsOk = g.targetPrice > g.entryPrice && g.stopLoss > 0 && g.stopLoss < g.entryPrice;
    out.push({
      ticker: g.ticker,
      strategy: g.strategy ?? 'LEGACY',
      entryDate: day(g.pickedDate),
      entry: g.entryPrice,
      tp: levelsOk ? g.targetPrice : g.entryPrice * (1 + DEFAULT_TP_PCT / 100),
      sl: levelsOk ? g.stopLoss : g.entryPrice * (1 - DEFAULT_SL_PCT / 100),
      levelsSource: levelsOk ? 'recorded' : 'default',
      source: 'scorecard',
    });
  }
  if (out.length > 0) return { picks: out, source: 'scorecard (closed grades)' };

  // No graded history on this machine — replay the raw pick log instead.
  const positions = loadJSON<PortfolioPosition[]>(PORTFOLIO_FILE, []);
  for (const p of positions) {
    const key = `${p.ticker}_${day(p.addedDate)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const levelsOk = p.targetPrice > p.entryPrice && p.stopLoss > 0 && p.stopLoss < p.entryPrice;
    out.push({
      ticker: p.ticker,
      strategy: p.strategy ?? 'LEGACY',
      entryDate: day(p.addedDate),
      entry: p.entryPrice,
      tp: levelsOk ? p.targetPrice : p.entryPrice * (1 + DEFAULT_TP_PCT / 100),
      sl: levelsOk ? p.stopLoss : p.entryPrice * (1 - DEFAULT_SL_PCT / 100),
      levelsSource: levelsOk ? 'recorded' : 'default',
      source: 'portfolio',
    });
  }
  return { picks: out, source: 'portfolio pick log (no closed grades found)' };
}

// ── Simulate one pick at one horizon ────────────────────────
// `bars` are completed daily bars strictly AFTER the entry date,
// already in the same (split-adjusted) scale as entry/tp/sl.
function simulate(
  pick: HistoricalPick, bars: DailyOHLCBar[], horizon: number,
): { outcome: SimResult['outcome']; exitDate: string; exitPrice: number } | null {
  const n = Math.min(horizon, bars.length);
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    const hitStop = b.low <= pick.sl;
    const hitTarget = b.high >= pick.tp;
    if (hitStop && hitTarget) return { outcome: 'HIT_STOP', exitDate: b.date, exitPrice: pick.sl };
    if (hitTarget) return { outcome: 'HIT_TARGET', exitDate: b.date, exitPrice: pick.tp };
    if (hitStop) return { outcome: 'HIT_STOP', exitDate: b.date, exitPrice: pick.sl };
  }
  if (bars.length < horizon) return null; // window not fully played out yet — no honest TIME_EXIT
  const last = bars[horizon - 1];
  return { outcome: 'TIME_EXIT', exitDate: last.date, exitPrice: last.close };
}

// SPY close on or before a date, from a pre-fetched bar series.
function spyCloseOnOrBefore(spyBars: DailyOHLCBar[], date: string): number | null {
  let best: number | null = null;
  for (const b of spyBars) {
    if (b.date <= date) best = b.close;
    else break;
  }
  return best;
}

// ── Stats helpers ───────────────────────────────────────────
function pct(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(0)}%` : '—';
}

function avg(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function fmtAvg(xs: number[]): string {
  const a = avg(xs);
  return a == null ? '—' : `${a >= 0 ? '+' : ''}${a.toFixed(2)}%`;
}

function summarize(label: string, results: SimResult[]): string {
  const n = results.length;
  const tp = results.filter(r => r.outcome === 'HIT_TARGET').length;
  const sl = results.filter(r => r.outcome === 'HIT_STOP').length;
  const te = results.filter(r => r.outcome === 'TIME_EXIT').length;
  const rets = results.map(r => r.returnPct);
  const excess = results.filter(r => r.excessPct != null).map(r => r.excessPct as number);
  const warn = n > 0 && n < 10 ? ' ⚠️ N<10' : '';
  return [
    label.padEnd(22),
    `N=${String(n).padStart(3)}`,
    `TP ${pct(tp, n).padStart(4)}`,
    `SL ${pct(sl, n).padStart(4)}`,
    `TIME ${pct(te, n).padStart(4)}`,
    `avg ${fmtAvg(rets).padStart(7)}`,
    `vs SPY ${fmtAvg(excess).padStart(7)}`,
  ].join('  ') + warn;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Main ────────────────────────────────────────────────────
async function main(): Promise<void> {
  const { picks, source } = collectPicks();
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  RETROACTIVE HORIZON RE-SCORE (5 / 10 / 15 / 20 trading days)');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`Pick source: ${source}`);
  console.log(`Picks loaded: ${picks.length}`);

  if (picks.length === 0) {
    console.log('Nothing to re-score — no historical picks found in data/.');
    return;
  }

  const recorded = picks.filter(p => p.levelsSource === 'recorded').length;
  const defaulted = picks.length - recorded;
  console.log(`TP/SL levels: ${recorded} recorded on the pick, ${defaulted} using the +${DEFAULT_TP_PCT}%/−${DEFAULT_SL_PCT}% default`);

  const tagged = picks.filter(p => p.strategy !== 'LEGACY').length;
  if (tagged === 0) {
    console.log('⚠️ No strategy-tagged (post-redesign) picks in this data set — every pick below is pre-redesign LEGACY.');
  } else if (tagged < picks.length) {
    console.log(`${picks.length - tagged} pre-redesign picks included, labeled LEGACY in the per-strategy breakdown.`);
  }

  // SPY benchmark series, fetched once from the earliest entry.
  const earliest = picks.map(p => p.entryDate).sort()[0];
  const spyFrom = new Date(new Date(`${earliest}T00:00:00Z`).getTime() - 10 * 86400000).toISOString();
  const spyBars = (await getDailyOHLC('SPY', spyFrom)) ?? [];
  if (spyBars.length === 0) console.warn('⚠️ SPY bars unavailable — excess-return column will be empty.');

  // One bar fetch per ticker, from its earliest entry date.
  const earliestByTicker = new Map<string, string>();
  for (const p of picks) {
    const cur = earliestByTicker.get(p.ticker);
    if (!cur || p.entryDate < cur) earliestByTicker.set(p.ticker, p.entryDate);
  }
  const barsByTicker = new Map<string, DailyOHLCBar[] | null>();
  for (const [ticker, from] of earliestByTicker) {
    barsByTicker.set(ticker, await getDailyOHLC(ticker, `${from}T00:00:00Z`));
    await sleep(500); // Yahoo politeness
  }

  const byHorizon = new Map<number, SimResult[]>(HORIZONS.map(h => [h, []]));
  const skipped: string[] = [];
  const incompleteByHorizon = new Map<number, number>(HORIZONS.map(h => [h, 0]));

  for (const pick of picks) {
    const allBars = barsByTicker.get(pick.ticker);
    if (!allBars || allBars.length === 0) {
      skipped.push(`${pick.ticker} (${pick.entryDate}): no daily bars returned`);
      continue;
    }

    // Corporate-action guard 1: frozen window (delisting / ticker change —
    // the LC → HAPN pattern). Same detector the scorecard uses.
    const window = allBars.filter(b => b.date >= pick.entryDate);
    const frozen = detectFrozenWindow(window);
    if (frozen) {
      skipped.push(`${pick.ticker} (${pick.entryDate}): ${frozen}`);
      continue;
    }

    // Corporate-action guard 2: splits. Yahoo's series is retroactively
    // adjusted to TODAY's scale, while the stored entry/TP/SL are in the
    // scale of the entry date — bring the levels into the bars' scale.
    const { ratio } = await getSplitAdjustment(pick.ticker, `${pick.entryDate}T00:00:00Z`);
    const adj = { ...pick, entry: pick.entry / ratio, tp: pick.tp / ratio, sl: pick.sl / ratio };
    await sleep(300);

    // Bars strictly AFTER the entry date: the entry-day bar's high/low
    // include pre-entry morning trade, so it never counts (same rule as
    // the backtester's gradeForward).
    const fwd = allBars.filter(b => b.date > pick.entryDate);

    for (const h of HORIZONS) {
      const sim = simulate(adj, fwd, h);
      if (!sim) {
        incompleteByHorizon.set(h, (incompleteByHorizon.get(h) ?? 0) + 1);
        continue;
      }
      const returnPct = ((sim.exitPrice - adj.entry) / adj.entry) * 100;
      if (Math.abs(returnPct) > RETURN_SAFETY_THRESHOLD_PCT) {
        skipped.push(`${pick.ticker} (${pick.entryDate}, ${h}d): simulated ${returnPct.toFixed(1)}% exceeds ±${RETURN_SAFETY_THRESHOLD_PCT}% guard`);
        continue;
      }
      let excessPct: number | null = null;
      const s0 = spyCloseOnOrBefore(spyBars, pick.entryDate);
      const s1 = spyCloseOnOrBefore(spyBars, sim.exitDate);
      if (s0 != null && s1 != null && s0 > 0) {
        excessPct = returnPct - ((s1 - s0) / s0) * 100;
      }
      byHorizon.get(h)!.push({ pick, outcome: sim.outcome, exitDate: sim.exitDate, returnPct, excessPct });
    }
  }

  // ── Report ────────────────────────────────────────────────
  console.log('\nRESULTS BY HORIZON');
  console.log('──────────────────────────────────────────────────────────────');
  for (const h of HORIZONS) {
    const results = byHorizon.get(h)!;
    console.log(summarize(`${h} trading days`, results));
    const strategies = [...new Set(results.map(r => r.pick.strategy))].sort();
    for (const s of strategies) {
      console.log('  ' + summarize(`  ${s}`, results.filter(r => r.pick.strategy === s)));
    }
    const inc = incompleteByHorizon.get(h) ?? 0;
    if (inc > 0) console.log(`    (${inc} pick(s) excluded: forward window shorter than ${h} days and no level touched)`);
  }

  const anySmall = HORIZONS.some(h => {
    const rs = byHorizon.get(h)!;
    const strategies = [...new Set(rs.map(r => r.pick.strategy))];
    return rs.length < 10 || strategies.some(s => rs.filter(r => r.pick.strategy === s).length < 10);
  });
  if (anySmall) {
    console.log('\n⚠️ SAMPLE-SIZE WARNING: at least one cell above has N < 10.');
    console.log('   Cells that small are statistical noise — a coin flip produces');
    console.log('   rates like these by chance. Directional hints only; do not');
    console.log('   tune TP/SL/horizon numbers off them.');
  }

  if (skipped.length) {
    console.log(`\nSKIPPED (${skipped.length}) — corporate-action guards / missing data:`);
    for (const s of skipped) console.log(`  • ${s}`);
  }
  console.log('══════════════════════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('[Rescore] Fatal:', err);
  process.exit(1);
});
