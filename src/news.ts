// ============================================================
// RSS requires no login, no API key, no scraping
// ============================================================

import axios from 'axios';
import { NewsArticle } from './types';

const NEWS_BASE = 'https://newsapi.org/v2';

const RSS_FEEDS = [
  { name: 'WSJ Markets', url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml' },
  { name: 'WSJ Economy', url: 'https://feeds.a.dj.com/rss/RSSWorldNews.xml' },
  { name: 'WSJ Tech', url: 'https://feeds.a.dj.com/rss/RSSWSJD.xml' },
  { name: 'MarketWatch Top', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
  { name: 'MarketWatch Markets', url: 'https://feeds.content.dowjones.io/public/rss/mw_marketpulse' },
];

// ── Parse RSS XML manually (no extra dependency needed) ────
function parseRSSItems(xml: string, sourceName: string): NewsArticle[] {
  const items: NewsArticle[] = [];
  const itemMatches = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];

  for (const item of itemMatches.slice(0, 8)) {
    const title = stripCDATA(extractTag(item, 'title'));
    const description = stripCDATA(extractTag(item, 'description'));
    const link = extractTag(item, 'link') || extractTag(item, 'guid');
    const pubDate = extractTag(item, 'pubDate');

    if (!title || title.length < 10) continue;

    // Only include recent articles (last 5 days)
    if (pubDate) {
      const age = Date.now() - new Date(pubDate).getTime();
      if (age > 5 * 24 * 60 * 60 * 1000) continue;
    }

    items.push({
      title,
      source: sourceName,
      publishedAt: pubDate || new Date().toISOString(),
      url: link || '',
      sentiment: classifySentiment(title + ' ' + description),
      summary: description ? description.substring(0, 200) : title,
    });
  }

  return items;
}

function extractTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? match[1].trim() : '';
}

function stripCDATA(str: string): string {
  return str.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

// ── Fetch all RSS feeds ────────────────────────────────────
async function fetchRSSFeeds(): Promise<NewsArticle[]> {
  const allArticles: NewsArticle[] = [];

  for (const feed of RSS_FEEDS) {
    try {
      const res = await axios.get(feed.url, {
        timeout: 8000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StockBot/1.0)' }
      });
      const articles = parseRSSItems(res.data, feed.name);
      allArticles.push(...articles);
    } catch (err: any) {
      console.warn(`[News] RSS fetch failed for ${feed.name}: ${err?.message}`);
    }
  }

  return allArticles;
}

// ── Filter RSS articles for a specific ticker ──────────────
function filterForTicker(articles: NewsArticle[], ticker: string, companyName: string): NewsArticle[] {
  const tickerLower = ticker.toLowerCase();
  const nameParts = companyName.toLowerCase().split(' ').filter(w => w.length > 3);

  return articles.filter(a => {
    const text = (a.title + ' ' + a.summary).toLowerCase();
    return text.includes(tickerLower) ||
      text.includes(`$${tickerLower}`) ||
      nameParts.some(part => text.includes(part));
  });
}

// ── NewsAPI for ticker-specific news ──────────────────────
export async function getStockNews(ticker: string, companyName: string): Promise<NewsArticle[]> {
  const apiKey = process.env.NEWS_API_KEY!;
  const results: NewsArticle[] = [];

  try {
    const rssArticles = await fetchRSSFeeds();
    const relevant = filterForTicker(rssArticles, ticker, companyName);
    results.push(...relevant.slice(0, 3));
  } catch (err: any) {
    console.warn('[News] RSS fetch error:', err?.message);
  }

  // 2. Fill remaining slots with NewsAPI
  try {
    const query = `${ticker} OR "${companyName}" stock`;
    const res = await axios.get(`${NEWS_BASE}/everything`, {
      params: {
        q: query,
        language: 'en',
        sortBy: 'publishedAt',
        pageSize: 8,
        from: getDateDaysAgo(5),
        apiKey,
      },
    });

    const newsApiArticles: NewsArticle[] = (res.data?.articles || [])
      .filter((a: any) => a.title && !a.title.includes('[Removed]'))
      .slice(0, 5)
      .map((a: any) => ({
        title: a.title,
        source: a.source?.name || 'Unknown',
        publishedAt: a.publishedAt,
        url: a.url,
        sentiment: classifySentiment(a.title + ' ' + (a.description || '')),
        summary: a.description || a.title,
      }));

    results.push(...newsApiArticles);
  } catch (err: any) {
    console.error(`[News] NewsAPI error for ${ticker}:`, err?.message);
  }

  // Deduplicate by title similarity and return top 5
  const seen = new Set<string>();
  return results.filter(a => {
    const key = a.title.substring(0, 40).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 5);
}

// ── Market-wide news (for weekly outlook) ─────────────────
export async function getMarketNews(): Promise<NewsArticle[]> {
  const results: NewsArticle[] = [];

  try {
    const rssArticles = await fetchRSSFeeds();
    results.push(...rssArticles.slice(0, 8));
  } catch (err: any) {
    console.warn('[News] Market RSS error:', err?.message);
  }

  // Supplement with NewsAPI
  try {
    const apiKey = process.env.NEWS_API_KEY!;
    const res = await axios.get(`${NEWS_BASE}/everything`, {
      params: {
        q: 'stock market OR S&P 500 OR Federal Reserve OR earnings',
        language: 'en',
        sortBy: 'publishedAt',
        pageSize: 6,
        from: getDateDaysAgo(2),
        apiKey,
      },
    });

    const articles: NewsArticle[] = (res.data?.articles || [])
      .filter((a: any) => a.title && !a.title.includes('[Removed]'))
      .slice(0, 4)
      .map((a: any) => ({
        title: a.title,
        source: a.source?.name || 'Unknown',
        publishedAt: a.publishedAt,
        url: a.url,
        sentiment: classifySentiment(a.title + ' ' + (a.description || '')),
        summary: a.description || a.title,
      }));

    results.push(...articles);
  } catch (err: any) {
    console.error('[News] Market NewsAPI error:', err?.message);
  }

  return results.slice(0, 10);
}

// ── Sentiment classifier ───────────────────────────────────
function classifySentiment(text: string): 'positive' | 'negative' | 'neutral' {
  const lower = text.toLowerCase();
  const positiveWords = [
    'surge', 'rally', 'gain', 'jump', 'beat', 'record', 'growth', 'profit',
    'upgrade', 'bullish', 'strong', 'outperform', 'buy', 'rise', 'soar',
    'boom', 'breakout', 'momentum', 'positive', 'optimistic', 'high', 'top',
    'exceeded', 'above', 'raised', 'boosted', 'accelerating',
  ];
  const negativeWords = [
    'drop', 'fall', 'decline', 'loss', 'miss', 'crash', 'sell', 'bearish',
    'downgrade', 'weak', 'underperform', 'cut', 'warning', 'risk', 'concern',
    'plunge', 'fear', 'recession', 'layoff', 'lawsuit', 'investigation',
    'below', 'missed', 'lowered', 'disappointing', 'slowing',
  ];

  const posCount = positiveWords.filter(w => lower.includes(w)).length;
  const negCount = negativeWords.filter(w => lower.includes(w)).length;

  if (posCount > negCount) return 'positive';
  if (negCount > posCount) return 'negative';
  return 'neutral';
}

function getDateDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
}

// ── Earnings dates (Finnhub) ───────────────────────────────
// Replaces the old getEarningsDates(string[]) FMP stub (nothing
// consumed it). Per-ticker lookup, fail-soft: any error or a
// missing key returns null and logs — a scan must never break
// just because earnings data is unavailable.
const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const FINNHUB_LOOKAHEAD_DAYS = 90;   // only care about the next ~quarter

// Free tier is 60 req/min. Serialize Finnhub calls and space them
// ~1.1s apart so a tight scan loop can never burst past the cap.
const FINNHUB_MIN_INTERVAL_MS = 1100;
let finnhubGate: Promise<void> = Promise.resolve();
let lastFinnhubStart = 0;

function fmtDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

async function throttleFinnhub(): Promise<void> {
  const wait = finnhubGate.then(async () => {
    const delay = Math.max(0, lastFinnhubStart + FINNHUB_MIN_INTERVAL_MS - Date.now());
    if (delay > 0) await new Promise(r => setTimeout(r, delay));
    lastFinnhubStart = Date.now();
  });
  finnhubGate = wait.catch(() => {});
  await wait;
}

// Returns the next upcoming earnings date (YYYY-MM-DD) within the
// look-ahead window, or null if none / on any error.
export async function getNextEarningsDate(ticker: string): Promise<string | null> {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    console.warn('[Earnings] FINNHUB_API_KEY not set — skipping earnings lookup');
    return null;
  }

  await throttleFinnhub();

  const today = new Date();
  const to = new Date();
  to.setDate(to.getDate() + FINNHUB_LOOKAHEAD_DAYS);
  const todayStr = fmtDate(today);

  try {
    const res = await axios.get(`${FINNHUB_BASE}/calendar/earnings`, {
      params: { from: todayStr, to: fmtDate(to), symbol: ticker, token: apiKey },
      timeout: 8000,
    });

    const upcoming: string[] = (res.data?.earningsCalendar || [])
      .map((e: any) => e?.date)
      .filter((d: any): d is string => typeof d === 'string' && d >= todayStr)
      .sort();

    return upcoming[0] || null;
  } catch (err: any) {
    const status = err?.response?.status;
    console.warn(`[Earnings] Finnhub lookup failed for ${ticker}: ${status ? `HTTP ${status} ` : ''}${err?.message}`);
    return null;
  }
}

// Translate a timeHorizon string ("1 week", "1-2 weeks", "3-5 days")
// into a day count. Falls back to 28 days when unparseable.
function parseHorizonDays(timeHorizon: string, pickType: 'OPTIONS_CALL' | 'STOCK_LONG'): number {
  const fallback = pickType === 'OPTIONS_CALL' ? 28 : 28; // ~swing window default
  if (!timeHorizon) return fallback;

  const nums = (timeHorizon.match(/\d+/g) || []).map(Number);
  if (nums.length === 0) return fallback;
  const maxNum = Math.max(...nums);

  const lower = timeHorizon.toLowerCase();
  if (lower.includes('month')) return maxNum * 30;
  if (lower.includes('week')) return maxNum * 7;
  if (lower.includes('day')) return maxNum;
  return fallback;
}

// Given a (possibly null) earnings date and the pick's stated horizon,
// compute the gap object that hangs off StockPick. Returns null when
// there is no usable upcoming date.
export function computeEarningsGap(
  earningsDate: string | null,
  timeHorizon: string,
  pickType: 'OPTIONS_CALL' | 'STOCK_LONG'
): { date: string; daysUntil: number; withinHorizon: boolean } | null {
  if (!earningsDate) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const ed = new Date(`${earningsDate}T00:00:00`);
  if (isNaN(ed.getTime())) return null;

  const daysUntil = Math.round((ed.getTime() - today.getTime()) / 86400000);
  if (daysUntil < 0) return null;

  const horizonDays = parseHorizonDays(timeHorizon, pickType);
  return { date: earningsDate, daysUntil, withinHorizon: daysUntil <= horizonDays };
}

// ── Key events this week ───────────────────────────────────
export function getKeyEventsThisWeek(): string[] {
  return [
    'Monday: Pre-market futures & weekend news digest',
    'Wednesday: FOMC minutes / Fed speeches (check calendar)',
    'Thursday: Weekly jobless claims (8:30am ET)',
    'Friday: Monthly jobs report (if first Friday of month)',
    'Check earnings calendar at earningswhispers.com for this week',
  ];
}
