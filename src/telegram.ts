// ============================================================
// TELEGRAM NOTIFIER — formatted alerts for stock bot
// ============================================================

import TelegramBot from 'node-telegram-bot-api';
import { StockPick, WeeklyReport, DailyUpdate, NewsArticle } from './types';
import fs from 'fs';
import path from 'path';

let bot: TelegramBot;

const PORTFOLIO_FILE = path.join(process.cwd(), 'data', 'portfolio.json');
const SCORECARD_FILE = path.join(process.cwd(), 'data', 'scorecard.json');

export function initTelegram(): TelegramBot {
  const token = process.env.STOCK_TELEGRAM_BOT_TOKEN!;
  bot = new TelegramBot(token, { polling: false });
  console.log('[Telegram] Stock bot initialized');
  return bot;
}

function getChatId(): string {
  return process.env.STOCK_TELEGRAM_CHAT_ID!;
}

function loadJSON<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}

async function send(message: string, parseMode: 'HTML' | 'Markdown' = 'HTML'): Promise<void> {
  try {
    await bot.sendMessage(getChatId(), message, {
      parse_mode: parseMode,
      disable_web_page_preview: true,
    });
    await sleep(500);
  } catch (err: any) {
    console.error('[Telegram] Send error:', err?.message);
  }
}

// Reply to a specific chat (used by command handlers)
async function reply(chatId: number | string, message: string): Promise<void> {
  try {
    await bot.sendMessage(chatId, message, {
      parse_mode: 'HTML',
      disable_web_page_preview: false, // allow the dashboard link preview
    });
  } catch (err: any) {
    console.error('[Telegram] Reply error:', err?.message);
  }
}

// ── Command listener ────────────────────────────────────────
// Call this ONLY from the long-running daemon (not from one-off
// CLI runs) so two pollers never fight over the same bot token.
export function registerCommands(): void {
  const ownerId = String(getChatId());
  const dashUrl = process.env.DASHBOARD_URL || 'http://159.223.189.172:8080';

  bot.startPolling();

  bot.onText(/^\/(start|help)/, async (msg) => {
    if (String(msg.chat.id) !== ownerId) return;
    await reply(msg.chat.id, [
      '🤖 <b>Stock Bot — Commands</b>',
      '',
      '/dashboard — open your live dashboard',
      '/open — current open picks',
      '/record — win / loss record',
      '/help — this list',
    ].join('\n'));
  });

  bot.onText(/^\/dashboard/, async (msg) => {
    if (String(msg.chat.id) !== ownerId) return;
    await reply(msg.chat.id, [
      '📊 <b>Your live dashboard</b>',
      '',
      `<a href="${dashUrl}">${dashUrl}</a>`,
      '',
      'Tap to open, then log in with your dashboard username and password.',
    ].join('\n'));
  });

  bot.onText(/^\/open/, async (msg) => {
    if (String(msg.chat.id) !== ownerId) return;
    const pf = loadJSON<any[]>(PORTFOLIO_FILE, []);
    const open = (Array.isArray(pf) ? pf : []).filter(p => p.status !== 'CLOSED');
    if (open.length === 0) {
      await reply(msg.chat.id, '📭 <b>Open positions</b>\n\nNone right now. The next scan runs Monday 8:00 AM ET.');
      return;
    }
    const fmtLine = (p: any) => {
      const px = p.currentPrice ?? p.entryPrice;
      const pnl = p.entryPrice ? ((px - p.entryPrice) / p.entryPrice) * 100 : 0;
      const dot = pnl >= 0 ? '🟢' : '🔴';
      const sign = pnl >= 0 ? '+' : '';
      return `${dot} <b>${p.ticker}</b> ${sign}${pnl.toFixed(1)}% — $${Number(px).toFixed(2)} (tgt $${Number(p.targetPrice).toFixed(2)})`;
    };
    const opts = open.filter(p => p.pickType === 'OPTIONS_CALL');
    const stocks = open.filter(p => p.pickType !== 'OPTIONS_CALL');
    const lines = ['📌 <b>Open positions</b>', ''];
    if (opts.length) { lines.push('<b>Options calls:</b>'); opts.forEach(p => lines.push(fmtLine(p))); lines.push(''); }
    if (stocks.length) { lines.push('<b>Stock picks:</b>'); stocks.forEach(p => lines.push(fmtLine(p))); }
    lines.push('');
    lines.push('<i>Prices as of the last daily check.</i>');
    await reply(msg.chat.id, lines.join('\n'));
  });

  bot.onText(/^\/record/, async (msg) => {
    if (String(msg.chat.id) !== ownerId) return;
    const sc = loadJSON<{ graded: any[] }>(SCORECARD_FILE, { graded: [] });
    const graded = (sc.graded || []).filter(g => g.outcome !== 'OPEN');
    const wins = graded.filter(g => g.outcome === 'WIN').length;
    const losses = graded.filter(g => g.outcome === 'LOSS').length;
    const total = wins + losses;
    if (total === 0) {
      await reply(msg.chat.id, '📊 <b>Record</b>\n\nNo graded picks yet — each pick grades 5 days after it is made.');
      return;
    }
    const winRate = ((wins / total) * 100).toFixed(0);
    const avg = (graded.reduce((s, g) => s + (g.stockReturnPct || 0), 0) / total).toFixed(1);
    await reply(msg.chat.id, [
      '📊 <b>Record</b>',
      '',
      `${wins}W / ${losses}L (${winRate}% win rate) across ${total} graded picks.`,
      `Avg stock move per pick: ${Number(avg) >= 0 ? '+' : ''}${avg}%`,
      '',
      '<i>Outcomes track the underlying stock vs. target/stop.</i>',
    ].join('\n'));
  });

  bot.on('polling_error', (err: any) => {
    console.error('[Telegram] Polling error:', err?.message);
  });

  console.log('[Telegram] Command handlers registered (polling on)');
}

export async function sendWeeklyOptionsReport(report: WeeklyReport): Promise<void> {
  const header = [
    `📅 <b>WEEKLY OPTIONS PICKS — ${report.weekOf}</b>`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `🌍 <b>Market Outlook:</b>`,
    report.marketOutlook,
    ``,
    `📌 <b>Key Events This Week:</b>`,
    report.keyEventsThisWeek.map(e => `• ${e}`).join('\n'),
  ].join('\n');

  await send(header);
  await sleep(1000);

  for (let i = 0; i < report.optionsPicks.length; i++) {
    const pick = report.optionsPicks[i];
    await send(formatOptionsPick(pick, i + 1));
    await sleep(1500);
  }
}

export async function sendWeeklyStockReport(report: WeeklyReport): Promise<void> {
  const header = [
    `📊 <b>WEEKLY STOCK PICKS — ${report.weekOf}</b>`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    `Regular swing trades for Robinhood 📱`,
  ].join('\n');

  await send(header);
  await sleep(1000);

  for (let i = 0; i < report.stockPicks.length; i++) {
    const pick = report.stockPicks[i];
    await send(formatStockPick(pick, i + 1));
    await sleep(1500);
  }
}

export async function sendDailyUpdate(updates: DailyUpdate[]): Promise<void> {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'short', day: 'numeric'
  });

  let msg = `📈 <b>DAILY UPDATE — ${today}</b>\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  if (updates.length === 0) {
    msg += '😴 No active positions to update.';
  } else {
    for (const u of updates) {
      const emoji = getActionEmoji(u.action);
      const pnlSign = u.pnlPercent >= 0 ? '+' : '';
      const pnlEmoji = u.pnlPercent >= 0 ? '🟢' : '🔴';
      msg += `${emoji} <b>${u.ticker}</b> ${pnlEmoji} <b>${pnlSign}${u.pnlPercent.toFixed(1)}%</b>\n`;
      msg += `   💰 $${u.currentPrice.toFixed(2)} | Entry: $${u.entryPrice.toFixed(2)}\n`;
      msg += `   🎯 Target: $${u.targetPrice.toFixed(2)} | 🛑 Stop: $${u.stopLoss.toFixed(2)}\n`;
      msg += `   📣 <b>${u.action}:</b> ${u.update}\n\n`;
    }
  }

  await send(msg);
}

export async function sendTargetHitAlert(ticker: string, price: number, gainPercent: number): Promise<void> {
  const msg = [
    `🎯🎯🎯 <b>TARGET HIT!</b> 🎯🎯🎯`,
    ``,
    `<b>${ticker}</b> reached the target price!`,
    `💰 Current Price: <b>$${price.toFixed(2)}</b>`,
    `📈 Gain: <b>+${gainPercent.toFixed(1)}%</b>`,
    ``,
    `✅ <b>ACTION: CONSIDER TAKING PROFITS</b>`,
    `Open Robinhood → ${ticker} → Sell`,
    ``,
    `You can trim 50% now and let the rest ride, or close fully.`,
  ].join('\n');

  await send(msg);
}

export async function sendStopLossAlert(ticker: string, price: number, stopPrice: number): Promise<void> {
  const msg = [
    `⚠️⚠️ <b>STOP LOSS WARNING</b> ⚠️⚠️`,
    ``,
    `<b>${ticker}</b> is approaching your stop loss!`,
    `💰 Current: <b>$${price.toFixed(2)}</b>`,
    `🛑 Stop Loss: <b>$${stopPrice.toFixed(2)}</b>`,
    ``,
    `⛔ <b>ACTION: REVIEW POSITION</b>`,
    `Consider exiting to protect capital.`,
  ].join('\n');

  await send(msg);
}

export async function sendTradeSignal(pick: StockPick): Promise<void> {
  const typeEmoji = pick.pickType === 'OPTIONS_CALL' ? '📞' : '📈';
  const msg = [
    `${typeEmoji} <b>TRADE SIGNAL: ${pick.ticker}</b>`,
    ``,
    pick.summary,
    ``,
    `<b>Entry Zone:</b> $${pick.entryZone.low.toFixed(2)} – $${pick.entryZone.high.toFixed(2)}`,
    `<b>Target:</b> $${pick.targetPrice.toFixed(2)}`,
    `<b>Stop:</b> $${pick.stopLoss.toFixed(2)}`,
    `<b>R/R:</b> ${pick.riskRewardRatio.toFixed(1)}:1`,
  ].join('\n');

  await send(msg);
}

export async function sendStartupMessage(): Promise<void> {
  const msg = [
    `🤖 <b>Stock Bot Online!</b>`,
    ``,
    `✅ Market data connected`,
    `✅ AI analyst ready (Claude)`,
    `✅ Telegram notifications active`,
    ``,
    `📅 Weekly picks: Every Monday 8:00 AM ET`,
    `📊 Daily updates: Weekdays 9:00 AM ET`,
    `🔔 Instant alerts: Target hits & stop warnings`,
    ``,
    `💬 Try /dashboard, /open, or /record`,
    ``,
    `<i>Use Robinhood to execute trades.</i>`,
  ].join('\n');

  await send(msg);
}

export async function sendErrorAlert(component: string, error: string): Promise<void> {
  await send(`⚠️ <b>Stock Bot Error</b>\n<b>${component}:</b> ${error}`);
}

export async function sendScorecard(
  record: { total: number; wins: number; losses: number; winRate: number; avgStockReturn: number; optionsRecord: { wins: number; losses: number }; stockRecord: { wins: number; losses: number } },
  recent: { ticker: string; pickType: string; outcome: string; stockReturnPct: number; note: string }[]
): Promise<void> {
  if (record.total === 0 && recent.length === 0) {
    await send('📊 <b>SCORECARD</b>\n\nNo picks old enough to grade yet. Check back after picks have had a week to play out.');
    return;
  }

  const lines: string[] = [
    `📊 <b>PICK SCORECARD</b>`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `<b>Overall Record:</b> ${record.wins}W / ${record.losses}L (${record.winRate.toFixed(0)}% win rate)`,
    `<b>Avg stock move:</b> ${record.avgStockReturn >= 0 ? '+' : ''}${record.avgStockReturn}%`,
    `<b>Options:</b> ${record.optionsRecord.wins}W / ${record.optionsRecord.losses}L`,
    `<b>Stocks:</b> ${record.stockRecord.wins}W / ${record.stockRecord.losses}L`,
    ``,
    `<b>Recently graded:</b>`,
  ];

  for (const g of recent) {
    const icon = g.outcome === 'WIN' ? '🟢' : g.outcome === 'LOSS' ? '🔴' : '⬜';
    const sign = g.stockReturnPct >= 0 ? '+' : '';
    lines.push(`${icon} ${g.ticker} (${g.pickType === 'OPTIONS_CALL' ? 'opt' : 'stock'}): ${sign}${g.stockReturnPct}% — ${g.note}`);
  }

  lines.push('');
  lines.push('<i>Note: outcomes track the underlying stock move. Options P&L is more leveraged than the stock %.</i>');

  await send(lines.join('\n'));
}

// ── Formatters ──────────────────────────────────────────────

function escapeHTML(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Independent news-only verdict line. Empty when no news view exists.
// Emphasizes the case the user cares about most: news disagreeing with
// the technical read (that divergence is the useful signal).
function formatNewsView(pick: StockPick): string {
  const nv = pick.newsView;
  if (!nv) return '';
  const tech = pick.technicals.trend;
  const icon = nv.direction === 'bullish' ? '🟢' : nv.direction === 'bearish' ? '🔴' : '⚪';
  const diverges = nv.direction !== 'neutral' && nv.direction !== tech;
  const tag = diverges
    ? ` 🔀 <b>DISAGREES with technicals (${tech})</b>`
    : '';
  const rationale = nv.rationale ? ` — ${escapeHTML(nv.rationale)}` : '';
  return `📰 <b>News view:</b> ${icon} ${nv.direction.toUpperCase()} (${nv.confidence}/100)${tag}${rationale}`;
}

function formatOptionsPick(pick: StockPick, index: number): string {
  const opt = pick.options!;
  const sentimentBar = getSentimentBar(pick.news);
  const techEmoji = pick.technicals.trend === 'bullish' ? '🟢' : pick.technicals.trend === 'bearish' ? '🔴' : '🟡';

  const liveData = opt.delta !== null;
  return [
    `📞 <b>OPTIONS PICK #${index}: ${pick.ticker} CALL</b>`,
    `<b>${pick.name}</b> | ${pick.sector}`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `💡 ${escapeHTML(pick.summary)}`,
    pick.voteBreakdown ? `🤖 <b>AI Votes:</b> ${pick.voteBreakdown}` : '',
    ``,
    `📍 <b>Stock now:</b> $${pick.currentPrice.toFixed(2)}`,
    `📄 <b>Contract:</b> $${opt.strikePrice} CALL exp ${opt.expirationDate} (${(((opt.strikePrice - pick.currentPrice) / pick.currentPrice) * 100).toFixed(1)}% OTM)`,
    `💵 <b>Premium:</b> ~$${opt.premium.toFixed(2)} (~$${Math.round(opt.premium * 100)}/contract)`,
    liveData
      ? `📊 Delta ${opt.delta?.toFixed(2)} | IV ${opt.impliedVolatility ? (opt.impliedVolatility * 100).toFixed(0) + '%' : 'N/A'} (live data)`
      : `⚠️ Estimated premium — confirm live Ask in app`,
    `⚖️ <b>Breakeven:</b> $${opt.breakeven.toFixed(2)}`,
    ``,
    `🟢 <b>Buy zone (stock):</b> $${pick.entryZone.low.toFixed(2)} – $${pick.entryZone.high.toFixed(2)}`,
    `🎯 <b>Take profit:</b> stock $${pick.targetPrice.toFixed(2)}`,
    `🛑 <b>Stop loss:</b> stock $${pick.stopLoss.toFixed(2)}`,
    `⏱ <b>Time horizon:</b> ${pick.timeHorizon}`,
    `💰 <b>Max loss:</b> ${opt.maxLoss}`,
    `📈 <b>Max gain:</b> ${opt.maxGain}`,
    ``,
    `📊 <b>Technicals:</b> ${techEmoji} ${pick.technicals.trend.toUpperCase()} | RSI ${pick.technicals.rsi?.toFixed(0) || 'N/A'} | MACD ${pick.technicals.macd !== null ? (pick.technicals.macd > 0 ? '▲' : '▼') : 'N/A'}`,
    `📰 <b>Sentiment:</b> ${sentimentBar}`,
    formatNewsView(pick),
    `🎲 <b>Catalysts:</b> ${pick.catalysts.slice(0, 2).join(' | ')}`,
    `⚠️ <b>Risks:</b> ${pick.risks.slice(0, 2).join(' | ')}`,
    pick.earningsGap?.withinHorizon
      ? `🗓️ <b>Earnings in ${pick.earningsGap.daysUntil} days</b> (${pick.earningsGap.date}) — within hold window (binary risk)`
      : '',
    `🎯 <b>Confidence:</b> ${pick.confidenceScore}/100 | R/R: ${pick.riskRewardRatio.toFixed(1)}:1`,
  ].join('\n');
}

function formatStockPick(pick: StockPick, index: number): string {
  const sentimentBar = getSentimentBar(pick.news);
  const techEmoji = pick.technicals.trend === 'bullish' ? '🟢' : pick.technicals.trend === 'bearish' ? '🔴' : '🟡';
  const gainTarget = (((pick.targetPrice - pick.currentPrice) / pick.currentPrice) * 100).toFixed(1);

  return [
    `📈 <b>STOCK PICK #${index}: ${pick.ticker}</b>`,
    `<b>${pick.name}</b> | ${pick.sector}`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `💡 ${escapeHTML(pick.summary)}`,
    pick.voteBreakdown ? `🤖 <b>AI Votes:</b> ${pick.voteBreakdown}` : '',
    ``,
    `🟢 <b>Buy zone:</b> $${pick.entryZone.low.toFixed(2)} – $${pick.entryZone.high.toFixed(2)}`,
    `🎯 <b>Take profit:</b> $${pick.targetPrice.toFixed(2)} (+${gainTarget}%)`,
    `🛑 <b>Stop loss:</b> $${pick.stopLoss.toFixed(2)}`,
    `⏱ <b>Time horizon:</b> ${pick.timeHorizon} | <b>R/R:</b> ${pick.riskRewardRatio.toFixed(1)}:1`,
    ``,
    `📊 <b>Technicals:</b> ${techEmoji} ${pick.technicals.trend.toUpperCase()} | RSI ${pick.technicals.rsi?.toFixed(0) || 'N/A'}`,
    `SMA50: $${pick.technicals.sma50?.toFixed(2) || 'N/A'} | SMA200: $${pick.technicals.sma200?.toFixed(2) || 'N/A'}`,
    `Support: $${pick.technicals.support?.toFixed(2) || 'N/A'} | Resistance: $${pick.technicals.resistance?.toFixed(2) || 'N/A'}`,
    ``,
    `📰 <b>Sentiment:</b> ${sentimentBar}`,
    ...pick.news.slice(0, 3).map(n => `• ${n.source}: ${truncate(n.title, 65)}`),
    formatNewsView(pick),
    ``,
    `🎲 <b>Catalysts:</b>`,
    ...pick.catalysts.slice(0, 3).map(c => `• ${c}`),
    ``,
    `⚠️ <b>Risks:</b>`,
    ...pick.risks.slice(0, 2).map(r => `• ${r}`),
    ...(pick.earningsGap?.withinHorizon
      ? [`• 🗓️ <b>Earnings in ${pick.earningsGap.daysUntil} days</b> (${pick.earningsGap.date}) — within hold window (binary risk)`]
      : []),
    ``,
    `🎯 Confidence: ${pick.confidenceScore}/100`,
  ].join('\n');
}

function getSentimentBar(news: NewsArticle[]): string {
  if (!news.length) return '⬜ No recent news';
  const pos = news.filter(n => n.sentiment === 'positive').length;
  const neg = news.filter(n => n.sentiment === 'negative').length;
  const neu = news.filter(n => n.sentiment === 'neutral').length;
  return `🟢${pos} 🔴${neg} ⬛${neu}`;
}

function getActionEmoji(action: string): string {
  const map: Record<string, string> = {
    ENTER_NOW: '🚀', HOLD: '✋', TRIM: '✂️', EXIT: '🚪', WAIT: '⏳',
  };
  return map[action] || '📊';
}

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.substring(0, maxLen - 3) + '...' : str;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}