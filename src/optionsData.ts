// ============================================================
// OPTIONS DATA — Alpaca real options chain pricing
// ============================================================

import axios from 'axios';
import { OptionsData } from './types';

const bs = require('black-scholes');

const ALPACA_DATA_BASE = 'https://data.alpaca.markets';

function alpacaHeaders() {
  return {
    'APCA-API-KEY-ID': process.env.ALPACA_API_KEY!,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY!,
    'Accept': 'application/json',
  };
}

export async function getRealOptionsData(
  ticker: string,
  currentPrice: number,
  targetPrice: number,
  expiration: string
): Promise<OptionsData | null> {
  try {
    const res = await axios.get(
      `${ALPACA_DATA_BASE}/v1beta1/options/snapshots/${ticker}`,
      {
        params: { feed: 'indicative', limit: 1000 },
        headers: alpacaHeaders(),
        timeout: 12000,
      }
    );

    const snapshots = res.data?.snapshots;
    if (!snapshots || Object.keys(snapshots).length === 0) {
      console.warn(`[OptionsData] No chain returned for ${ticker}`);
      return null;
    }

    let best: { symbol: string; strike: number; ask: number; bid: number; mark: number; iv: number | null; delta: number | null; volume: number | null; openInterest: number | null } | null = null;

    for (const [symbol, snap] of Object.entries(snapshots) as any) {
      const match = symbol.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
      if (!match) continue;
      const [, , , cp, strikePart] = match;
      if (cp !== 'C') continue;

      const strike = parseInt(strikePart) / 1000;
      // Want genuinely OTM call: strike ABOVE current price (1% to 12% above)
      if (strike < currentPrice * 1.01) continue;  // skip ITM/ATM
      if (strike > currentPrice * 1.12) continue;   // skip too-far OTM

      const quote = snap.latestQuote;
      const greeks = snap.greeks;
      if (!quote) continue;

      const ask = quote.ap ?? 0;
      const bid = quote.bp ?? 0;
      // Skip stale/one-sided quotes: need BOTH bid and ask present.
      // A missing side means the snapshot is stale and will mismatch Robinhood.
      if (ask <= 0 || bid <= 0) continue;
      const mark = (ask + bid) / 2;
      // Skip absurdly wide spreads (>40% of mid) — illiquid, unreliable quote
      if ((ask - bid) / mark > 0.40) continue;

      // Alpaca snapshot: dailyBar.v = today's volume; openInterest may be present
      const vol = snap.dailyBar?.v ?? snap.latestTrade?.s ?? null;
      const oi = snap.openInterest ?? null;

      // Prefer strike closest to ~5% above current (standard momentum-call target)
      const idealStrike = currentPrice * 1.05;
      if (!best || Math.abs(strike - idealStrike) < Math.abs(best.strike - idealStrike)) {
        best = {
          symbol, strike, ask, bid, mark,
          iv: snap.impliedVolatility ?? null,
          delta: greeks?.delta ?? null,
          volume: vol,
          openInterest: oi,
        };
      }
    }

    if (!best) {
      console.warn(`[OptionsData] No suitable call found for ${ticker}`);
      return null;
    }

    let liquidityNote = '';
    const vol = best.volume ?? 0;
    const oi = best.openInterest ?? 0;
    if (oi > 0 && oi < 100) {
      liquidityNote = `⚠️ LOW open interest (${oi}) — thin contract, expect wide spreads & slippage`;
    } else if (vol > 0 && vol < 50) {
      liquidityNote = `⚠️ LOW volume (${vol} today) — may be hard to exit at a fair price`;
    } else if (oi === 0 && vol === 0) {
      liquidityNote = `⚠️ No volume/OI data available — verify liquidity in Robinhood before trading`;
    } else {
      liquidityNote = `✅ Liquidity OK (vol ${vol}, OI ${oi})`;
    }

    // Use the bid/ask MIDPOINT as the estimated fill price — this is closest
    // to what Robinhood actually fills at, vs the raw ask which overstates cost.
    const fillPrice = parseFloat(best.mark.toFixed(2));
    const breakeven = parseFloat((best.strike + fillPrice).toFixed(2));
    const contractCost = Math.round(fillPrice * 100);

    // ── Dual OPTION P&L estimate ──────────────────────────────
    // You typically exit 1-2 days after the stock hits target, so the option
    // still has time value left. We model TWO scenarios:
    //
    // (A) "With time left": Black-Scholes value of the call when the stock
    //     reaches the target with ~5 days still to expiration. This is the
    //     realistic take-profit value since you don't hold to expiry.
    // (B) "At expiration": pure intrinsic value max(0, target - strike).
    //     This is the floor — what it's worth if you held all the way.
    const RISK_FREE = 0.045; // ~current short-term rate
    const ivDecimal = best.iv ?? 0.60; // use real IV if available, else 60%

    // Days from now until expiration, then assume you sell with ~5 days left
    const msToExp = new Date(expiration).getTime() - Date.now();
    const daysToExp = Math.max(1, msToExp / (1000 * 60 * 60 * 24));
    const daysLeftAtSale = Math.min(daysToExp, 5); // ~5 days left when you exit
    const yearsLeftAtSale = daysLeftAtSale / 365;

    // (A) Black-Scholes value at target with time remaining
    let valueWithTime = fillPrice;
    try {
      valueWithTime = bs.blackScholes(targetPrice, best.strike, yearsLeftAtSale, ivDecimal, RISK_FREE, 'call');
      if (!isFinite(valueWithTime) || valueWithTime < 0) valueWithTime = 0;
    } catch {
      valueWithTime = Math.max(0, targetPrice - best.strike);
    }
    const pnlTimePct = fillPrice > 0 ? ((valueWithTime - fillPrice) / fillPrice) * 100 : 0;
    const pnlTimeDollar = Math.round((valueWithTime - fillPrice) * 100);
    const tSign = pnlTimePct >= 0 ? '+' : '';

    // (B) Expiration-day intrinsic value (floor)
    const intrinsicAtTarget = Math.max(0, targetPrice - best.strike);
    const pnlExpPct = fillPrice > 0 ? ((intrinsicAtTarget - fillPrice) / fillPrice) * 100 : 0;
    const pnlExpDollar = Math.round((intrinsicAtTarget - fillPrice) * 100);
    const eSign = pnlExpPct >= 0 ? '+' : '';

    const maxGainStr =
      `if ${ticker} hits $${targetPrice}:\n` +
      `   • Sold w/ ~${daysLeftAtSale.toFixed(0)}d left: ${tSign}${pnlTimePct.toFixed(0)}% (${tSign}$${pnlTimeDollar}/contract)\n` +
      `   • Held to expiration: ${eSign}${pnlExpPct.toFixed(0)}% (${eSign}$${pnlExpDollar}/contract)`;

    return {
      ticker,
      expirationDate: expiration,
      strikePrice: best.strike,
      optionType: 'CALL',
      premium: fillPrice,
      breakeven,
      maxGain: maxGainStr,
      maxLoss: `$${contractCost} per contract (100% of premium)`,
      impliedVolatility: best.iv,
      delta: best.delta,
      volume: best.volume,
      openInterest: best.openInterest,
      liquidityNote,
      rationale: `REAL Alpaca quote: ${ticker} $${best.strike}C ${expiration}. Bid $${best.bid.toFixed(2)} / Ask $${best.ask.toFixed(2)}. Breakeven $${breakeven}.`,
    };
  } catch (err: any) {
    console.error(`[OptionsData] Alpaca error for ${ticker}:`, err?.response?.status, err?.message);
    return null;
  }
}