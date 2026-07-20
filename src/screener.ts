// ============================================================
// DYNAMIC SCREENER — pulls today's market movers from FMP and
// merges them into the candidate universe, so the bot scans
// what's actually active instead of only a hardcoded list.
// ------------------------------------------------------------
// IMPORTANT: movers are added to the POOL, not auto-picked.
// They still must pass the two strategies (pullback / breakout
// with its overextension filter). A "biggest gainer" that's
// already up 20% gets rejected downstream — by design. The
// screener widens what the bot SEES, not what it BUYS.
// ============================================================

import axios from 'axios';

// FMP migrated to /stable/; we try that first, then fall back to
// the legacy /api/v3/ path your dashboard already uses successfully.
const STABLE = 'https://financialmodelingprep.com/stable';
const LEGACY = 'https://financialmodelingprep.com/api/v3';

interface Mover { symbol: string; price?: number; changesPercentage?: number; }

// Junk filters so the screener doesn't drag in untradeable names.
const MIN_PRICE = 5;        // below this, spreads/liquidity are garbage
const MAX_PRICE = 2000;
const MAX_DAY_GAIN = 6;     // skip already-spiked names (the 0-for-14 trap)
const MAX_PER_LIST = 25;    // take the top N from each FMP list

function normalizePct(v: any): number {
  // FMP sometimes returns "12.34%" as a string, sometimes a number
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return parseFloat(v.replace('%', '')) || 0;
  return 0;
}

async function fetchList(kind: 'gainers' | 'actives'): Promise<Mover[]> {
  const key = process.env.FMP_API_KEY;
  if (!key) return [];

  const stablePath = kind === 'gainers' ? 'biggest-gainers' : 'most-actives';
  const legacyPath = kind === 'gainers' ? 'stock_market/gainers' : 'stock_market/actives';

  // Try stable first, then legacy. Either failing just yields [].
  for (const url of [
    `${STABLE}/${stablePath}?apikey=${key}`,
    `${LEGACY}/${legacyPath}?apikey=${key}`,
  ]) {
    try {
      const res = await axios.get(url, { timeout: 12000 });
      if (Array.isArray(res.data) && res.data.length) {
        return res.data as Mover[];
      }
    } catch {
      // try the next URL format
    }
  }
  console.warn(`[Screener] No data returned for ${kind}`);
  return [];
}

// Returns a deduped list of mover symbols that pass the junk filters.
export async function getDynamicMovers(): Promise<string[]> {
  if (!process.env.FMP_API_KEY) {
    console.log('[Screener] No FMP_API_KEY — skipping dynamic movers.');
    return [];
  }

  console.log('[Screener] Fetching today\'s movers (gainers + most-active)...');
  const [gainers, actives] = await Promise.all([
    fetchList('gainers'),
    fetchList('actives'),
  ]);

  const seen = new Set<string>();
  const out: string[] = [];

  const consider = (list: Mover[]) => {
    for (const m of list.slice(0, MAX_PER_LIST)) {
      const sym = (m.symbol || '').toUpperCase().trim();
      if (!sym || seen.has(sym)) continue;
      // basic sanity filters
      if (!/^[A-Z]{1,5}$/.test(sym)) continue;          // skip weird tickers, warrants, etc.
      if (m.price != null && (m.price < MIN_PRICE || m.price > MAX_PRICE)) continue;
      if (normalizePct(m.changesPercentage) > MAX_DAY_GAIN) continue; // already spiked — skip
      seen.add(sym);
      out.push(sym);
    }
  };

  consider(actives);   // liquidity-backed first
  consider(gainers);   // then gainers that aren't already overextended

  console.log(`[Screener] ${out.length} live movers passed filters`);
  return out;
}