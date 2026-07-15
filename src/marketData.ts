// ============================================================
// MARKET DATA — Yahoo Finance (no API key, no rate limits)
// Uses query1.finance.yahoo.com — free, unlimited, no login
// ============================================================

import axios from 'axios';
import { StockQuote, TechnicalIndicators, OptionsData } from './types';

const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
};

// ── Quote via Yahoo Finance v8 chart API ───────────────────
export async function getQuote(ticker: string): Promise<StockQuote | null> {
  try {
    // Get price data from chart endpoint
    const chartRes = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}`,
      {
        params: { interval: '1d', range: '5d' },
        headers: YF_HEADERS,
        timeout: 10000,
      }
    );

    const result = chartRes.data?.chart?.result?.[0];
    if (!result) return null;
    const meta = result.meta;
    if (!meta?.regularMarketPrice) return null;

    // Get fundamentals from quoteSummary endpoint
    let beta: number | null = null;
    let sector = 'Unknown';
    let pe: number | null = null;
    let marketCap = 0;
    let name = ticker;
    let avgVolume = meta.regularMarketVolume || 0;
    let week52High = meta.fiftyTwoWeekHigh || meta.regularMarketPrice * 1.3;
    let week52Low = meta.fiftyTwoWeekLow || meta.regularMarketPrice * 0.7;

    try {
      await sleep(200);
      const summaryRes = await axios.get(
        `https://query1.finance.yahoo.com/v11/finance/quoteSummary/${ticker}`,
        {
          params: { modules: 'summaryProfile,defaultKeyStatistics,summaryDetail,price' },
          headers: YF_HEADERS,
          timeout: 10000,
        }
      );

      const summary = summaryRes.data?.quoteSummary?.result?.[0];
      if (summary) {
        const profile = summary.summaryProfile;
        const keyStats = summary.defaultKeyStatistics;
        const detail = summary.summaryDetail;
        const price = summary.price;

        sector = profile?.sector || 'Unknown';
        beta = keyStats?.beta?.raw ?? null;
        pe = detail?.trailingPE?.raw ?? null;
        marketCap = price?.marketCap?.raw ?? 0;
        name = price?.longName || price?.shortName || ticker;
        avgVolume = detail?.averageVolume?.raw ?? meta.regularMarketVolume ?? 0;
        week52High = detail?.fiftyTwoWeekHigh?.raw ?? week52High;
        week52Low = detail?.fiftyTwoWeekLow?.raw ?? week52Low;
      }
    } catch {
      // quoteSummary failed — use chart meta fallbacks
    }

    const price = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose || price;
    const change = price - prevClose;
    const changePercent = (change / prevClose) * 100;

    // 5-day % move from the 5d closes this endpoint already returned
    // (used as a scan-time feature by the trade memory bank).
    const closes5d: number[] =
      result.indicators?.quote?.[0]?.close?.filter((c: any) => c != null) || [];
    const change5dPct = closes5d.length >= 2 && closes5d[0] > 0
      ? ((price - closes5d[0]) / closes5d[0]) * 100
      : null;

    return {
      ticker: ticker.toUpperCase(),
      name,
      price,
      change,
      changePercent,
      volume: meta.regularMarketVolume || 0,
      avgVolume,
      change5dPct,
      marketCap,
      pe,
      week52High,
      week52Low,
      beta,
      sector,
    };
  } catch (err: any) {
    console.error(`[MarketData] getQuote error for ${ticker}:`, err?.message);
    return null;
  }
}

// ── Pure technicals from a close series ─────────────────────
// Extracted so live (getTechnicals) and backtest (replayTechnicals)
// compute indicators from IDENTICAL code — no drift between them.
// `closes` must be ordered oldest→newest and contain no nulls.
export function computeTechnicals(ticker: string, closes: number[], price: number): TechnicalIndicators {
  const defaultResult: TechnicalIndicators = {
    ticker, rsi: null, macd: null, macdSignal: null,
    sma20: null, sma50: null, sma200: null,
    support: null, resistance: null, trend: 'neutral',
  };

  if (closes.length < 20) return defaultResult;

  const indicators = { ...defaultResult };

  // SMA calculations
  indicators.sma20 = sma(closes, 20);
  indicators.sma50 = sma(closes, 50);
  indicators.sma200 = sma(closes, 200);

  // RSI(14)
  indicators.rsi = rsi(closes, 14);

  // MACD(12,26,9)
  const { macd: macdLine, signal } = macd(closes, 12, 26, 9);
  indicators.macd = macdLine;
  indicators.macdSignal = signal;

  // Support/Resistance
  indicators.support = indicators.sma50 ?? price * 0.93;
  indicators.resistance = price * 1.10;

  // Trend
  const bullish = [
    indicators.rsi !== null && indicators.rsi > 50 && indicators.rsi < 72,
    indicators.macd !== null && indicators.macdSignal !== null && indicators.macd > indicators.macdSignal,
    indicators.sma20 !== null && indicators.sma50 !== null && indicators.sma20 > indicators.sma50,
    indicators.sma50 !== null && price > indicators.sma50,
  ].filter(Boolean).length;

  if (bullish >= 3) indicators.trend = 'bullish';
  else if (bullish <= 1) indicators.trend = 'bearish';
  else indicators.trend = 'neutral';

  return indicators;
}

// ── Technicals via Yahoo Finance historical data ───────────
export async function getTechnicals(ticker: string, price: number): Promise<TechnicalIndicators> {
  try {
    // Fetch 1y of daily closes to calculate indicators
    const res = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}`,
      {
        params: { interval: '1d', range: '1y' },
        headers: YF_HEADERS,
        timeout: 10000,
      }
    );

    const result = res.data?.chart?.result?.[0];
    if (!result) return computeTechnicals(ticker, [], price);

    const closes: number[] = result.indicators?.quote?.[0]?.close?.filter((c: any) => c != null) || [];
    return computeTechnicals(ticker, closes, price);
  } catch (err: any) {
    console.error(`[MarketData] getTechnicals error for ${ticker}:`, err?.message);
    return computeTechnicals(ticker, [], price);
  }
}

// ── Split detection ─────────────────────────────────────────
// Yahoo's chart endpoint retroactively split-adjusts its ENTIRE returned
// OHLC series to the scale in effect at query time — so a price captured
// and stored (entry/target/stop) before a later split silently drifts out
// of scale with every subsequent quote/bar fetch. This returns the
// cumulative multiplier needed to bring a RAW price fetched now back into
// the scale that was in effect on `sinceDate`, plus the events themselves
// (for logging/notes). ratio === 1 when no split occurred in the window.
export interface SplitEvent {
  date: string;        // YYYY-MM-DD, effective date
  ratioText: string;   // e.g. "4:1"
}

export interface SplitAdjustment {
  ratio: number;
  events: SplitEvent[];
}

export async function getSplitAdjustment(ticker: string, sinceDate: string): Promise<SplitAdjustment> {
  const none: SplitAdjustment = { ratio: 1, events: [] };
  try {
    const since = new Date(sinceDate);
    const now = new Date();
    if (isNaN(since.getTime()) || since.getTime() >= now.getTime()) return none;

    const days = Math.ceil((now.getTime() - since.getTime()) / 86400000) + 5;
    const range = days <= 30 ? '1mo' : days <= 90 ? '3mo' : days <= 180 ? '6mo'
      : days <= 365 ? '1y' : days <= 730 ? '2y' : '5y';

    const res = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}`,
      { params: { interval: '1d', range, events: 'splits' }, headers: YF_HEADERS, timeout: 10000 }
    );

    const splits = res.data?.chart?.result?.[0]?.events?.splits;
    if (!splits) return none;

    let ratio = 1;
    const events: SplitEvent[] = [];
    for (const s of Object.values<any>(splits)) {
      const eventMs = s.date * 1000;
      if (eventMs > since.getTime() && eventMs <= now.getTime()) {
        ratio *= s.numerator / s.denominator;
        events.push({
          date: new Date(eventMs).toISOString().slice(0, 10),
          ratioText: s.splitRatio || `${s.numerator}:${s.denominator}`,
        });
      }
    }
    return events.length ? { ratio, events } : none;
  } catch (err: any) {
    console.error(`[MarketData] getSplitAdjustment error for ${ticker}:`, err?.message);
    return none;
  }
}

// ── Close price on or before a given date (for benchmark comparisons) ──
export async function getCloseOnOrBefore(ticker: string, dateISO: string): Promise<number | null> {
  try {
    const target = new Date(dateISO);
    if (isNaN(target.getTime())) return null;
    const period1 = Math.floor(target.getTime() / 1000) - 86400 * 10; // covers long weekends/holidays
    const period2 = Math.floor(target.getTime() / 1000) + 86400;

    const res = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}`,
      { params: { interval: '1d', period1, period2 }, headers: YF_HEADERS, timeout: 10000 }
    );

    const result = res.data?.chart?.result?.[0];
    if (!result) return null;
    const ts: number[] = result.timestamp || [];
    const closes: number[] = result.indicators?.quote?.[0]?.close || [];

    let best: number | null = null;
    for (let i = 0; i < ts.length; i++) {
      if (ts[i] * 1000 <= target.getTime() && closes[i] != null) best = closes[i];
    }
    return best;
  } catch (err: any) {
    console.error(`[MarketData] getCloseOnOrBefore error for ${ticker}:`, err?.message);
    return null;
  }
}

// ── Technical indicator math ───────────────────────────────
function sma(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function rsi(closes: number[], period: number = 14): number | null {
  if (closes.length < period + 1) return null;
  const slice = closes.slice(-(period + 1));
  let gains = 0, losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const diff = slice[i] - slice[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function ema(closes: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [closes[0]];
  for (let i = 1; i < closes.length; i++) {
    result.push(closes[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function macd(closes: number[], fast = 12, slow = 26, signal = 9): { macd: number | null; signal: number | null } {
  if (closes.length < slow + signal) return { macd: null, signal: null };
  const fastEMA = ema(closes, fast);
  const slowEMA = ema(closes, slow);
  const macdLine = fastEMA.map((v, i) => v - slowEMA[i]);
  const signalLine = ema(macdLine.slice(slow - 1), signal);
  return {
    macd: macdLine[macdLine.length - 1],
    signal: signalLine[signalLine.length - 1],
  };
}

// ── Option strike selection (nearest increment, ATM-or-just-OTM) ──
// Nearest $1 increment for stocks <$20, $2.50 for $20-$50, $5 for $50+.
// Exported so the backtest's options-grading arm picks the SAME strike.
export function selectStrike(currentPrice: number): number {
  let strikeIncrement = 5;
  if (currentPrice < 20) strikeIncrement = 1;
  else if (currentPrice < 50) strikeIncrement = 2.5;
  return Math.ceil(currentPrice / strikeIncrement) * strikeIncrement;
}

// ── IV-by-price-tier model (approximates real momentum-stock IV ranges) ──
// 80% IV for small speculative names down to 30% for large stable ones.
// NOTE: this is a price-tier MODEL, not real option-chain IV. Exported so
// the backtest's options-grading arm uses the SAME assumption.
export function tieredIV(currentPrice: number): number {
  if (currentPrice < 10) return 0.80;        // 80% IV for small speculative stocks
  if (currentPrice < 20) return 0.65;        // 65% IV
  if (currentPrice < 50) return 0.50;        // 50% IV
  if (currentPrice < 150) return 0.40;       // 40% IV
  return 0.30;                               // 30% IV for large stable stocks
}

// ── Options estimate ───────────────────────────────────────
export function estimateOptionsData(
  ticker: string, currentPrice: number, targetPrice: number, weeksOut: number = 4
): OptionsData {
  const strikePrice = selectStrike(currentPrice);

  const expDate = getNextFriday(weeksOut);

  // Realistic premium estimate based on price tier (approximates real IV ranges)
  // Low-priced stocks ($3-15): ~$0.15-0.50 typical ATM premium
  // Mid-priced ($15-50): ~$0.50-2.00
  // Higher ($50-200): ~$1.50-5.00
  // Based on ~30-50% IV for typical momentum stocks, simplified Black-Scholes approx
  const ivEstimate = tieredIV(currentPrice);

  // Simplified ATM call premium: S * IV * sqrt(T/365) * 0.4
  // where T = days to expiration, 0.4 ≈ N(d1) for ATM option
  const daysToExp = weeksOut * 7;
  const rawPremium = currentPrice * ivEstimate * Math.sqrt(daysToExp / 365) * 0.4;

  // Round to nearest $0.05 (options tick size)
  const premium = Math.max(0.05, Math.round(rawPremium / 0.05) * 0.05);
  const contractCost = Math.round(premium * 100);
  const breakeven = parseFloat((strikePrice + premium).toFixed(2));
  const upside = ((targetPrice - breakeven) / breakeven * 100).toFixed(1);

  return {
    ticker, expirationDate: expDate, strikePrice, optionType: 'CALL',
    premium, breakeven,
    maxGain: `~${upside}% if ${ticker} hits $${targetPrice}`,
    maxLoss: `$${contractCost} per contract (100% of premium)`,
    impliedVolatility: ivEstimate,
    delta: null,
    volume: null,
    openInterest: null,
    liquidityNote: '⚠️ Estimated contract — no live volume/OI data; verify liquidity in Robinhood',
    rationale: `Buy-to-open ${ticker} $${strikePrice}C expiring ${expDate}. Cost ~$${contractCost}/contract. Breakeven at $${breakeven}.`,
  };
}

function getNextFriday(weeksOut: number): string {
  const date = new Date();
  const day = date.getDay();
  const daysToFriday = (5 - day + 7) % 7 || 7;
  date.setDate(date.getDate() + daysToFriday + (weeksOut - 1) * 7);
  return date.toISOString().split('T')[0];
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Wide ticker universe ───────────────────────────────────
// ~125 names across 11 sectors: a mix of established large-caps and
// speculative small-caps for broad signal coverage. A dynamic screener
// is flagged to eventually feed this list; for now it's curated.
export function getCandidateTickers(): string[] {
  return [
    // Mega cap tech
    'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA',

    // Semiconductors
    'AMD', 'AVGO', 'MU', 'MRVL', 'ARM', 'SMCI', 'ALAB', 'TSM',
    'QCOM', 'TXN', 'ADI', 'NXPI', 'ON', 'LRCX', 'AMAT', 'KLAC',
    'ACMR', 'WOLF', 'INTC',

    // Software & cloud
    'PLTR', 'SNOW', 'DDOG', 'NET', 'CRWD', 'ZS', 'PANW', 'NOW',
    'PATH', 'BILL', 'MDB', 'TEAM', 'CRM', 'ORCL', 'ADBE', 'SHOP',
    'TWLO', 'OKTA',

    // Fintech & financials
    'COIN', 'HOOD', 'SOFI', 'AFRM', 'UPST', 'LC', 'JPM', 'GS',
    'BAC', 'V', 'MA', 'PYPL', 'SQ', 'NU',

    // Consumer & retail
    'NKE', 'LULU', 'ONON', 'CROX', 'SBUX', 'MCD', 'CMG', 'COST',
    'WMT', 'TGT', 'DKNG', 'ABNB', 'CELH', 'ELF',

    // EV, autos & energy
    'RIVN', 'LCID', 'NIO', 'XPEV', 'F', 'GM', 'XOM', 'CVX',
    'OXY', 'AR', 'ENPH', 'FSLR', 'PLUG', 'RUN',

    // Quantum & frontier compute
    'IONQ', 'QUBT', 'RGTI', 'BBAI', 'QBTS',

    // Biotech & pharma
    'MRNA', 'NVAX', 'CRSP', 'BEAM', 'NTLA', 'RXRX', 'LLY', 'PFE',
    'BNTX', 'VRTX', 'REGN', 'AMGN',

    // Aerospace, mobility & robotics
    'ACHR', 'JOBY', 'UBER', 'LYFT', 'LAZR', 'OUST', 'RKLB', 'LUNR',

    // Media, internet & comms
    'SNAP', 'RBLX', 'PINS', 'SPOT', 'NFLX', 'DIS', 'ROKU', 'RDDT',

    // Industrials & materials
    'CAT', 'DE', 'BA', 'GE', 'FCX', 'CLF',

    // Broad ETFs (liquid options, trend/context)
    'SPY', 'QQQ', 'IWM', 'DIA', 'SMH', 'ARKK', 'XLF', 'XLE',
  ];
}
