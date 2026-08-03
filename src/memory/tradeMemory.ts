// ============================================================
// TRADE MEMORY BANK — data/trade-memory.json
// ------------------------------------------------------------
// Records every finalized pick with its scan-time features, then
// closes the record when the scorecard resolves it. Once a
// strategy has MIN_CLOSED_FOR_RETRIEVAL closed trades, the bank
// retrieves the TOP_K most similar past setups (weighted
// nearest-neighbor over 4 numeric features + a news-verdict
// bonus) and returns a prompt block for the ensemble grader.
//
// Memory only informs the grader's JUDGMENT — it never touches
// entry/exit levels or execution logic. Every record carries a
// memoryShown flag so memory-informed picks can be A/B compared
// against the pre-memory baseline (memoryHeadToHead).
//
// No embeddings / vector DB by design: at dozens-to-hundreds of
// trades, weighted nearest-neighbor is transparent, debuggable,
// and free. Revisit only past ~1,000 records.
// ============================================================

import fs from 'fs';
import path from 'path';
import { ExitRegime, CURRENT_EXIT_REGIME, regimeOf } from '../tradePlan';

const MEMORY_FILE = path.join(process.cwd(), 'data', 'trade-memory.json');

// ── Tuning knobs ────────────────────────────────────────────
// Retrieval stays OFF until a strategy has this many closed trades —
// below that, "nearest" neighbors are noise, not signal.
// Counted WITHIN the current exit regime only: outcomes produced under
// different exit rules aren't comparable, so the V2 switch deliberately
// re-arms this gate for both strategies (V1 records stay stored but are
// never retrieved and never count).
export const MIN_CLOSED_FOR_RETRIEVAL = 10;

// How many similar past trades are shown to the grader.
export const TOP_K = 5;

// Per-feature weight and normalization scale. A difference of
// `scale` in a feature contributes one full weighted unit of
// distance (differences are capped at 2x scale so one wild
// feature can't dominate).
export const FEATURE_WEIGHTS: Record<string, { weight: number; scale: number }> = {
  rsi:          { weight: 1.0,  scale: 12 },   // RSI points
  pctFromSma20: { weight: 1.0,  scale: 4 },    // % distance from SMA20
  volumeRatio:  { weight: 0.75, scale: 1.0 },  // volume / avgVolume
  change5dPct:  { weight: 0.75, scale: 6 },    // 5-day % move
};

// Similarity bonus when the past trade's news verdict matches the
// candidate's (bullish/bearish/neutral — 'none' never matches).
export const NEWS_MATCH_BONUS = 0.10;

// ── Types ───────────────────────────────────────────────────
export type NewsVerdict = 'bullish' | 'bearish' | 'neutral' | 'none';

export interface TradeFeatures {
  rsi: number | null;
  pctFromSma20: number | null;
  volumeRatio: number | null;
  change5dPct: number | null;
  newsVerdict: NewsVerdict;
  marketRegime?: string;
}

// TIME_EXIT is the V2 horizon-expiry outcome; CLOSED_FLAT survives on
// legacy V1 records (weekly drift closes) — treat both as "closed, graded
// by return sign".
export type TradeStatus = 'OPEN' | 'HIT_TARGET' | 'HIT_STOP' | 'CLOSED_FLAT' | 'TIME_EXIT';

export interface TradeRecord {
  ticker: string;
  strategy: string;            // 'PULLBACK' | 'BREAKOUT' ('' for legacy rows)
  scanDate: string;            // YYYY-MM-DD (normalized on write)
  entry: number;
  target: number;
  stop: number;
  features: TradeFeatures;
  ensemble: { consensusScore: number; votes: string };
  memoryShown: boolean;        // A/B flag: was memory injected when this was graded?
  status: TradeStatus;
  exitDate?: string;           // YYYY-MM-DD
  exitPrice?: number;
  pnlPct?: number;
  daysHeld?: number;
  // Absent on legacy rows = V1_WEEKLY (the migration tags them). Records
  // from different regimes never mix in retrieval, gates, or the A/B eval.
  exitRegime?: ExitRegime;
}

interface MemoryFile {
  records: TradeRecord[];
}

// ── Load / save (atomic tmp+rename, same as current-picks) ──
function loadMemory(): MemoryFile {
  try {
    if (!fs.existsSync(MEMORY_FILE)) return { records: [] };
    const parsed = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8'));
    return Array.isArray(parsed?.records) ? parsed : { records: [] };
  } catch {
    return { records: [] };
  }
}

function saveMemory(mem: MemoryFile): void {
  const dir = path.dirname(MEMORY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${MEMORY_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(mem, null, 2));
  fs.renameSync(tmp, MEMORY_FILE);
}

// Dates arrive as full ISO timestamps from some callers (pick.addedAt,
// portfolio addedDate) — those two are written seconds apart, so the
// join key is the calendar day, not the timestamp.
function toDay(date: string): string {
  return (date || '').slice(0, 10);
}

function normStrategy(s: string | undefined | null): string {
  return s ?? '';
}

function isClosed(r: TradeRecord): boolean {
  return r.status !== 'OPEN';
}

function isWin(r: TradeRecord): boolean {
  if (r.status === 'HIT_TARGET') return true;
  if (r.status === 'HIT_STOP') return false;
  return (r.pnlPct ?? 0) >= 0;   // CLOSED_FLAT / TIME_EXIT: graded by return sign
}

// Only records from the CURRENT regime participate in retrieval, gates,
// and the memory-vs-baseline A/B — V1 outcomes came from different exit
// rules and would poison V2 similarity lookups.
function isCurrentRegime(r: TradeRecord): boolean {
  return regimeOf(r) === CURRENT_EXIT_REGIME;
}

// ── Similarity ──────────────────────────────────────────────
// Weighted normalized distance over the numeric features both sides
// have, mapped to (0,1] via 1/(1+d), plus the news-match bonus.
function similarity(a: TradeFeatures, b: TradeFeatures): number {
  let dist = 0;
  let weightUsed = 0;

  for (const [key, { weight, scale }] of Object.entries(FEATURE_WEIGHTS)) {
    const av = a[key as keyof TradeFeatures] as number | null;
    const bv = b[key as keyof TradeFeatures] as number | null;
    if (av == null || bv == null) continue;
    const norm = Math.min(2, Math.abs(av - bv) / scale); // cap at 2 scales
    dist += weight * norm;
    weightUsed += weight;
  }

  // No overlapping features → no basis for similarity.
  if (weightUsed === 0) return 0;

  let sim = 1 / (1 + dist / weightUsed);
  if (a.newsVerdict !== 'none' && a.newsVerdict === b.newsVerdict) {
    sim += NEWS_MATCH_BONUS;
  }
  return sim;
}

// ── Write path 1: record a finalized pick ───────────────────
export interface RecordPickInput {
  ticker: string;
  strategy: string;
  scanDate: string;
  entry: number;
  target: number;
  stop: number;
  features: TradeFeatures;
  ensemble: { consensusScore: number; votes: string };
  memoryShown: boolean;
}

export function recordPick(input: RecordPickInput): void {
  const mem = loadMemory();
  const strategy = normStrategy(input.strategy);
  const scanDate = toDay(input.scanDate);

  // Mirror the portfolio tracker's dedupe: one OPEN record per
  // ticker+strategy. A re-picked name keeps its ORIGINAL record so the
  // features/scanDate stay anchored to the first pick — which is also
  // the addedDate the scorecard will close it against.
  const existing = mem.records.find(
    r => r.status === 'OPEN' && r.ticker === input.ticker && r.strategy === strategy
  );
  if (existing) {
    console.log(`[TradeMemory] ${input.ticker} (${strategy || 'n/a'}) already OPEN — keeping original record`);
    return;
  }

  mem.records.push({
    ticker: input.ticker,
    strategy,
    scanDate,
    entry: input.entry,
    target: input.target,
    stop: input.stop,
    features: input.features,
    ensemble: input.ensemble,
    memoryShown: input.memoryShown,
    status: 'OPEN',
    exitRegime: CURRENT_EXIT_REGIME,
  });
  saveMemory(mem);
  console.log(`[TradeMemory] Recorded pick ${input.ticker} (${strategy || 'n/a'}) — memoryShown=${input.memoryShown}`);
}

// ── Write path 2: close a record with its outcome ───────────
export interface RecordOutcomeInput {
  ticker: string;
  strategy?: string;
  scanDate: string;
  status: 'HIT_TARGET' | 'HIT_STOP' | 'CLOSED_FLAT' | 'TIME_EXIT';
  exitDate: string;
  exitPrice: number;
}

// Idempotent: an already-closed record is never re-closed, so reconcile
// running twice can't double-close (same guarantee as the tracker's
// dedupe-by-ticker+strategy pattern).
export function recordOutcome(input: RecordOutcomeInput): void {
  const mem = loadMemory();
  const strategy = normStrategy(input.strategy);
  const scanDate = toDay(input.scanDate);

  const candidates = mem.records.filter(
    r => r.ticker === input.ticker && r.strategy === strategy
  );

  // Exact join on scan day first; fall back to the oldest still-OPEN
  // record for the same ticker+strategy (covers clock-skew edge cases).
  let rec = candidates.find(r => r.scanDate === scanDate);
  if (!rec) {
    rec = candidates
      .filter(r => r.status === 'OPEN')
      .sort((a, b) => a.scanDate.localeCompare(b.scanDate))[0];
    if (rec) {
      console.log(`[TradeMemory] ${input.ticker}: no record for scan ${scanDate} — closing oldest OPEN (${rec.scanDate})`);
    }
  }

  if (!rec) {
    console.log(`[TradeMemory] ${input.ticker} (${strategy || 'n/a'}, ${scanDate}): no memory record to close — skipping`);
    return;
  }
  if (rec.status !== 'OPEN') return; // already closed — idempotent no-op

  const exitDate = toDay(input.exitDate);
  rec.status = input.status;
  rec.exitDate = exitDate;
  rec.exitPrice = input.exitPrice;
  rec.pnlPct = parseFloat((((input.exitPrice - rec.entry) / rec.entry) * 100).toFixed(2));
  const heldMs = new Date(exitDate).getTime() - new Date(rec.scanDate).getTime();
  rec.daysHeld = Math.max(0, Math.round(heldMs / (1000 * 60 * 60 * 24)));

  saveMemory(mem);
  console.log(`[TradeMemory] Closed ${rec.ticker} (${rec.strategy || 'n/a'}) ${rec.status} — ${rec.pnlPct}% in ${rec.daysHeld}d`);
}

// ── Read path: retrieval for the grader ─────────────────────
export interface MemoryContext {
  available: boolean;
  promptBlock: string;
  neighbors: TradeRecord[];
}

export function getMemoryContext(strategy: string, features: TradeFeatures): MemoryContext {
  const mem = loadMemory();
  const closed = mem.records.filter(
    r => isClosed(r) && isCurrentRegime(r) && r.strategy === normStrategy(strategy)
  );

  if (closed.length < MIN_CLOSED_FOR_RETRIEVAL) {
    return { available: false, promptBlock: '', neighbors: [] };
  }

  const ranked = closed
    .map(r => ({ r, sim: similarity(features, r.features) }))
    .filter(x => x.sim > 0)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, TOP_K);

  if (ranked.length === 0) {
    return { available: false, promptBlock: '', neighbors: [] };
  }

  const wins = ranked.filter(x => isWin(x.r)).length;
  const avgPnl = ranked.reduce((s, x) => s + (x.r.pnlPct ?? 0), 0) / ranked.length;

  const lines = ranked.map(x => {
    const f = x.r.features;
    const outcome = x.r.status === 'HIT_TARGET' ? 'HIT TARGET'
      : x.r.status === 'HIT_STOP' ? 'HIT STOP'
      : x.r.status === 'TIME_EXIT' ? `TIME EXIT ${(x.r.pnlPct ?? 0) >= 0 ? 'UP' : 'DOWN'}`
      : `CLOSED ${(x.r.pnlPct ?? 0) >= 0 ? 'UP' : 'DOWN'}`;
    const parts = [
      f.rsi != null ? `RSI ${f.rsi.toFixed(0)}` : null,
      f.pctFromSma20 != null ? `${f.pctFromSma20 >= 0 ? '+' : ''}${f.pctFromSma20.toFixed(1)}% vs SMA20` : null,
      f.volumeRatio != null ? `vol ${f.volumeRatio.toFixed(1)}x` : null,
      f.change5dPct != null ? `5d ${f.change5dPct >= 0 ? '+' : ''}${f.change5dPct.toFixed(1)}%` : null,
      f.newsVerdict !== 'none' ? `news ${f.newsVerdict}` : null,
    ].filter(Boolean).join(', ');
    return `- ${x.r.ticker} (${x.r.scanDate}): ${parts} → ${outcome}, ${(x.r.pnlPct ?? 0) >= 0 ? '+' : ''}${(x.r.pnlPct ?? 0).toFixed(1)}% in ${x.r.daysHeld ?? '?'}d [similarity ${x.sim.toFixed(2)}]`;
  });

  const promptBlock = [
    `PAST TRADES WITH SIMILAR SETUPS (${strategy} strategy, this bot's own graded history):`,
    ...lines,
    `Summary: ${wins} of ${ranked.length} similar setups won; avg move ${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(1)}%.`,
    `Treat this as context on how comparable setups actually resolved — weigh it in your confidence, but judge the current setup on its own merits.`,
  ].join('\n');

  return { available: true, promptBlock, neighbors: ranked.map(x => x.r) };
}

// ── Evaluation: memory-informed vs baseline (the kill criterion) ──
export interface HeadToHeadSide {
  n: number;
  wins: number;
  losses: number;
  winRate: number;    // 0-100
  avgPnlPct: number;
}

export interface HeadToHead {
  memory: HeadToHeadSide;
  baseline: HeadToHeadSide;
}

function tallySide(records: TradeRecord[]): HeadToHeadSide {
  const wins = records.filter(isWin).length;
  const losses = records.length - wins;
  const avg = records.length
    ? records.reduce((s, r) => s + (r.pnlPct ?? 0), 0) / records.length
    : 0;
  return {
    n: records.length,
    wins,
    losses,
    winRate: records.length ? parseFloat(((wins / records.length) * 100).toFixed(1)) : 0,
    avgPnlPct: parseFloat(avg.toFixed(2)),
  };
}

// Current-regime records only — the A/B compares memory-informed vs
// baseline picks under the SAME exit rules.
export function memoryHeadToHead(): HeadToHead {
  const closed = loadMemory().records.filter(r => isClosed(r) && isCurrentRegime(r));
  return {
    memory: tallySide(closed.filter(r => r.memoryShown)),
    baseline: tallySide(closed.filter(r => !r.memoryShown)),
  };
}

// ── Introspection helpers (dashboard / debugging) ────────────
export function getMemoryStats(): {
  total: number;
  open: number;
  closedByStrategy: Record<string, number>;   // current regime — these feed the gate
  legacyClosed: number;                       // V1 records: stored, never retrieved
} {
  const records = loadMemory().records;
  const closedByStrategy: Record<string, number> = {};
  let legacyClosed = 0;
  for (const r of records) {
    if (!isClosed(r)) continue;
    if (!isCurrentRegime(r)) { legacyClosed++; continue; }
    const key = r.strategy || 'n/a';
    closedByStrategy[key] = (closedByStrategy[key] || 0) + 1;
  }
  return {
    total: records.length,
    open: records.filter(r => r.status === 'OPEN').length,
    closedByStrategy,
    legacyClosed,
  };
}
