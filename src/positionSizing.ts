// ============================================================
// POSITION SIZING — THE sizing module
// ------------------------------------------------------------
// Pure functions: (available cash, picks, prices) → sized orders.
// Today the only consumer is the paper-trading simulator, but this
// module is written as the real sizing engine: when live execution
// is wired (Phase 4), it must reuse these exact functions. Keep it
// pure — no filesystem, no network, no paper-account assumptions.
// ============================================================

// Robinhood supports fractional shares to 6 decimals; we floor to 5
// so a displayed quantity always round-trips exactly through JSON.
export const SHARE_DECIMALS = 5;

// Minimum notional per position. Robinhood's real floor is $1, but
// sub-$5 slivers are noise: the P&L can't move the account and the
// position count balloons. Below this we skip the pick entirely.
export const MIN_NOTIONAL = 5;

export interface SizingPick {
  ticker: string;
  entryPrice: number;        // fill price the order will be placed at
  confidenceScore: number;   // funding priority when cash is thin (higher first)
  strategy?: string;         // carried through untouched for the caller
}

export interface SizedOrder {
  ticker: string;
  strategy?: string;
  entryPrice: number;
  shares: number;            // fractional, floored to SHARE_DECIMALS
  costBasis: number;         // shares × entryPrice, FLOORED to cents — never
                             // rounds up, so Σ costBasis can never overspend cash
}

export interface SkippedPick {
  ticker: string;
  reason: string;
}

export interface SizingResult {
  orders: SizedOrder[];
  skipped: SkippedPick[];
  totalCost: number;         // Σ costBasis — guaranteed ≤ availableCash
}

function floorShares(shares: number): number {
  const f = 10 ** SHARE_DECIMALS;
  return Math.floor(shares * f) / f;
}

// Floor (not round) to cents: rounding 66.6664 up to 66.67 across a few
// positions would overspend availableCash by pennies.
function floorCents(x: number): number {
  return Math.floor(x * 100 + 1e-9) / 100;  // epsilon guards float dust like 5.999999999
}

function roundCents(x: number): number {
  return Math.round(x * 100) / 100;
}

// ── Equal-notional allocation across the week's picks ───────
// Splits availableCash evenly across the picks using fractional
// shares. If the even split lands under MIN_NOTIONAL, funds fewer
// picks instead — in confidenceScore order — rather than making
// every position dust. Never allocates more than availableCash.
export function sizePicks(availableCash: number, picks: SizingPick[]): SizingResult {
  const orders: SizedOrder[] = [];
  const skipped: SkippedPick[] = [];

  if (!Number.isFinite(availableCash) || availableCash < MIN_NOTIONAL) {
    for (const p of picks) {
      skipped.push({ ticker: p.ticker, reason: `available cash $${(availableCash || 0).toFixed(2)} is below the $${MIN_NOTIONAL} minimum notional` });
    }
    return { orders, skipped, totalCost: 0 };
  }

  // Drop unpriceable picks before dividing the cash.
  const fundable: SizingPick[] = [];
  for (const p of picks) {
    if (!Number.isFinite(p.entryPrice) || p.entryPrice <= 0) {
      skipped.push({ ticker: p.ticker, reason: `no usable entry price (${p.entryPrice})` });
    } else {
      fundable.push(p);
    }
  }
  if (fundable.length === 0) return { orders, skipped, totalCost: 0 };

  // Thin cash: fund only the top-confidence picks so each funded
  // position clears MIN_NOTIONAL. floor(cash / MIN_NOTIONAL) is the
  // most positions that can each get at least the minimum.
  const maxFundable = Math.floor(availableCash / MIN_NOTIONAL);
  const ranked = [...fundable].sort((a, b) => b.confidenceScore - a.confidenceScore);
  const funded = ranked.slice(0, Math.min(fundable.length, maxFundable));
  for (const p of ranked.slice(funded.length)) {
    skipped.push({
      ticker: p.ticker,
      reason: `cash too thin for all ${fundable.length} picks — funded the ${funded.length} highest-confidence pick(s) at ≥ $${MIN_NOTIONAL} each`,
    });
  }

  const notionalPer = availableCash / funded.length;

  for (const p of funded) {
    const shares = floorShares(notionalPer / p.entryPrice);
    const costBasis = floorCents(shares * p.entryPrice);
    if (shares <= 0 || costBasis <= 0) {
      // Only reachable on absurd prices (the share slice floors to 0) —
      // skip rather than emit a dust order.
      skipped.push({ ticker: p.ticker, reason: `allocation $${notionalPer.toFixed(2)} floors to ${shares} shares at $${p.entryPrice} — dust order skipped` });
      continue;
    }
    orders.push({
      ticker: p.ticker,
      strategy: p.strategy,
      entryPrice: p.entryPrice,
      shares,
      costBasis,
    });
  }

  const totalCost = roundCents(orders.reduce((s, o) => s + o.costBasis, 0));
  return { orders, skipped, totalCost };
}
