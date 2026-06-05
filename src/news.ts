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

// ── Earnings dates ─────────────────────────────────────────
export async function getEarningsDates(tickers: string[]): Promise<Record<string, string>> {
  return {}; // FMP endpoint removed, would need paid plan
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
