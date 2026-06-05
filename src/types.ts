// ============================================================
// STOCK BOT — TYPE DEFINITIONS
// ============================================================

export interface StockQuote {
  ticker: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  avgVolume: number;
  marketCap: number;
  pe: number | null;
  week52High: number;
  week52Low: number;
  beta: number | null;
  sector: string;
}

export interface NewsArticle {
  title: string;
  source: string;
  publishedAt: string;
  url: string;
  sentiment: 'positive' | 'negative' | 'neutral';
  summary: string;
}

export interface TechnicalIndicators {
  ticker: string;
  rsi: number | null;         // 0-100, >70 overbought, <30 oversold
  macd: number | null;        // MACD line
  macdSignal: number | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  support: number | null;
  resistance: number | null;
  trend: 'bullish' | 'bearish' | 'neutral';
}

export interface OptionsData {
  ticker: string;
  expirationDate: string;      // e.g. "2025-06-20"
  strikePrice: number;
  optionType: 'CALL' | 'PUT';
  premium: number;             // estimated cost per contract / 100
  breakeven: number;
  maxGain: string;             // e.g. "unlimited" or "X%"
  maxLoss: string;             // e.g. "$350 per contract"
  impliedVolatility: number | null;
  delta: number | null;
  volume: number | null;          // contracts traded today (liquidity)
  openInterest: number | null;    // open contracts (liquidity)
  liquidityNote: string;          // human-readable liquidity warning
  rationale: string;
}

export interface StockPick {
  ticker: string;
  name: string;
  pickType: 'OPTIONS_CALL' | 'STOCK_LONG';
  currentPrice: number;
  entryZone: { low: number; high: number };
  targetPrice: number;
  stopLoss: number;
  riskRewardRatio: number;
  timeHorizon: string;         // e.g. "1-2 weeks", "3-5 days"
  confidenceScore: number;     // 0-100
  catalysts: string[];
  risks: string[];
  summary: string;
  technicals: TechnicalIndicators;
  news: NewsArticle[];
  options?: OptionsData;       // only for OPTIONS_CALL picks
  sector: string;
  addedAt: string;             // ISO timestamp
  voteBreakdown?: string;      // e.g. "✅ CLAUDE (82) | ❌ GROQ (45)"
}

export interface WeeklyReport {
  weekOf: string;              // e.g. "May 26, 2025"
  optionsPicks: StockPick[];   // always 3
  stockPicks: StockPick[];     // 3-5 regular stocks
  marketOutlook: string;
  keyEventsThisWeek: string[];
  generatedAt: string;
}

export interface DailyUpdate {
  date: string;
  ticker: string;
  currentPrice: number;
  entryPrice: number;
  targetPrice: number;
  stopLoss: number;
  pnlPercent: number;
  status: 'WATCHING' | 'ENTERED' | 'TARGET_HIT' | 'STOP_HIT' | 'CLOSED';
  update: string;
  action: 'ENTER_NOW' | 'HOLD' | 'TRIM' | 'EXIT' | 'WAIT';
}

export interface PortfolioPosition {
  ticker: string;
  pickType: 'OPTIONS_CALL' | 'STOCK_LONG';
  entryPrice: number;
  currentPrice: number;
  targetPrice: number;
  stopLoss: number;
  addedDate: string;
  status: 'WATCHING' | 'ACTIVE' | 'CLOSED';
  pnlPercent: number;
  notes: string;
}
