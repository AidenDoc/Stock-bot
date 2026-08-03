// ============================================================
// TELEGRAM NOTIFIER — formatted alerts for stock bot
// ============================================================

import TelegramBot from 'node-telegram-bot-api';
import { StockPick, WeeklyReport, DailyUpdate, NewsArticle } from './types';
import { memoryHeadToHead, getMemoryStats, MIN_CLOSED_FOR_RETRIEVAL } from './memory/tradeMemory';
import { getPaperSummary, paperReset } from './paperAccount';
import { etNow, tradingDaysBetween } from './marketCalendar';
import { MAX_SLOTS } from './tradePlan';
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

// Telegram rejects messages over 4096 chars (400 "message is too long").
// Split on line boundaries so HTML tags/entities (which never span lines in
// our formatters) stay intact, and leave headroom for the continuation marker.
const TG_CHUNK_LIMIT = 3900;

export function chunkMessage(message: string): string[] {
  if (message.length <= TG_CHUNK_LIMIT) return [message];

  const chunks: string[] = [];
  let current = '';
  for (const line of message.split('\n')) {
    // A single line longer than the limit gets hard-split (shouldn't happen
    // with our formatters, but never let one line brick the whole send).
    let rest = line;
    while (rest.length > TG_CHUNK_LIMIT) {
      if (current) { chunks.push(current); current = ''; }
      chunks.push(rest.slice(0, TG_CHUNK_LIMIT));
      rest = rest.slice(TG_CHUNK_LIMIT);
    }
    const candidate = current ? `${current}\n${rest}` : rest;
    if (candidate.length > TG_CHUNK_LIMIT) {
      chunks.push(current);
      current = rest;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);

  const total = chunks.length;
  return chunks.map((c, i) => {
    const head = i > 0 ? `<i>…continued (${i + 1}/${total})</i>\n` : '';
    const tail = i < total - 1 ? `\n<i>⤵️ continued in next message</i>` : '';
    return head + c + tail;
  });
}

async function send(message: string, parseMode: 'HTML' | 'Markdown' = 'HTML'): Promise<void> {
  for (const chunk of chunkMessage(message)) {
    try {
      await bot.sendMessage(getChatId(), chunk, {
        parse_mode: parseMode,
        disable_web_page_preview: true,
      });
    } catch (err: any) {
      console.error('[Telegram] Send error:', err?.message);
    }
    await sleep(500);
  }
}

// Reply to a specific chat (used by command handlers)
async function reply(chatId: number | string, message: string): Promise<void> {
  const chunks = chunkMessage(message);
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await sleep(500); // pace multi-chunk replies only
    try {
      await bot.sendMessage(chatId, chunks[i], {
        parse_mode: 'HTML',
        disable_web_page_preview: false, // allow the dashboard link preview
      });
    } catch (err: any) {
      console.error('[Telegram] Reply error:', err?.message);
    }
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
      '/memory — memory-informed vs baseline picks',
      '/paper — simulated paper account (equity, positions, cash)',
      '/paperreset — archive &amp; restart the paper account (asks to confirm)',
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
      await reply(msg.chat.id, '📭 <b>Open positions</b>\n\nNone right now. The scan runs weekday mornings (10:15 AM ET) whenever a slot is open.');
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
    // invalid === true marks corporate-action artifacts (e.g. the LC → HAPN
    // phantom picks) kept as audit history — never counted in the record.
    const graded = (sc.graded || []).filter(g => g.outcome !== 'OPEN' && g.invalid !== true);
    const wins = graded.filter(g => g.outcome === 'WIN').length;
    const losses = graded.filter(g => g.outcome === 'LOSS').length;
    const total = wins + losses;
    if (total === 0) {
      await reply(msg.chat.id, '📊 <b>Record</b>\n\nNo graded picks yet — each pick grades 5 days after it is made.');
      return;
    }
    const winRate = ((wins / total) * 100).toFixed(0);
    const avg = (graded.reduce((s, g) => s + (g.stockReturnPct || 0), 0) / total).toFixed(1);

    const excessLines = ['PULLBACK', 'BREAKOUT'].map(strat => {
      const vals = graded
        .filter(g => g.strategy === strat && typeof g.excessReturnPct === 'number')
        .map(g => g.excessReturnPct as number);
      if (vals.length === 0) return `${strat}: no benchmark data yet`;
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const med = median(vals);
      const fmt = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
      return `${strat}: mean ${fmt(mean)}, median ${fmt(med)} vs SPY (n=${vals.length})`;
    });

    await reply(msg.chat.id, [
      '📊 <b>Record</b>',
      '',
      `${wins}W / ${losses}L (${winRate}% win rate) across ${total} graded picks.`,
      `Avg stock move per pick: ${Number(avg) >= 0 ? '+' : ''}${avg}%`,
      '',
      '<b>Excess return vs SPY:</b>',
      ...excessLines,
      '',
      '<i>Outcomes track the underlying stock vs. target/stop.</i>',
    ].join('\n'));
  });

  bot.onText(/^\/memory/, async (msg) => {
    if (String(msg.chat.id) !== ownerId) return;
    const stats = getMemoryStats();
    const h2h = memoryHeadToHead();

    if (stats.total === 0) {
      await reply(msg.chat.id, '🧠 <b>Trade Memory</b>\n\nNo records yet — the bank starts filling on the next weekly scan.');
      return;
    }

    const fmtSide = (label: string, s: typeof h2h.memory) => s.n === 0
      ? `<b>${label}:</b> no closed picks yet`
      : `<b>${label}:</b> ${s.wins}W / ${s.losses}L (${s.winRate.toFixed(0)}% win rate) over ${s.n} picks, avg ${s.avgPnlPct >= 0 ? '+' : ''}${s.avgPnlPct.toFixed(1)}%`;

    const closedLine = Object.entries(stats.closedByStrategy)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ') || 'none';

    const lines = [
      '🧠 <b>Trade Memory</b>',
      '',
      `${stats.total} records (${stats.open} open). Closed by strategy: ${closedLine}.`,
      `Retrieval turns on at ${MIN_CLOSED_FOR_RETRIEVAL} closed trades per strategy.`,
      '',
      fmtSide('Memory-informed', h2h.memory),
      fmtSide('Baseline (no memory)', h2h.baseline),
    ];
    if (h2h.memory.n > 0 && h2h.memory.n < 25) {
      lines.push('', `<i>Kill criterion check runs at 25 memory-informed closed picks (${h2h.memory.n}/25 so far).</i>`);
    }
    await reply(msg.chat.id, lines.join('\n'));
  });

  // /paper — simulated account snapshot. /^\/paper$/ so it never
  // swallows /paperreset (allow the @botname suffix Telegram appends).
  bot.onText(/^\/paper(?:@\w+)?\s*$/, async (msg) => {
    if (String(msg.chat.id) !== ownerId) return;
    const s = getPaperSummary();
    if (!s) {
      await reply(msg.chat.id, '📒 <b>Paper account</b>\n\nAccount file unreadable — check data/paper-account.json on the server.');
      return;
    }
    const sign = (n: number) => (n >= 0 ? '+' : '');
    const lines = [
      '📒 <b>Paper account</b> <i>(simulated — no real money)</i>',
      '',
      `<b>Equity:</b> $${s.equity.toFixed(2)} (${sign(s.returnPct)}${s.returnPct.toFixed(1)}% since inception)`,
      s.spyReturnPct != null
        ? `<b>vs SPY:</b> $${s.startingBalance} in SPY → ${sign(s.spyReturnPct)}${s.spyReturnPct.toFixed(1)}% over the same period`
        : `<b>vs SPY:</b> not enough history yet`,
      '',
    ];
    if (s.positions.length) {
      lines.push(`<b>Open slots (${s.positions.length}/${MAX_SLOTS}):</b>`);
      const today = etNow().date;
      for (const p of s.positions) {
        const dot = p.pnlDollars >= 0 ? '🟢' : '🔴';
        const frozen = p.markFrozen ? ' 🧊 stale mark' : '';
        lines.push(`${dot} <b>${p.ticker}</b>${p.strategy ? ` (${p.strategy})` : ''} ${p.shares} sh — $${p.value.toFixed(2)} (${sign(p.pnlDollars)}$${p.pnlDollars.toFixed(2)}, ${sign(p.pnlPct)}${p.pnlPct.toFixed(1)}%)${frozen}`);
        // Plan line for V2 slots: days left + distance to TP/SL from the last mark.
        if (p.expiryDate && p.lastMark > 0) {
          const daysLeft = tradingDaysBetween(today, p.expiryDate);
          const toTp = ((p.targetPrice - p.lastMark) / p.lastMark) * 100;
          const toSl = ((p.stopLoss - p.lastMark) / p.lastMark) * 100;
          lines.push(`   ⏳ ${daysLeft}d left | 🎯 $${p.targetPrice.toFixed(2)} (${sign(toTp)}${toTp.toFixed(1)}%) | 🛑 $${p.stopLoss.toFixed(2)} (${toSl.toFixed(1)}%)`);
        }
      }
      if (s.positions.length < MAX_SLOTS) {
        lines.push(`▫️ ${MAX_SLOTS - s.positions.length} slot(s) open — next scan fills them if a setup clears the bar.`);
      }
    } else {
      lines.push(`<b>Open slots (0/${MAX_SLOTS}):</b> none — next scan fills them if setups clear the bar.`);
    }
    lines.push('');
    lines.push(`<b>Cash:</b> $${s.cash.toFixed(2)} settled`);
    for (const pend of s.pending) {
      lines.push(`⏳ $${pend.amount.toFixed(2)} settles ${pend.availableDate}`);
    }
    await reply(msg.chat.id, lines.join('\n'));
  });

  // /paperreset — two-step: the first message arms a 5-minute window,
  // only "/paperreset CONFIRM" inside it actually archives + resets.
  let paperResetArmedUntil = 0;
  bot.onText(/^\/paperreset(?:@\w+)?(?:\s+(\S+))?/, async (msg, match) => {
    if (String(msg.chat.id) !== ownerId) return;
    const arg = (match?.[1] || '').toUpperCase();
    if (arg === 'CONFIRM') {
      if (Date.now() > paperResetArmedUntil) {
        await reply(msg.chat.id, '📒 Reset not armed (or the 5-minute window expired). Send /paperreset first.');
        return;
      }
      paperResetArmedUntil = 0;
      try {
        const { archivedTo, newBalance } = paperReset();
        await reply(msg.chat.id, [
          '📒 <b>Paper account reset.</b>',
          archivedTo ? `Old account archived to <code>${path.basename(archivedTo)}</code>.` : 'No previous account file to archive.',
          `Fresh start at $${newBalance.toFixed(2)}. First buys land on the next weekly scan.`,
        ].join('\n'));
      } catch (err: any) {
        await reply(msg.chat.id, `⚠️ Reset failed: ${err?.message}`);
      }
      return;
    }
    paperResetArmedUntil = Date.now() + 5 * 60 * 1000;
    const s = getPaperSummary();
    await reply(msg.chat.id, [
      '⚠️ <b>Reset the paper account?</b>',
      s ? `Current equity $${s.equity.toFixed(2)} with ${s.positions.length} open position(s) will be archived, then the account restarts fresh.` : 'The current file will be archived, then the account restarts fresh.',
      '',
      'Reply <code>/paperreset CONFIRM</code> within 5 minutes to proceed.',
    ].join('\n'));
  });

  bot.on('polling_error', (err: any) => {
    console.error('[Telegram] Polling error:', err?.message);
  });

  console.log('[Telegram] Command handlers registered (polling on)');
}

export async function sendWeeklyStockReport(report: WeeklyReport): Promise<void> {
  const header = [
    `📊 <b>NEW POSITION${report.stockPicks.length === 1 ? '' : 'S'} — ${report.weekOf}</b>`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    `Trade-plan entries (TP / SL / hard expiry) 📱`,
    ``,
    `🌍 <b>Market Outlook:</b>`,
    report.marketOutlook,
    ``,
    `📌 <b>Key Events This Week:</b>`,
    report.keyEventsThisWeek.map(e => `• ${e}`).join('\n'),
  ].join('\n');

  await send(header);
  await sleep(1000);

  for (let i = 0; i < report.stockPicks.length; i++) {
    const pick = report.stockPicks[i];
    await send(formatStockPick(pick, i + 1));
    await sleep(1500);
  }

  // One-line paper-account footer. Best-effort: a missing/corrupt
  // account file must never break the weekly report.
  try {
    const s = getPaperSummary();
    if (s) {
      const sign = (n: number) => (n >= 0 ? '+' : '');
      const spy = s.spyReturnPct != null ? ` | SPY ${sign(s.spyReturnPct)}${s.spyReturnPct.toFixed(1)}%` : '';
      await send(`📒 <i>Paper account: $${s.equity.toFixed(2)} (${sign(s.returnPct)}${s.returnPct.toFixed(1)}%${spy})</i>`);
    }
  } catch (err: any) {
    console.error('[Telegram] paper footer error:', err?.message);
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

// ── V2 exit alert — fired by the exit monitor when a plan resolves ──
export interface ExitAlertInfo {
  ticker: string;
  strategy?: string;
  outcome: 'HIT_TARGET' | 'HIT_STOP' | 'TIME_EXIT';
  entryPrice: number;
  exitPrice: number;
  exitDate: string;
  daysHeld: number;
  returnPct: number;
  excessReturn?: number;
}

export async function sendExitAlert(e: ExitAlertInfo): Promise<void> {
  const style = e.outcome === 'HIT_TARGET'
    ? { icon: '🎯', title: 'TARGET HIT' }
    : e.outcome === 'HIT_STOP'
      ? { icon: '🛑', title: 'STOPPED OUT' }
      : { icon: '⏱', title: 'TIME EXIT' };
  const sign = (n: number) => (n >= 0 ? '+' : '');
  const msg = [
    `${style.icon} <b>${style.title}: ${e.ticker}</b>${e.strategy ? ` (${e.strategy})` : ''}`,
    ``,
    `Entry $${e.entryPrice.toFixed(2)} → Exit $${e.exitPrice.toFixed(2)} on ${e.exitDate}`,
    `📊 Return: <b>${sign(e.returnPct)}${e.returnPct.toFixed(1)}%</b> in ${e.daysHeld} trading day${e.daysHeld === 1 ? '' : 's'}`,
    e.excessReturn != null
      ? `⚖️ vs SPY over the same hold: <b>${sign(e.excessReturn)}${e.excessReturn.toFixed(1)}pp</b>`
      : `⚖️ vs SPY: no benchmark data`,
    ``,
    `<i>Slot freed — the next scan looks for a replacement.</i>`,
  ].join('\n');

  await send(msg);
}

export async function sendTradeSignal(pick: StockPick): Promise<void> {
  const msg = [
    `📈 <b>TRADE SIGNAL: ${pick.ticker}</b>`,
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
    `📅 Rolling scan: weekdays 10:15 AM ET (fills open slots, up to ${MAX_SLOTS})`,
    `📊 Daily monitor: weekdays 9:00 AM ET (TP / SL / time-expiry exits)`,
    `🔔 Instant alerts: exits, stop warnings, data-quality flags`,
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

// Fired when a symbol's price data looks frozen (identical closes, zero
// volume, or no new trading days) — the signature of a delisting or ticker
// change (e.g. LC → HAPN), NOT a quiet market. The pick/position stays
// ungraded/flagged until a human confirms what happened to the symbol.
export async function sendStaleQuoteAlert(
  ticker: string, context: string, details: string
): Promise<void> {
  const msg = [
    `🧊 <b>FROZEN PRICE DATA</b> 🧊`,
    ``,
    `possible delisting/ticker change — manual review needed: <b>${ticker}</b>`,
    context,
    `Detected: ${details}`,
    ``,
    `⛔ <b>ACTION: check whether ${ticker} was delisted or renamed before trusting any grade or P&amp;L on it.</b>`,
  ].join('\n');

  await send(msg);
}

export async function sendGradingReviewAlert(
  ticker: string, pickedDate: string, entryPrice: number, finalPrice: number,
  returnPct: number, splitEvents: { date: string; ratioText: string }[]
): Promise<void> {
  const splitNote = splitEvents.length
    ? `Detected split(s): ${splitEvents.map(e => `${e.ratioText} on ${e.date}`).join(', ')} (already adjusted for).`
    : `No split detected — this move looks real or the data is bad.`;
  const msg = [
    `🚨 <b>GRADING FLAGGED FOR REVIEW</b> 🚨`,
    ``,
    `<b>${ticker}</b> (picked ${pickedDate.slice(0, 10)}) computed a ${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(1)}% move — over the ±50% safety threshold, so it was NOT auto-graded.`,
    `Entry: $${entryPrice.toFixed(2)} → Final: $${finalPrice.toFixed(2)}`,
    splitNote,
    ``,
    `⛔ <b>ACTION: check this pick manually before it grades.</b>`,
  ].join('\n');

  await send(msg);
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
    // Options picks were retired in July 2026 — the line only appears while
    // historical options grades exist in the record (they count forever).
    ...(record.optionsRecord.wins + record.optionsRecord.losses > 0
      ? [`<b>Options (historical):</b> ${record.optionsRecord.wins}W / ${record.optionsRecord.losses}L`]
      : []),
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
  lines.push('<i>Note: outcomes track the underlying stock move vs. target/stop.</i>');

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
    `🛑 <b>Stop loss:</b> $${pick.stopLoss.toFixed(2)} (${(((pick.stopLoss - pick.currentPrice) / pick.currentPrice) * 100).toFixed(1)}%)`,
    `⏱ <b>Horizon:</b> ${pick.timeHorizon}${pick.expiryDate ? ` — expires <b>${pick.expiryDate}</b>` : ''} | <b>R/R:</b> ${pick.riskRewardRatio.toFixed(1)}:1`,
    `📋 <i>Exit on whichever comes first: target, stop, or expiry.</i>`,
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

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}