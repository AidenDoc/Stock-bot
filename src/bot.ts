// ============================================================
// STOCK BOT — Main Entry Point
// Pipeline: Scanner → Analyst → Notifier → Portfolio Tracker
// Runs on DigitalOcean VPS via PM2 (same setup as Kalshi bot)
// ============================================================

import 'dotenv/config';
import cron from 'node-cron';
import { initTelegram, sendStartupMessage, sendErrorAlert, registerCommands,
         sendWeeklyStockReport } from './telegram';
import { runWeeklyScan } from './scanner';
import { runDailyCheck, addPosition, reconcilePortfolio } from './portfolio';
import { gradePicks, getRecord, getRecentGraded } from './scorecard';
import { sendScorecard } from './telegram';
import { getMarketNews, getKeyEventsThisWeek } from './news';
import { generateMarketOutlook, logRunSummary } from './analyst';
import { WeeklyReport } from './types';
import { runEvaluation } from './evaluation';
import { updateChartData } from './chartData';
import { writeCurrentPicks } from './currentPicks';
import { nyseHoliday } from './marketCalendar';

// ── Validate env vars ──────────────────────────────────────
const REQUIRED_ENV = [
  'STOCK_TELEGRAM_BOT_TOKEN',
  'STOCK_TELEGRAM_CHAT_ID',
  'ANTHROPIC_API_KEY',
  'FMP_API_KEY',
  'NEWS_API_KEY',
];

function validateEnv(): void {
  const missing = REQUIRED_ENV.filter(key => !process.env[key]);
  if (missing.length > 0) {
    console.error('[Bot] Missing required env vars:', missing.join(', '));
    process.exit(1);
  }
  console.log('[Bot] Environment validated ✅');
}

// ── Weekly picks pipeline ──────────────────────────────────
async function runWeeklyPipeline(): Promise<void> {
  console.log('\n' + '═'.repeat(50));
  console.log('[Bot] 🚀 STARTING WEEKLY PICKS PIPELINE');
  console.log('═'.repeat(50));

  try {
    // Step 1: Scan & analyze markets
    console.log('[Bot] Step 1/4: Scanning markets...');
    const { stockPicks } = await runWeeklyScan(4);

    // Ticker loop is done — print the per-model ensemble summary
    // (which models actually voted, error rates) and reset counters.
    logRunSummary();

    if (stockPicks.length === 0) {
      await sendErrorAlert('Scanner', 'No picks found this week — market conditions may be poor');
      console.log('[Bot] No picks found this week');
      return;
    }

    // Step 2: Get market context
    console.log('[Bot] Step 2/4: Fetching market news...');
    const marketNews = await getMarketNews();
    const keyEvents = getKeyEventsThisWeek();

    // Step 3: Generate market outlook
    console.log('[Bot] Step 3/4: Generating market outlook...');
    const marketOutlook = await generateMarketOutlook(marketNews, stockPicks);

    // Step 4: Build weekly report
    const weekOf = new Date().toLocaleDateString('en-US', {
      month: 'long', day: 'numeric', year: 'numeric'
    });

    const report: WeeklyReport = {
      weekOf,
      stockPicks,
      marketOutlook,
      keyEventsThisWeek: keyEvents,
      generatedAt: new Date().toISOString(),
    };

    // Step 5: Send Telegram notifications
    console.log('[Bot] Step 4/4: Sending Telegram notifications...');
    await sendWeeklyStockReport(report);

    // Snapshot the finalized week's picks (same values as the report
    // above) to data/current-picks.json via an atomic tmp+rename write.
    writeCurrentPicks(report);

    // Step 6: Add all picks to portfolio tracker (as WATCHING)
    for (const pick of stockPicks) {
      addPosition(pick);
    }

    // Keep the active-picks list honest: resolve graded picks and collapse
    // any duplicate rows before the dashboard reads portfolio.json.
    reconcilePortfolio();

    // Step 7: Refresh chart history so the dashboard's Charts panel
    // has data for the new open positions.
    await updateChartData();

    console.log('[Bot] ✅ Weekly pipeline complete!');
    console.log(`[Bot] Stock picks: ${stockPicks.length}`);

  } catch (err: any) {
    console.error('[Bot] Weekly pipeline error:', err?.message);
    await sendErrorAlert('Weekly Pipeline', err?.message || 'Unknown error');
  }
}

// ── Daily check pipeline ───────────────────────────────────
async function runDailyPipeline(): Promise<void> {
  console.log('\n[Bot] 📊 Running daily position check...');
  try {
    await runDailyCheck();
    // Refresh 3-month price history for open positions (dashboard charts).
    await updateChartData();
    console.log('[Bot] ✅ Daily check complete');
  } catch (err: any) {
    console.error('[Bot] Daily check error:', err?.message);
    await sendErrorAlert('Daily Check', err?.message || 'Unknown error');
  }
}

// ── Main ───────────────────────────────────────────────────

// ── Scorecard pipeline ─────────────────────────────────────
async function runScorecardPipeline(): Promise<void> {
  console.log('\n[Bot] 📊 Running scorecard...');
  try {
    await gradePicks(5); // grade picks at least 5 days old
    // Resolved picks → CLOSED (out of "active picks", into graded Results)
    // and collapse any legacy duplicate rows. Keeps the open list honest.
    reconcilePortfolio();
    const record = getRecord();
    const recent = getRecentGraded(8);
    await sendScorecard(record, recent);
    console.log('[Bot] ✅ Scorecard sent');
  } catch (err) {
    console.error('[Bot] Scorecard error:', err);
  }
}

async function main() {
  console.log('\n' + '█'.repeat(50));
  console.log('  STOCK BOT — Starting up');
  console.log('  Built on Kalshi Bot Architecture');
  console.log('█'.repeat(50) + '\n');

  validateEnv();

  // Init Telegram
  initTelegram();
  await sendStartupMessage();

  // Check for CLI flags
  const args = process.argv.slice(2);

  if (args.includes('--weekly')) {
    // Manual trigger: run weekly picks now
    await runWeeklyPipeline();
    process.exit(0);
  }

  if (args.includes('--daily')) {
    // Manual trigger: run daily check now
    await runDailyPipeline();
    process.exit(0);
  }

  if (args.includes('--scorecard')) {
    // Manual trigger: grade past picks and send scorecard
    await runScorecardPipeline();
    process.exit(0);
  }

  if (args.includes('--reconcile')) {
    // One-time heal of portfolio.json: close already-graded picks and
    // collapse duplicate open rows. Safe to run anytime.
    const { closed, deduped } = reconcilePortfolio();
    console.log(`[Bot] Reconcile complete — closed ${closed}, deduped ${deduped}`);
    process.exit(0);
  }

  if (args.includes('--evaluate')) {
    // Honest performance harness — expectancy, streaks, SPY comparison
    await runEvaluation();
    process.exit(0);
  }

  if (args.includes('--charts')) {
    // Manual trigger: fetch price history for open positions and write
    // data/history.json (powers the dashboard's Charts panel).
    await updateChartData();
    process.exit(0);
  }

  // ── Schedule cron jobs ────────────────────────────────────
  // Weekly scan: Monday 10:15am ET — moved from 8:00am on 2026-07-15
  // (first run at the new time: Monday 2026-07-20). 45 minutes after the
  // open, the opening auction has settled and Friday's daily bar is final
  // at every data source. Signals (RSI/SMA/MACD, volumeRatio) come from
  // completed daily bars only; the live quote is used solely for the
  // entry price (see marketData.ts / marketCalendar.isBarComplete).
  const weeklyCron = process.env.WEEKLY_CRON || '15 10 * * 1';
  const dailyCron = process.env.DAILY_CRON || '0 9 * * 1-5';  // Weekdays 9am

  console.log(`[Bot] Scheduling weekly picks: ${weeklyCron}`);
  console.log(`[Bot] Scheduling daily check: ${dailyCron}`);

  // Weekly picks — Monday after the open (see schedule note above)
  cron.schedule(weeklyCron, async () => {
    const holiday = nyseHoliday();
    if (holiday) {
      console.log(`[Cron] Market closed (${holiday}) — skipping weekly scan.`);
      return;
    }
    console.log('[Cron] Triggering weekly scorecard + picks...');
    await runScorecardPipeline();  // grade last week's picks first
    await runWeeklyPipeline();      // then send this week's
  }, { timezone: 'America/New_York' });

  // Daily position updates — each weekday morning
  cron.schedule(dailyCron, () => {
    console.log('[Cron] Triggering daily check...');
    runDailyPipeline();
  }, { timezone: 'America/New_York' });

  // Start listening for Telegram commands (daemon only)
  registerCommands();

  // Keep alive
  console.log('\n[Bot] ✅ Cron jobs scheduled. Bot is running...\n');

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('[Bot] SIGTERM received, shutting down gracefully');
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('[Bot] SIGINT received, shutting down');
    process.exit(0);
  });
}

main().catch(err => {
  console.error('[Bot] Fatal error:', err);
  process.exit(1);
});
