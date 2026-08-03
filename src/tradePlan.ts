// ============================================================
// TRADE PLAN — single source of truth for the V2 exit regime
// ------------------------------------------------------------
// Every V2 pick is a full plan fixed at entry: absolute TP/SL,
// risk/reward, and a hard horizon in trading days. Exits happen
// on TP, SL, or horizon expiry — whichever comes first — never
// on a weekly grading clock. Per-strategy defaults live HERE
// (env-overridable); no other module hardcodes plan numbers.
// ============================================================

export type ExitRegime = 'V1_WEEKLY' | 'V2_TRADE_PLAN';

// Every record written from now on carries this tag. Legacy rows are
// tagged V1_WEEKLY by the one-time migration (npm run migrate:regime);
// readers must treat a MISSING exitRegime as V1_WEEKLY, never as V2.
export const CURRENT_EXIT_REGIME: ExitRegime = 'V2_TRADE_PLAN';

export function regimeOf(r: { exitRegime?: ExitRegime | string }): ExitRegime {
  return r.exitRegime === 'V2_TRADE_PLAN' ? 'V2_TRADE_PLAN' : 'V1_WEEKLY';
}

export type ExitOutcome = 'HIT_TARGET' | 'HIT_STOP' | 'TIME_EXIT';

// ── Concurrent position slots ───────────────────────────────
// The bot maintains up to this many concurrent V2 positions and scans
// for ONE replacement per freed slot (rolling replacement, not
// batch-and-wait). Legacy V1 open rows never occupy a slot.
export const MAX_SLOTS = envInt('MAX_SLOTS', 5);

// ── Per-strategy plan defaults ──────────────────────────────
// BREAKOUT moves fast or it was wrong → short horizon, tight plan.
// PULLBACK needs time to rebuild off support → longer horizon.
// Both are RR 2.0 by construction. Percentages are the deterministic
// plan levels; env keys let the VPS tune without a deploy.
export interface StrategyPlan {
  horizonDays: number;   // hard cap, in trading days
  tpPct: number;         // take-profit, % above entry
  slPct: number;         // stop-loss, % below entry
}

export const STRATEGY_PLANS: Record<'BREAKOUT' | 'PULLBACK', StrategyPlan> = {
  BREAKOUT: {
    horizonDays: envInt('BREAKOUT_HORIZON_DAYS', 7),
    tpPct: envNum('BREAKOUT_TP_PCT', 8),
    slPct: envNum('BREAKOUT_SL_PCT', 4),
  },
  PULLBACK: {
    horizonDays: envInt('PULLBACK_HORIZON_DAYS', 15),
    tpPct: envNum('PULLBACK_TP_PCT', 10),
    slPct: envNum('PULLBACK_SL_PCT', 5),
  },
};

// Fallback when a pick somehow has no strategy tag (shouldn't happen
// for V2 picks — the scanner always tags — but never crash on it).
const FALLBACK_PLAN: StrategyPlan = { horizonDays: 10, tpPct: 8, slPct: 4 };

export function planFor(strategy: string | undefined): StrategyPlan {
  return STRATEGY_PLANS[strategy as 'BREAKOUT' | 'PULLBACK'] ?? FALLBACK_PLAN;
}

// ── Plan levels from an entry price ─────────────────────────
// Deterministic percentage levels. The scanner's support/resistance are
// too crude to anchor real exits on (support falls back to SMA50,
// resistance is literally price×1.10) and the live pipeline computes no
// ATR — so percentages ARE the plan, not a fallback.
export interface PlanLevels {
  tp: number;
  sl: number;
  rr: number;            // (tp − entry) / (entry − sl)
  horizonDays: number;
}

export function computePlan(entry: number, strategy: string | undefined): PlanLevels {
  const p = planFor(strategy);
  const tp = round2(entry * (1 + p.tpPct / 100));
  const sl = round2(entry * (1 - p.slPct / 100));
  const rr = entry - sl > 0 ? parseFloat(((tp - entry) / (entry - sl)).toFixed(2)) : 0;
  return { tp, sl, rr, horizonDays: p.horizonDays };
}

function round2(x: number): number { return Math.round(x * 100) / 100; }

function envInt(key: string, fallback: number): number {
  const v = parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function envNum(key: string, fallback: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
