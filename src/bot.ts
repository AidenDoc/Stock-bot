// ============================================================
// STOCK BOT — Main Entry Point
// Pipeline: Scanner → Analyst → Notifier → Portfolio Tracker
// Runs on DigitalOcean VPS via PM2 (same setup as Kalshi bot)
// ============================================================

import 'dotenv/config';
import cron from 'node-cron';
import { initTelegram, sendStartupMessage, sendErrorAlert, registerCommands,
         sendWeeklyStockReport } from './telegram';
import { runScan } from './scanner';
import { runDailyCheck, addPosition, reconcilePortfolio,
         openSlotCount, getOpenTickers } from './portfolio';
import { runExitMonitor } from './positionMonitor';
import { gradePicks, getRecord, getRecentGraded } from './scorecard';
import { sendScorecard } from './telegram';
import { getMarketNews, getKeyEventsThisWeek } from './news';
import { generateMarketOutlook, logRunSummary } from './analyst';
import { WeeklyReport } from './types';
import { runEvaluation } from './evaluation';
import { updateChartData } from './chartData';
import { writeCurrentPicks } from './currentPicks';
import { nyseHoliday } from './marketCalendar';
import { paperBuyPicks, paperDailyMark, paperApplyGrades } from './paperAccount';

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

// ── Rolling scan pipeline (fills open slots) ───────────────
// Runs daily on the scan cron but only actually scans when a slot is
// free. Picks exactly enough candidates to fill the open slots —
// usually 1 (rolling replacement); up to MAX_SLOTS on the first run
// under the V2 regime. If nothing clears the 0.65 consensus bar, the
// slot stays open — the bar never drops to fill a slot.
async function runScanPipeline(opts: { dryRun?: boolean; universeLimit?: number } = {}): Promise<void> {
  const dryRun = opts.dryRun ?? false;
  console.log('\n' + '═'.repeat(50));
  console.log(`[Bot] 🚀 STARTING SCAN PIPELINE${dryRun ? ' [DRY RUN]' : ''}`);
  console.log('═'.repeat(50));

  try {
    // Step 0: slot check — no free slot, no scan.
    const slots = openSlotCount();
    console.log(`[Bot] Slots: ${slots.open}/${slots.max} filled, ${slots.free} free`);
    if (slots.free === 0) {
      console.log('[Bot] All slots filled — no scan today.');
      return;
    }

    // Step 1: scan & analyze. Open tickers (either regime) are excluded
    // so a slot can never double-enter a name already being tracked.
    console.log(`[Bot] Step 1/4: Scanning for up to ${slots.free} new position(s)...`);
    const { stockPicks } = await runScan(slots.free, {
      dryRun,
      excludeTickers: getOpenTickers(),
      universeLimit: opts.universeLimit,
    });

    // Ticker loop is done — print the per-model ensemble summary
    // (which models actually voted, error rates) and reset counters.
    logRunSummary();

    if (stockPicks.length === 0) {
      console.log('[Bot] No candidate cleared the bar — slot(s) stay open.');
      return;
    }

    if (dryRun) {
      console.log('[Bot] DRY RUN — picks found but nothing written/sent:');
      for (const p of stockPicks) {
        console.log(`  ${p.ticker} [${p.strategy}] entry $${p.currentPrice} TP $${p.targetPrice} SL $${p.stopLoss} RR ${p.riskRewardRatio} expires ${p.expiryDate}`);
      }
      return;
    }

    // Step 2: market context for the entry report.
    console.log('[Bot] Step 2/4: Fetching market news...');
    const marketNews = await getMarketNews();
    const keyEvents = getKeyEventsThisWeek();

    console.log('[Bot] Step 3/4: Generating market outlook...');
    const marketOutlook = await generateMarketOutlook(marketNews, stockPicks);

    const report: WeeklyReport = {
      weekOf: new Date().toLocaleDateString('en-US', {
        month: 'long', day: 'numeric', year: 'numeric'
      }),
      stockPicks,
      marketOutlook,
      keyEventsThisWeek: keyEvents,
      generatedAt: new Date().toISOString(),
    };

    // Step 4: Telegram entry messages (TP/SL/RR/horizon/expiry included).
    console.log('[Bot] Step 4/4: Sending Telegram notifications...');
    await sendWeeklyStockReport(report);

    // Snapshot the new picks to data/current-picks.json (atomic write).
    writeCurrentPicks(report);

    // Track the new positions (V2 rows enter as ACTIVE slots).
    for (const pick of stockPicks) {
      addPosition(pick);
    }

    // Keep the active-picks list honest before the dashboard reads it.
    reconcilePortfolio();

    // Paper account buys the fills with settled cash, split across the
    // slots being filled (internally fail-safe — a paper problem never
    // fails the scan).
    paperBuyPicks(stockPicks);

    // Refresh chart history for the dashboard's Charts panel.
    await updateChartData();

    console.log('[Bot] ✅ Scan pipeline complete!');
    console.log(`[Bot] New positions: ${stockPicks.length}`);

  } catch (err: any) {
    console.error('[Bot] Scan pipeline error:', err?.message);
    await sendErrorAlert('Scan Pipeline', err?.message || 'Unknown error');
  }
}

// ── Daily monitor pipeline ─────────────────────────────────
// 1) Daily check: fetch quotes for open positions, split-rescale
//    stored levels, run the frozen-quote guard, send the daily update.
// 2) Exit monitor: resolve V2 positions on completed bars (TP / SL /
//    time expiry) — scorecard, memory bank, paper account, Telegram.
// 3) Paper mark-to-market on the prices the check already fetched.
async function runDailyPipeline(): Promise<void> {
  console.log('\n[Bot] 📊 Running daily position check...');
  try {
    const snapshot = await runDailyCheck();
    // Exits evaluate on COMPLETED bars only; the frozen tickers the
    // check just flagged are excluded from exit evaluation.
    await runExitMonitor({ frozenTickers: snapshot.frozenTickers });
    // Paper account marks to market on the SAME prices the check just
    // fetched (no extra API calls); frozen tickers keep their last mark.
    // Positions the monitor just closed are already sold — the mark
    // loop simply no longer sees them.
    await paperDailyMark(snapshot.prices, snapshot.frozenTickers);
    // Refresh 3-month price history for open positions (dashboard charts).
    await updateChartData();
    console.log('[Bot] ✅ Daily check complete');
  } catch (err: any) {
    console.error('[Bot] Daily check error:', err?.message);
    await sendErrorAlert('Daily Check', err?.message || 'Unknown error');
  }
}

// ── Main ───────────────────────────────────────────────────

// ── Scorecard pipeline (legacy V1 drain) ───────────────────
// gradePicks now only touches legacy V1_WEEKLY rows — V2 positions
// resolve through the exit monitor. Runs daily ahead of the scan so
// remaining V1 rows drain out on their old 5-day clock; on this daily
// cadence the Telegram scorecard is only sent when something new
// actually graded (or when forced by the manual --scorecard trigger).
async function runScorecardPipeline(opts: { forceSend?: boolean } = {}): Promise<void> {
  console.log('\n[Bot] 📊 Running scorecard...');
  try {
    const newlyGraded = await gradePicks(5); // grade V1 picks at least 5 days old
    // Resolved picks → CLOSED (out of "active picks", into graded Results)
    // and collapse any legacy duplicate rows. Keeps the open list honest.
    reconcilePortfolio();
    // Paper account force-closes any still-held pick the grading just
    // resolved, at the graded final price (WEEK_CLOSE). Consumer only —
    // grading itself is untouched and unaffected by paper errors.
    paperApplyGrades(newlyGraded);
    if (newlyGraded.length > 0 || opts.forceSend) {
      const record = getRecord();
      const recent = getRecentGraded(8);
      await sendScorecard(record, recent);
      console.log('[Bot] ✅ Scorecard sent');
    } else {
      console.log('[Bot] Scorecard: nothing newly graded — no message sent');
    }
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

  // Check for CLI flags
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  // Init Telegram. Dry runs stay silent end-to-end — no startup message
  // (and the dry-run pipelines themselves never send).
  initTelegram();
  if (!dryRun) await sendStartupMessage();

  const limitArg = args.find(a => a.startsWith('--limit='));
  const universeLimit = limitArg ? parseInt(limitArg.split('=')[1], 10) : undefined;

  if (args.includes('--scan') || args.includes('--weekly')) {
    // Manual trigger: run the rolling scan now (--weekly kept as alias).
    // --dry-run analyzes without writing state; --limit=N caps the universe.
    await runScanPipeline({ dryRun, universeLimit });
    process.exit(0);
  }

  if (args.includes('--daily')) {
    // Manual trigger: run daily check + exit monitor now
    await runDailyPipeline();
    process.exit(0);
  }

  if (args.includes('--monitor')) {
    // Manual trigger: exit monitor only. With --dry-run it evaluates
    // every open V2 position against completed bars and writes nothing.
    await runExitMonitor({ dryRun });
    process.exit(0);
  }

  if (args.includes('--scorecard')) {
    // Manual trigger: grade past (legacy V1) picks and send scorecard
    await runScorecardPipeline({ forceSend: true });
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
  // Rolling scan: weekdays 10:15am ET (same time-of-day the weekly scan
  // used; now daily). 45 minutes after the open, the opening auction has
  // settled and yesterday's daily bar is final at every data source.
  // Signals (RSI/SMA/MACD, volumeRatio) come from completed daily bars
  // only; the live quote is used solely for the entry price (see
  // marketData.ts / marketCalendar.isBarComplete). The pipeline itself
  // no-ops unless a slot is free.
  //
  // SCAN_CRON is a NEW env key (documented default below). The legacy
  // WEEKLY_CRON in .env is deliberately ignored — it pins Monday-only,
  // which the rolling regime replaced.
  const scanCron = process.env.SCAN_CRON || '15 10 * * 1-5';
  const dailyCron = process.env.DAILY_CRON || '0 9 * * 1-5';  // Weekdays 9am

  console.log(`[Bot] Scheduling rolling scan: ${scanCron}`);
  console.log(`[Bot] Scheduling daily monitor: ${dailyCron}`);

  // Rolling scan — weekday mornings, holiday-guarded, slot-gated.
  cron.schedule(scanCron, async () => {
    const holiday = nyseHoliday();
    if (holiday) {
      console.log(`[Cron] Market closed (${holiday}) — skipping scan.`);
      return;
    }
    console.log('[Cron] Triggering scorecard (V1 drain) + rolling scan...');
    await runScorecardPipeline();  // drain any remaining legacy V1 picks
    await runScanPipeline();        // fill open slots (no-op when full)
  }, { timezone: 'America/New_York' });

  // Daily monitor — each weekday morning, holiday-guarded.
  cron.schedule(dailyCron, () => {
    const holiday = nyseHoliday();
    if (holiday) {
      console.log(`[Cron] Market closed (${holiday}) — skipping daily monitor.`);
      return;
    }
    console.log('[Cron] Triggering daily monitor...');
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
