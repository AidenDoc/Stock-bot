// ============================================================
// CHART DATA — fetches daily price history for open positions
// and writes data/history.json for the dashboard to read.
// ------------------------------------------------------------
// Runs server-side (Node), so there's no browser CORS limit.
// Uses Yahoo Finance's free chart endpoint — no API key needed.
// If Yahoo is ever blocked in your environment, swap fetchSeries
// for the Stooq fallback noted at the bottom of this file.
// ============================================================

import fs from 'fs';
import path from 'path';
import axios from 'axios';

const DATA_DIR = path.join(process.cwd(), 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const PORTFOLIO_FILE = path.join(DATA_DIR, 'portfolio.json');

interface Series { dates: string[]; closes: number[]; }
type HistoryMap = Record<string, Series>;

// Pull open (non-closed) tickers straight from the portfolio file
// so a no-arg call always covers everything currently in play.
function openTickersFromPortfolio(): string[] {
  try {
    if (!fs.existsSync(PORTFOLIO_FILE)) return [];
    const pf = JSON.parse(fs.readFileSync(PORTFOLIO_FILE, 'utf-8'));
    if (!Array.isArray(pf)) return [];
    return pf.filter((p: any) => p && p.status !== 'CLOSED').map((p: any) => p.ticker);
  } catch {
    return [];
  }
}

// ~2 years of daily closes from Yahoo's free chart endpoint.
async function fetchSeries(ticker: string): Promise<Series | null> {
  try {
    const period2 = Math.floor(Date.now() / 1000);
    const period1 = period2 - 2 * 365 * 24 * 60 * 60; // 2 years back
    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
      `?period1=${period1}&period2=${period2}&interval=1d`;
    const res = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }, // Yahoo rejects empty UAs
      timeout: 15000,
    });

    const result = res.data?.chart?.result?.[0];
    if (!result) return null;

    const ts: number[] = result.timestamp || [];
    const rawCloses: (number | null)[] = result.indicators?.quote?.[0]?.close || [];

    const dates: string[] = [];
    const closes: number[] = [];
    for (let i = 0; i < ts.length; i++) {
      const c = rawCloses[i];
      if (c == null) continue; // skip gaps/holidays
      dates.push(new Date(ts[i] * 1000).toISOString().split('T')[0]);
      closes.push(parseFloat(c.toFixed(2)));
    }

    return closes.length > 1 ? { dates, closes } : null;
  } catch (err: any) {
    console.error(`[Charts] ${ticker} history error:`, err?.message);
    return null;
  }
}

// Fetch history for the given tickers (or all open positions if none
// passed) and overwrite data/history.json.
export async function updateChartData(tickers?: string[]): Promise<void> {
  const list = [...new Set((tickers && tickers.length ? tickers : openTickersFromPortfolio()))]
    .filter(Boolean);

  if (list.length === 0) {
    console.log('[Charts] No open tickers — skipping history fetch.');
    return;
  }

  console.log(`[Charts] Fetching ${list.length} price histories...`);
  const map: HistoryMap = {};

  for (const ticker of list) {
    const series = await fetchSeries(ticker);
    if (series) map[ticker] = series;
    await new Promise(r => setTimeout(r, 300)); // gentle pacing
  }

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    HISTORY_FILE,
    JSON.stringify({ updatedAt: new Date().toISOString(), data: map }, null, 2)
  );
  console.log(`[Charts] Wrote history for ${Object.keys(map).length}/${list.length} tickers`);
}

// ── Stooq fallback (if Yahoo is ever blocked) ───────────────
// Replace the URL/parse in fetchSeries with:
//   const url = `https://stooq.com/q/d/l/?s=${ticker.toLowerCase()}.us&i=d`;
//   const res = await axios.get(url, { timeout: 15000 });   // CSV text
//   // parse lines: Date,Open,High,Low,Close,Volume  → take last ~65 rows