// ============================================================
// BACKTEST — replay engine (Phase 1, Step 2)
// ------------------------------------------------------------
// Reconstructs each ticker's quote + technicals at a historical
// cutoff date using ONLY bars dated on-or-before that date, then
// runs the EXACT same scoreBreakout / scorePullback logic the live
// scanner uses (imported, not reimplemented).
//
// The one rule that matters: no bar after the cutoff ever touches
// a signal. Enforced two ways —
//   1) by construction: the bar arrays are physically sliced at the
//      cutoff (pointInTimeView) before scoring ever sees them, so a
//      future bar does not exist in the data handed to the strategy.
//   2) by assertion: assertNoLookahead() throws if the view contains
//      any date later than the cutoff.
//
// No grading here — that's Step 3 (wire into evaluation.ts).
// Runs standalone (Yahoo only, no API key, no Telegram).
// ============================================================

import 'dotenv/config';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { StockQuote } from './types';
import { computeTechnicals, getCandidateTickers, getQuote, selectStrike, tieredIV } from './marketData';
import { blackScholes } from 'black-scholes';
import { scoreBreakout, scorePullback, ScoredCandidate, MarketRow } from './scanner';
import { GradedPick } from './scorecard';
import { runEvaluation } from './evaluation';
import {
  technicalVerdict, regimeVerdict, combine, saveCache,
  TechnicalView, RegimeView, AgentVerdict,
} from './agents';

const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  'Accept': 'application/json',
};

// Need ~200 bars of warm-up before SMA200 is computable.
const WARMUP_BARS = 200;

// ── Full OHLCV daily history, oldest→newest ────────────────
export interface Bars {
  ticker: string;
  dates: string[];   // yyyy-mm-dd
  opens: number[];
  highs: number[];
  lows: number[];
  closes: number[];
  volumes: number[];
}

// Current-snapshot fundamentals, held constant across the replay.
// beta/sector are slow-moving, so this is a small, defensible
// approximation (the chosen Phase-1 trade-off).
export interface Fundamentals {
  name: string;
  beta: number | null;
  sector: string;
  marketCap: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Fetch ~2y of daily OHLCV from Yahoo's free chart endpoint ──
export async function fetchBars(ticker: string): Promise<Bars | null> {
  try {
    const period2 = Math.floor(Date.now() / 1000);
    const period1 = period2 - 2 * 365 * 24 * 60 * 60; // 2 years
    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
      `?period1=${period1}&period2=${period2}&interval=1d`;
    const res = await axios.get(url, { headers: YF_HEADERS, timeout: 15000 });

    const result = res.data?.chart?.result?.[0];
    if (!result) return null;

    const ts: number[] = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    const rc: (number | null)[] = q.close || [];
    const ro: (number | null)[] = q.open || [];
    const rh: (number | null)[] = q.high || [];
    const rl: (number | null)[] = q.low || [];
    const rv: (number | null)[] = q.volume || [];

    const bars: Bars = { ticker, dates: [], opens: [], highs: [], lows: [], closes: [], volumes: [] };
    for (let i = 0; i < ts.length; i++) {
      const c = rc[i];
      if (c == null) continue; // skip gaps/holidays — anchor on close
      bars.dates.push(new Date(ts[i] * 1000).toISOString().split('T')[0]);
      bars.closes.push(parseFloat(c.toFixed(2)));
      bars.opens.push(ro[i] != null ? parseFloat((ro[i] as number).toFixed(2)) : c);
      bars.highs.push(rh[i] != null ? parseFloat((rh[i] as number).toFixed(2)) : c);
      bars.lows.push(rl[i] != null ? parseFloat((rl[i] as number).toFixed(2)) : c);
      bars.volumes.push(rv[i] != null ? (rv[i] as number) : 0);
    }

    return bars.closes.length > WARMUP_BARS ? bars : null;
  } catch (err: any) {
    console.error(`[Backtest] ${ticker} bars error:`, err?.message);
    return null;
  }
}

// ── Current-snapshot fundamentals (reuses live getQuote) ────
export async function fetchFundamentals(ticker: string): Promise<Fundamentals | null> {
  const quote = await getQuote(ticker);
  if (!quote) return null;
  return {
    name: quote.name,
    beta: quote.beta,
    sector: quote.sector,
    marketCap: quote.marketCap,
  };
}

// ════════════════════════════════════════════════════════════
// ON-DISK BARS + FUNDAMENTALS CACHE
// ------------------------------------------------------------
// Mirrors the agent-verdict cache (data/agent_cache.json): a sweep
// downloads each ticker's ~2y history + fundamentals ONCE, writes them to
// data/bars_cache.json, and every later run replays from disk instead of
// re-hitting Yahoo for the whole universe.
//
// Keyed by ticker with a fetch timestamp. Backtest cutoffs are historical
// (every graded pick has a full HORIZON behind the series end), so bars
// captured today faithfully serve any past cutoff — a stale-by-a-day cache
// is harmless. The TTL only forces an eventual refresh for live-ish use;
// override with BARS_TTL_HOURS (0 = never expire).
// ════════════════════════════════════════════════════════════
const BARS_CACHE_FILE = path.join(process.cwd(), 'data', 'bars_cache.json');
const BARS_TTL_MS = (() => {
  const h = Number(process.env.BARS_TTL_HOURS ?? 24);
  return h <= 0 ? Infinity : h * 60 * 60 * 1000;
})();

interface TickerData { bars: Bars; fund: Fundamentals; }
interface CacheEntry extends TickerData { fetchedAt: number; }
type BarsDiskCache = Record<string, CacheEntry>;

let barsDisk: BarsDiskCache | null = null;
let barsDirty = 0;

function loadBarsDisk(): BarsDiskCache {
  if (barsDisk) return barsDisk;
  try {
    barsDisk = JSON.parse(fs.readFileSync(BARS_CACHE_FILE, 'utf-8'));
  } catch {
    barsDisk = {};
  }
  return barsDisk!;
}

export function saveBarsDisk(): void {
  if (!barsDisk) return;
  const dir = path.dirname(BARS_CACHE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(BARS_CACHE_FILE, JSON.stringify(barsDisk)); // compact: the file is large
  barsDirty = 0;
}

// Cached bars+fundamentals loader. On a fresh hit (within TTL) returns the
// disk copy with NO network call; on a miss/stale entry fetches both from
// Yahoo and records them. `hit` lets the caller pace only real downloads.
export async function loadTickerData(
  ticker: string,
): Promise<{ data: TickerData | null; hit: boolean }> {
  const c = loadBarsDisk();
  const entry = c[ticker];
  if (entry && Date.now() - entry.fetchedAt < BARS_TTL_MS) {
    return { data: { bars: entry.bars, fund: entry.fund }, hit: true };
  }

  const bars = await fetchBars(ticker);
  if (!bars) return { data: null, hit: false };
  const fund = await fetchFundamentals(ticker);
  if (!fund) return { data: null, hit: false };

  c[ticker] = { bars, fund, fetchedAt: Date.now() };
  if (++barsDirty >= 10) saveBarsDisk(); // crash-safe periodic flush
  return { data: { bars, fund }, hit: false };
}

// ── Index of the last bar dated on-or-before `cutoff` ──────
// Returns -1 if the cutoff predates all data.
export function indexAtOrBefore(bars: Bars, cutoff: string): number {
  let idx = -1;
  for (let i = 0; i < bars.dates.length; i++) {
    if (bars.dates[i] <= cutoff) idx = i;
    else break; // dates are sorted ascending
  }
  return idx;
}

// ── Physically truncate the series at the cutoff index ─────
// The strategy code only ever receives this sliced copy, so a
// future bar cannot leak into a signal.
export function pointInTimeView(bars: Bars, idx: number): Bars {
  const end = idx + 1;
  return {
    ticker: bars.ticker,
    dates: bars.dates.slice(0, end),
    opens: bars.opens.slice(0, end),
    highs: bars.highs.slice(0, end),
    lows: bars.lows.slice(0, end),
    closes: bars.closes.slice(0, end),
    volumes: bars.volumes.slice(0, end),
  };
}

// ── The assertion: nothing after the cutoff is visible ─────
export function assertNoLookahead(view: Bars, cutoff: string): void {
  const last = view.dates[view.dates.length - 1];
  if (last > cutoff) {
    throw new Error(
      `[Backtest] LOOKAHEAD VIOLATION on ${view.ticker}: view ends ${last} > cutoff ${cutoff}`
    );
  }
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

// ── Reconstruct a point-in-time StockQuote from the view ───
export function replayQuote(view: Bars, fund: Fundamentals): StockQuote {
  const n = view.closes.length;
  const price = view.closes[n - 1];
  const prevClose = n > 1 ? view.closes[n - 2] : price;
  const change = price - prevClose;
  const changePercent = prevClose !== 0 ? (change / prevClose) * 100 : 0;

  const last252High = view.highs.slice(-252);
  const last252Low = view.lows.slice(-252);

  return {
    ticker: view.ticker.toUpperCase(),
    name: fund.name,
    price,
    change,
    changePercent,
    volume: view.volumes[n - 1],
    avgVolume: Math.round(mean(view.volumes.slice(-30))),
    marketCap: fund.marketCap,
    pe: null,
    week52High: Math.max(...last252High),
    week52Low: Math.min(...last252Low),
    beta: fund.beta,
    sector: fund.sector,
  };
}

// ── Build one scored row for a ticker at the cutoff ────────
// Returns both strategy scores (either may be null = filtered out).
export function replayRow(
  bars: Bars,
  fund: Fundamentals,
  cutoff: string,
): { breakout: ScoredCandidate | null; pullback: ScoredCandidate | null } | null {
  const idx = indexAtOrBefore(bars, cutoff);
  if (idx < WARMUP_BARS) return null; // not enough warm-up to trust SMA200

  const view = pointInTimeView(bars, idx);
  assertNoLookahead(view, cutoff);

  const quote = replayQuote(view, fund);
  const technicals = computeTechnicals(view.ticker, view.closes, quote.price);
  const row: MarketRow = { quote, technicals };

  return { breakout: scoreBreakout(row), pullback: scorePullback(row) };
}

// ── replayScanner(date) — the Phase-1 Step-2 deliverable ───
// Mirrors the live scanner's Pass 2: score every ticker under both
// strategies at the given cutoff date and return the qualifying
// candidates (score >= 25), exactly as the live scanner gates them.
export function replayScanner(
  date: string,
  barsCache: Map<string, Bars>,
  fundCache: Map<string, Fundamentals>,
): { breakout: ScoredCandidate[]; pullback: ScoredCandidate[] } {
  const breakout: ScoredCandidate[] = [];
  const pullback: ScoredCandidate[] = [];

  for (const [ticker, bars] of barsCache) {
    const fund = fundCache.get(ticker);
    if (!fund) continue;
    const scored = replayRow(bars, fund, date);
    if (!scored) continue;
    if (scored.breakout && scored.breakout.score >= 25) breakout.push(scored.breakout);
    if (scored.pullback && scored.pullback.score >= 25) pullback.push(scored.pullback);
  }

  breakout.sort((a, b) => b.score - a.score);
  pullback.sort((a, b) => b.score - a.score);
  return { breakout, pullback };
}

// ════════════════════════════════════════════════════════════
// STEP 3 — forward-grade the replayed signals
// ════════════════════════════════════════════════════════════

const HORIZON = 20;       // trading days to let a pick run
const CADENCE = 5;        // scan every 5 trading days (≈ weekly, mirrors live)
const TOP_K = 4;          // top-scoring picks per strategy per scan date

export type ExitMode = 'atr' | 'fixed';

// ── Wilder ATR(14) from bars ≤ cutoff (no lookahead) ───────
export function atr14(view: Bars, period = 14): number | null {
  const n = view.closes.length;
  if (n < period + 1) return null;
  const tr: number[] = [];
  for (let i = 1; i < n; i++) {
    const h = view.highs[i], l = view.lows[i], pc = view.closes[i - 1];
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  // Wilder smoothing
  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
  }
  return atr;
}

// ── Exit levels for an entry, per mode ─────────────────────
// ATR:   target = entry + 2.5×ATR, stop = entry − 1.5×ATR
// fixed: target = entry +10%,      stop = entry −7%
export function exitLevels(
  entry: number, view: Bars, mode: ExitMode,
): { target: number; stop: number; atr: number | null } | null {
  if (mode === 'fixed') {
    return { target: entry * 1.10, stop: entry * 0.93, atr: null };
  }
  const atr = atr14(view);
  if (atr == null || atr <= 0) return null; // can't size an ATR exit — skip the signal
  return { target: entry + 2.5 * atr, stop: entry - 1.5 * atr, atr };
}

function pct(price: number, entry: number): number {
  return ((price - entry) / entry) * 100;
}

export interface GradeResult {
  outcome: 'WIN' | 'LOSS';
  finalPrice: number;
  stockReturnPct: number;
  ambiguous: boolean;       // same-bar target+stop hit (graded LOSS, pessimistic)
  exitReason: string;
  exitDate: string;
}

// ── Walk forward up to HORIZON bars and grade ──────────────
// Same-bar target AND stop → LOSS (stop wins ties; we do NOT assume the
// target filled) and the bar is flagged ambiguous. Target-only → WIN,
// stop-only → LOSS, neither within horizon → final close vs entry.
export function gradeForward(
  bars: Bars, entryIdx: number, entry: number, target: number, stop: number,
): GradeResult {
  const lastIdx = Math.min(entryIdx + HORIZON, bars.dates.length - 1);

  for (let i = entryIdx + 1; i <= lastIdx; i++) {
    const hitTarget = bars.highs[i] >= target;
    const hitStop = bars.lows[i] <= stop;

    if (hitTarget && hitStop) {
      return {
        outcome: 'LOSS', finalPrice: stop, stockReturnPct: pct(stop, entry),
        ambiguous: true, exitReason: 'same-bar target+stop → LOSS (pessimistic)',
        exitDate: bars.dates[i],
      };
    }
    if (hitTarget) {
      return {
        outcome: 'WIN', finalPrice: target, stockReturnPct: pct(target, entry),
        ambiguous: false, exitReason: 'target hit', exitDate: bars.dates[i],
      };
    }
    if (hitStop) {
      return {
        outcome: 'LOSS', finalPrice: stop, stockReturnPct: pct(stop, entry),
        ambiguous: false, exitReason: 'stop hit', exitDate: bars.dates[i],
      };
    }
  }

  // Neither level touched within the horizon → grade by final close.
  const fc = bars.closes[lastIdx];
  const outcome: 'WIN' | 'LOSS' = fc >= entry ? 'WIN' : 'LOSS';
  return {
    outcome, finalPrice: fc, stockReturnPct: pct(fc, entry),
    ambiguous: false, exitReason: `horizon close (${outcome})`, exitDate: bars.dates[lastIdx],
  };
}

function r2(x: number): number { return parseFloat(x.toFixed(2)); }

// ════════════════════════════════════════════════════════════
// OPTIONS-P&L GRADING ARM  (sits beside the stock-drift grade)
// ------------------------------------------------------------
// Grades each long signal as the CALL the live bot would actually buy,
// instead of on raw stock drift. Strike + IV come from the SAME model the
// live quote uses (selectStrike / tieredIV in marketData.ts); pricing is
// Black-Scholes throughout, so all three option-specific forces are modeled:
//
//   • Theta — the contract is repriced with the days-to-expiry remaining at
//     the actual exit (calendar days elapsed over the hold), so value decays.
//   • Delta — BS captures delta×(stock move), not the full move.
//   • IV    — the modeled IV reprices the contract as the underlying moves
//     toward/through the strike.
//
// THE KEY CORRECTION: the exit point is the SAME one the stock grade produced
// (g.finalPrice = underlying at exit, g.exitDate = exit date). When the −1.5×ATR
// stop is hit, the contract exits at its residual BS value at that price/date —
// NOT a flat −100%. The flat-wipeout assumption understates a stop-managed book.
// Entry premium is the BS value at entry (tiered IV), so entry and exit share
// one pricing model — no spurious day-0 mark.
// ════════════════════════════════════════════════════════════
const RISK_FREE_RATE = 0.04;   // flat short rate for BS; ~negligible over a 4-week hold
const OPTION_DAYS = 28;        // ~4 weeks to expiry — matches estimateOptionsData & ≈ HORIZON

// BS call value; at/after expiry (daysToExpiry ≤ 0) only intrinsic remains.
function bsCallValue(S: number, K: number, daysToExpiry: number, iv: number): number {
  if (daysToExpiry <= 0) return Math.max(S - K, 0);
  return blackScholes(S, K, daysToExpiry / 365, iv, RISK_FREE_RATE, 'call');
}

function calendarDaysBetween(d1: string, d2: string): number {
  return Math.round((Date.parse(d2) - Date.parse(d1)) / 86_400_000);
}

export interface OptionGrade {
  entryPremium: number;
  exitValue: number;
  optReturnPct: number;
  optOutcome: 'WIN' | 'LOSS';
}

// Reprice the call on the exact exit the stock grade resolved to. No re-walk:
// g.finalPrice is the underlying at exit in every branch (target, stop, same-bar
// → stop, or horizon close), and g.exitDate is the exit date — so the option
// exits at the same level, same day, with theta over the days actually held.
export function gradeOption(entryDate: string, entryStock: number, g: GradeResult): OptionGrade {
  const strike = selectStrike(entryStock);
  const iv = tieredIV(entryStock);
  const entryPremium = bsCallValue(entryStock, strike, OPTION_DAYS, iv);
  const daysLeft = OPTION_DAYS - calendarDaysBetween(entryDate, g.exitDate);
  const exitValue = bsCallValue(g.finalPrice, strike, daysLeft, iv);
  const optReturnPct = entryPremium > 0 ? ((exitValue - entryPremium) / entryPremium) * 100 : 0;
  return { entryPremium, exitValue, optReturnPct, optOutcome: optReturnPct >= 0 ? 'WIN' : 'LOSS' };
}

// One graded record from a candidate + its forward grade.
// Shared by the Phase 1 mechanical run and the Phase 2 agent run so
// both produce byte-identical GradedPick shapes. The stock-drift grade is
// untouched; the options arm is attached alongside it.
function buildGraded(
  cand: ScoredCandidate, date: string, entry: number, target: number, stop: number, g: GradeResult,
): GradedPick {
  const opt = gradeOption(date, entry, g);
  return {
    ticker: cand.quote.ticker,
    pickType: 'STOCK_LONG',
    strategy: cand.strategy,
    entryPrice: r2(entry),
    targetPrice: r2(target),
    stopLoss: r2(stop),
    finalPrice: r2(g.finalPrice),
    pickedDate: date,
    gradedDate: g.exitDate,
    outcome: g.outcome,
    stockReturnPct: r2(g.stockReturnPct),
    note: g.exitReason,
    optReturnPct: r2(opt.optReturnPct),
    optOutcome: opt.optOutcome,
  };
}

// ── Generate + grade picks across the whole usable window ──
export interface BacktestRun {
  graded: GradedPick[];
  ambiguousCount: number;
  scanDates: number;
  mode: ExitMode;
}

export function runBacktest(
  barsCache: Map<string, Bars>,
  fundCache: Map<string, Fundamentals>,
  mode: ExitMode,
): BacktestRun {
  // Master calendar = the most complete ticker's dates.
  const calendar = [...barsCache.values()].sort((a, b) => b.dates.length - a.dates.length)[0]?.dates ?? [];
  const graded: GradedPick[] = [];
  let ambiguousCount = 0;
  let scanDates = 0;

  // Entries need WARMUP behind them and a full HORIZON ahead, so every
  // graded pick gets a complete 20-day forward window (no half-baked tails).
  const lastEntryIdx = calendar.length - 1 - HORIZON;
  for (let di = WARMUP_BARS; di <= lastEntryIdx; di += CADENCE) {
    const date = calendar[di];
    scanDates++;
    const { breakout, pullback } = replayScanner(date, barsCache, fundCache);

    for (const cand of [...breakout.slice(0, TOP_K), ...pullback.slice(0, TOP_K)]) {
      const bars = barsCache.get(cand.quote.ticker)!;
      const entryIdx = indexAtOrBefore(bars, date);
      if (entryIdx < WARMUP_BARS || entryIdx + HORIZON > bars.dates.length - 1) continue;

      const entry = bars.closes[entryIdx];
      const view = pointInTimeView(bars, entryIdx);
      assertNoLookahead(view, date); // exit sizing uses only bars ≤ cutoff
      const levels = exitLevels(entry, view, mode);
      if (!levels) continue;

      const g = gradeForward(bars, entryIdx, entry, levels.target, levels.stop);
      if (g.ambiguous) ambiguousCount++;
      graded.push(buildGraded(cand, date, entry, levels.target, levels.stop, g));
    }
  }

  return { graded, ambiguousCount, scanDates, mode };
}

// ── Compact per-strategy summary (exactly the asked-for numbers) ──
function maxLosingStreakByDate(picks: GradedPick[]): number {
  const sorted = [...picks].sort((a, b) => a.pickedDate.localeCompare(b.pickedDate));
  let max = 0, cur = 0;
  for (const p of sorted) {
    if (p.outcome === 'LOSS') { cur++; max = Math.max(max, cur); }
    else cur = 0;
  }
  return max;
}

function summarize(picks: GradedPick[]) {
  const n = picks.length;
  const wins = picks.filter(p => p.outcome === 'WIN');
  const losses = picks.filter(p => p.outcome === 'LOSS');
  const avg = n ? picks.reduce((s, p) => s + p.stockReturnPct, 0) / n : 0;
  const avgWin = wins.length ? wins.reduce((s, p) => s + p.stockReturnPct, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, p) => s + p.stockReturnPct, 0) / losses.length : 0;
  return {
    n, wins: wins.length, losses: losses.length,
    winRate: n ? (wins.length / n) * 100 : 0,
    expectancy: avg, avgWin, avgLoss,
    streak: maxLosingStreakByDate(picks),
    ambiguous: picks.filter(p => p.note.startsWith('same-bar')).length,
  };
}

// Worst losing streak by the OPTIONS outcome (a stop-managed call can lose
// even when the stock drifted up, via theta — so its streak differs).
function maxOptLosingStreakByDate(picks: GradedPick[]): number {
  const sorted = [...picks].sort((a, b) => a.pickedDate.localeCompare(b.pickedDate));
  let max = 0, cur = 0;
  for (const p of sorted) {
    if (p.optOutcome === 'LOSS') { cur++; max = Math.max(max, cur); }
    else cur = 0;
  }
  return max;
}

// Same shape as summarize(), but over the Black-Scholes contract P&L. Returns
// `ambiguous: 0` (the field is meaningless for the options arm) so it can reuse
// printSummary unchanged.
function summarizeOptions(picks: GradedPick[]) {
  const v = picks.filter(p => p.optReturnPct != null);
  const n = v.length;
  const wins = v.filter(p => p.optOutcome === 'WIN');
  const losses = v.filter(p => p.optOutcome === 'LOSS');
  const ret = (p: GradedPick) => p.optReturnPct as number;
  const avg = n ? v.reduce((s, p) => s + ret(p), 0) / n : 0;
  const avgWin = wins.length ? wins.reduce((s, p) => s + ret(p), 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, p) => s + ret(p), 0) / losses.length : 0;
  return {
    n, wins: wins.length, losses: losses.length,
    winRate: n ? (wins.length / n) * 100 : 0,
    expectancy: avg, avgWin, avgLoss,
    streak: maxOptLosingStreakByDate(v),
    ambiguous: 0,
  };
}

// ════════════════════════════════════════════════════════════
// PHASE 2 — information asymmetry, graded through the SAME harness
// ════════════════════════════════════════════════════════════

// Point-in-time market regime from SPY bars ≤ cutoff (no lookahead).
function buildRegime(spyBars: Bars, date: string): RegimeView | null {
  const idx = indexAtOrBefore(spyBars, date);
  if (idx < WARMUP_BARS) return null;
  const view = pointInTimeView(spyBars, idx);
  assertNoLookahead(view, date); // regime inputs are point-in-time too
  const closes = view.closes;
  const price = closes[closes.length - 1];
  const t = computeTechnicals('SPY', closes, price);
  const pctVs200 = t.sma200 ? ((price - t.sma200) / t.sma200) * 100 : null;
  const pctVs50 = t.sma50 ? ((price - t.sma50) / t.sma50) * 100 : null;
  const chg20d = closes.length > 21 ? pct(price, closes[closes.length - 21]) : null;
  return {
    date, spyPrice: price, spySma50: t.sma50, spySma200: t.sma200,
    pctVs200, pctVs50, chg20d, trend: t.trend,
  };
}

// Anonymized technical slice for one candidate (no ticker/name/sector).
function buildTechnicalView(cand: ScoredCandidate): TechnicalView {
  const q = cand.quote, t = cand.technicals;
  return {
    strategy: cand.strategy,
    price: q.price,
    changePercent: q.changePercent,
    rsi: t.rsi, macd: t.macd, macdSignal: t.macdSignal,
    sma20: t.sma20, sma50: t.sma50, sma200: t.sma200,
    trend: t.trend,
    pctTo52High: q.week52High > 0 ? ((q.week52High - q.price) / q.week52High) * 100 : 0,
    pctFrom52Low: q.price > 0 ? ((q.price - q.week52Low) / q.price) * 100 : 0,
    setupReasons: cand.reasons,
  };
}

export interface Phase2Run {
  mechanical: GradedPick[];   // ALL top-K candidates on the sampled dates (baseline)
  filtered: GradedPick[];     // the subset the agent combo approved
  dates: string[];
  considered: number;
  kept: number;
  threshold: number;
}

// Evenly spaced subset of the full weekly scan calendar.
function sampleScanDates(calendar: string[], count: number): string[] {
  const lastEntryIdx = calendar.length - 1 - HORIZON;
  const all: number[] = [];
  for (let di = WARMUP_BARS; di <= lastEntryIdx; di += CADENCE) all.push(di);
  if (count >= all.length) return all.map(di => calendar[di]);
  const step = all.length / count;
  const idxs = new Set<number>();
  for (let i = 0; i < count; i++) idxs.add(all[Math.floor(i * step)]);
  return [...idxs].sort((a, b) => a - b).map(di => calendar[di]);
}

export async function runPhase2(
  barsCache: Map<string, Bars>,
  fundCache: Map<string, Fundamentals>,
  dateCount: number,
  threshold: number,
): Promise<Phase2Run> {
  const spyBars = barsCache.get('SPY');
  if (!spyBars) throw new Error('[Phase2] SPY bars required for the regime agent — include SPY in the universe.');

  const calendar = [...barsCache.values()].sort((a, b) => b.dates.length - a.dates.length)[0].dates;
  const dates = sampleScanDates(calendar, dateCount);

  const mechanical: GradedPick[] = [];
  const filtered: GradedPick[] = [];
  let considered = 0, kept = 0;

  for (const date of dates) {
    // Regime: one call per scan date (same for every stock that day).
    const regimeView = buildRegime(spyBars, date);
    const regime: AgentVerdict = regimeView
      ? await regimeVerdict(regimeView)
      : { direction: 'neutral', confidence: 50, reason: 'no regime data' };

    const { breakout, pullback } = replayScanner(date, barsCache, fundCache);
    const candidates = [...breakout.slice(0, TOP_K), ...pullback.slice(0, TOP_K)];

    for (const cand of candidates) {
      const bars = barsCache.get(cand.quote.ticker)!;
      const entryIdx = indexAtOrBefore(bars, date);
      if (entryIdx < WARMUP_BARS || entryIdx + HORIZON > bars.dates.length - 1) continue;

      const entry = bars.closes[entryIdx];
      const view = pointInTimeView(bars, entryIdx);
      assertNoLookahead(view, date);
      const levels = exitLevels(entry, view, 'atr'); // Phase 2 uses the ATR baseline exits
      if (!levels) continue;

      const g = gradeForward(bars, entryIdx, entry, levels.target, levels.stop);
      const gp = buildGraded(cand, date, entry, levels.target, levels.stop, g);
      mechanical.push(gp); // baseline: every candidate graded on these dates

      // Technical agent: per candidate, anonymized, point-in-time.
      considered++;
      const tech = await technicalVerdict(date, cand.quote.ticker, buildTechnicalView(cand));
      const { pick } = combine(tech, regime, threshold);
      if (pick) { kept++; filtered.push(gp); } // identical grade, just a kept subset
    }
    saveCache();
    console.log(`[Phase2] ${date}: regime ${regime.direction}(${regime.confidence}) | ` +
      `considered ${candidates.length}, kept ${filtered.filter(f => f.pickedDate === date).length}`);
  }

  saveCache();
  return { mechanical, filtered, dates, considered, kept, threshold };
}

// ════════════════════════════════════════════════════════════
// Standalone runner — Phase 1 Step 3 graded backtest.
//   ts-node src/backtest.ts [--exit atr|fixed] [--limit N]
// Default: ATR-scaled exits, full candidate universe.
// ════════════════════════════════════════════════════════════
interface Args {
  mode: ExitMode; limit: number;
  phase2: boolean; threshold: number; dates: number;
}
function parseArgs(argv: string[]): Args {
  let mode: ExitMode = 'atr';
  let limit = Infinity;
  let phase2 = false, threshold = 60, dates = 14;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--exit') mode = (argv[++i] === 'fixed') ? 'fixed' : 'atr';
    else if (argv[i] === '--limit') limit = parseInt(argv[++i] || '0', 10) || Infinity;
    else if (argv[i] === '--phase2') phase2 = true;
    else if (argv[i] === '--threshold') threshold = Number(argv[++i]) || 60;
    else if (argv[i] === '--dates') dates = parseInt(argv[++i] || '0', 10) || 14;
  }
  return { mode, limit, phase2, threshold, dates };
}

function fmtPct(x: number): string { return `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`; }

function printSummary(label: string, s: ReturnType<typeof summarize>): void {
  console.log(`  ${label.padEnd(16)}  N=${String(s.n).padStart(3)}  ` +
    `win ${s.winRate.toFixed(0).padStart(3)}%  ` +
    `exp ${fmtPct(s.expectancy).padStart(8)}  ` +
    `(W ${fmtPct(s.avgWin)} / L ${fmtPct(s.avgLoss)})  ` +
    `worst streak ${s.streak}  ` +
    `ambig ${s.ambiguous}`);
}

// Per strategy, print two rows: the existing swing/stock-drift grade and the
// new Black-Scholes options-contract grade — same matched picks, same format.
function printStrategyPair(label: string, picks: GradedPick[]): void {
  printSummary(`${label} swing`, summarize(picks));
  printSummary(`${label} opts`, summarizeOptions(picks));
}

// Loud, unburied caveats for the options arm (printed in every report).
function printOptionsCaveat(): void {
  console.log('  ⚠️  OPTIONS ARM CAVEATS — read before trusting the opts rows:');
  console.log('     • "swing" = stock-drift P&L (unchanged). "opts" = Black-Scholes contract P&L.');
  console.log('     • IV is the price-tier MODEL, not real option-chain IV. Theta and IV-crush');
  console.log('       both ride on this estimate → the opts number is DIRECTIONALLY informative,');
  console.log('       not precise. (Strike/IV from estimateOptionsData; BS r=4%, ~4wk expiry.)');
  console.log('     • Stops exit at the contract\'s residual BS value at the −1.5×ATR level — NOT');
  console.log('       −100%. It assumes you can exit AT the stop; on wide-spread / illiquid');
  console.log('       contracts that is optimistic, so the opts result is a MILD UPPER BOUND.');
}

async function main() {
  const { mode, limit, phase2, threshold, dates } = parseArgs(process.argv.slice(2));
  const universe = getCandidateTickers().slice(0, Number.isFinite(limit) ? limit : undefined);
  // The regime agent needs SPY — guarantee it's loaded even under --limit.
  if (phase2 && !universe.includes('SPY')) universe.push('SPY');

  console.log('═'.repeat(64));
  console.log(`  BACKTEST — ${phase2 ? 'Phase 2 information asymmetry' : 'Phase 1 Step 3 graded replay'}`);
  console.log(`  Exit mode: ${mode === 'atr' ? 'ATR-scaled (2.5×ATR target / 1.5×ATR stop)' : 'fixed (+10% / −7%)'}`);
  console.log(`  Horizon: ${HORIZON}d  |  Cadence: every ${CADENCE}d  |  Top ${TOP_K}/strategy/scan`);
  if (phase2) console.log(`  Agents: technical + regime (Claude, temp 0)  |  threshold ${threshold}  |  ${dates} sampled dates`);
  console.log(`  Loading ${universe.length} tickers (bars + fundamentals)...`);
  console.log('═'.repeat(64));

  const barsCache = new Map<string, Bars>();
  const fundCache = new Map<string, Fundamentals>();
  let cached = 0, fetched = 0;
  for (const t of universe) {
    const { data, hit } = await loadTickerData(t);
    if (!data) { if (!hit) await sleep(250); continue; } // pace only real misses
    barsCache.set(t, data.bars);
    fundCache.set(t, data.fund);
    if (hit) { cached++; } else { fetched++; await sleep(250); }
  }
  saveBarsDisk(); // persist any newly fetched tickers
  console.log(`  Loaded ${barsCache.size}/${universe.length} tickers with full data ` +
    `(${cached} from disk cache, ${fetched} freshly fetched).`);

  // ── Lookahead self-test (Step 2 guarantee still holds) ────
  const probe = [...barsCache.values()][0];
  const calendar = [...barsCache.values()].sort((a, b) => b.dates.length - a.dates.length)[0].dates;
  const midCut = calendar[Math.floor(calendar.length / 2)];
  const pIdx = indexAtOrBefore(probe, midCut);
  let caught = false;
  try { assertNoLookahead(pointInTimeView(probe, pIdx + 5), midCut); } catch { caught = true; }
  console.log(`  Lookahead guard fires on a future-dated view: ${caught ? '✅' : '❌ FAIL'}\n`);

  // ── Phase 2 branch: information asymmetry ────────────────
  if (phase2) {
    const p2 = await runPhase2(barsCache, fundCache, dates, threshold);
    const mPull = p2.mechanical.filter(g => g.strategy === 'PULLBACK');
    const mBrk = p2.mechanical.filter(g => g.strategy === 'BREAKOUT');
    const fPull = p2.filtered.filter(g => g.strategy === 'PULLBACK');
    const fBrk = p2.filtered.filter(g => g.strategy === 'BREAKOUT');

    console.log('\n' + '═'.repeat(64));
    console.log('  PHASE 2 — INFORMATION ASYMMETRY  (agent-filtered vs mechanical)');
    console.log('─'.repeat(64));
    console.log(`  Sampled scan dates (${p2.dates.length}): ${p2.dates.join(', ')}`);
    console.log(`  Combination: AND-gate — BOTH technical AND regime must independently ` +
      `return long with own confidence ≥ ${p2.threshold} (no averaging)`);
    console.log(`  Selection: kept ${p2.kept} / ${p2.considered} candidates ` +
      `(${p2.considered ? ((p2.kept / p2.considered) * 100).toFixed(0) : 0}%)`);
    console.log(`  Phase 1 full-window baseline: PULLBACK +0.6% / BREAKOUT +0.9% expectancy\n`);
    printOptionsCaveat();
    console.log('\n  MECHANICAL (all candidates, same sampled dates) — the control:');
    printStrategyPair('PULLBACK', mPull);
    printStrategyPair('BREAKOUT', mBrk);
    console.log('\n  AGENT-FILTERED (combined verdict cleared threshold) — the test:');
    printStrategyPair('PULLBACK', fPull);
    printStrategyPair('BREAKOUT', fBrk);
    console.log('═'.repeat(64));

    // Verdict lines: did the asymmetry clear the mechanical floor? (both arms)
    const dPullSwing = summarize(fPull).expectancy - summarize(mPull).expectancy;
    const dBrkSwing = summarize(fBrk).expectancy - summarize(mBrk).expectancy;
    const dPullOpts = summarizeOptions(fPull).expectancy - summarizeOptions(mPull).expectancy;
    const dBrkOpts = summarizeOptions(fBrk).expectancy - summarizeOptions(mBrk).expectancy;
    console.log(`  Δ swing expectancy vs same-date mechanical:  ` +
      `PULLBACK ${fmtPct(dPullSwing)}  |  BREAKOUT ${fmtPct(dBrkSwing)}`);
    console.log(`  Δ opts  expectancy vs same-date mechanical:  ` +
      `PULLBACK ${fmtPct(dPullOpts)}  |  BREAKOUT ${fmtPct(dBrkOpts)}`);
    console.log('═'.repeat(64));

    if (fPull.length) await runEvaluation(fPull, `PHASE2 PULLBACK / agent-filtered`);
    if (fBrk.length) await runEvaluation(fBrk, `PHASE2 BREAKOUT / agent-filtered`);
    saveCache();
    return;
  }

  // ── Run the graded backtest ──────────────────────────────
  const run = runBacktest(barsCache, fundCache, mode);
  const pullback = run.graded.filter(g => g.strategy === 'PULLBACK');
  const breakout = run.graded.filter(g => g.strategy === 'BREAKOUT');

  console.log('═'.repeat(64));
  console.log('  HEAD-TO-HEAD SUMMARY  (mechanical entry, no LLM)');
  console.log('─'.repeat(64));
  console.log(`  Scan dates: ${run.scanDates}  |  Total graded picks: ${run.graded.length}`);
  console.log(`  Ambiguous same-bar target+stop hits: ${run.ambiguousCount} (graded LOSS, pessimistic)\n`);
  printOptionsCaveat();
  console.log('');
  printStrategyPair('PULLBACK', pullback);
  printStrategyPair('BREAKOUT', breakout);
  printStrategyPair('BLENDED', run.graded);
  console.log('═'.repeat(64));

  // ── Full honest-eval report per strategy (existing harness) ──
  // SPY benchmark inside these reports is full-window total return, not
  // per-trade — read it as market context, not a per-pick alpha.
  if (pullback.length) await runEvaluation(pullback, `PULLBACK / ${mode} exits`);
  if (breakout.length) await runEvaluation(breakout, `BREAKOUT / ${mode} exits`);
}

// Run only when invoked directly (ts-node src/backtest.ts), not on import.
if (require.main === module) {
  main().catch(err => { console.error('[Backtest] fatal:', err); process.exit(1); });
}
