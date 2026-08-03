// ============================================================
// EVALUATION — honest performance harness
// Run with: node dist/bot.js --evaluate
// Leads with expectancy, not win rate.
// ============================================================

import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { GradedPick } from './scorecard';
import { regimeOf } from './tradePlan';

const HISTORY_FILE = path.join(process.cwd(), 'data', 'scorecard.json');

// Rough leverage multiplier for OTM calls — used only to evaluate HISTORICAL
// OPTIONS_CALL grades (the bot stopped making options picks in July 2026;
// those records remain part of the track record forever).
// Real multiplier depends on delta/IV but 4× is a defensible midpoint for
// 5-10% OTM calls with 3-6 weeks left (delta ≈ 0.30–0.40, leverage ≈ 3–5×).
const OPTIONS_LEVERAGE = 4;

function loadGraded(): GradedPick[] {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    // invalid === true = corporate-action artifact kept only as audit history
    // (e.g. the LC → HAPN phantom picks) — excluded from every stat here.
    return (data.graded as GradedPick[]).filter(g => g.outcome !== 'OPEN' && g.invalid !== true);
  } catch {
    return [];
  }
}

// OTM calls that don't reach target expire worthless → -100%.
// Wins get leverage applied; cap at 500% to avoid absurd single-pick distortion.
function estimatedOptionsPnl(stockReturnPct: number, outcome: string): number {
  if (outcome === 'LOSS' || stockReturnPct <= 0) return -100;
  return Math.min(stockReturnPct * OPTIONS_LEVERAGE, 500);
}

function maxLosingStreak(picks: GradedPick[]): number {
  let max = 0, cur = 0;
  for (const p of picks) {
    if (p.outcome === 'LOSS') { cur++; max = Math.max(max, cur); }
    else cur = 0;
  }
  return max;
}

async function fetchSpyReturnSince(isoDate: string): Promise<number | null> {
  try {
    const period1 = Math.floor(new Date(isoDate).getTime() / 1000);
    const period2 = Math.floor(Date.now() / 1000);
    const res = await axios.get(
      'https://query1.finance.yahoo.com/v8/finance/chart/SPY',
      {
        params: { interval: '1d', period1, period2 },
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Accept': 'application/json',
        },
        timeout: 10000,
      }
    );
    const closes: number[] = res.data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(
      (c: any) => c != null
    ) ?? [];
    if (closes.length < 2) return null;
    return ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;
  } catch {
    return null;
  }
}

function sign(n: number): string { return n >= 0 ? '+' : ''; }

// ── V2 plan-outcome report ──────────────────────────────────
// TP / SL / TIME_EXIT rates, expectancy, and SPY excess computed over
// each pick's ACTUAL holding window (excessReturnPct is stored per pick
// at exit time) — the honest read on whether the trade plans work.
function printPlanOutcomes(picks: GradedPick[]): void {
  const BAR = '─'.repeat(53);
  console.log('TRADE-PLAN OUTCOMES  (exit = TP / SL / time, whichever first)');
  console.log(BAR);

  const rows: [string, GradedPick[]][] = [
    ['ALL', picks],
    ['BREAKOUT', picks.filter(p => p.strategy === 'BREAKOUT')],
    ['PULLBACK', picks.filter(p => p.strategy === 'PULLBACK')],
  ];
  for (const [label, set] of rows) {
    const n = set.length;
    if (n === 0) { console.log(`  ${label.padEnd(9)} N=0`); continue; }
    const tp = set.filter(p => p.exitOutcome === 'HIT_TARGET').length;
    const sl = set.filter(p => p.exitOutcome === 'HIT_STOP').length;
    const te = set.filter(p => p.exitOutcome === 'TIME_EXIT').length;
    const avgRet = set.reduce((s, p) => s + p.stockReturnPct, 0) / n;
    const excess = set.filter(p => typeof p.excessReturnPct === 'number').map(p => p.excessReturnPct as number);
    const avgExcess = excess.length ? excess.reduce((a, b) => a + b, 0) / excess.length : null;
    const held = set.filter(p => typeof p.daysHeld === 'number').map(p => p.daysHeld as number);
    const avgHeld = held.length ? held.reduce((a, b) => a + b, 0) / held.length : null;
    console.log(
      `  ${label.padEnd(9)} N=${String(n).padStart(3)}  ` +
      `TP ${((tp / n) * 100).toFixed(0).padStart(3)}%  SL ${((sl / n) * 100).toFixed(0).padStart(3)}%  TIME ${((te / n) * 100).toFixed(0).padStart(3)}%  ` +
      `avg ${sign(avgRet)}${avgRet.toFixed(2)}%  ` +
      `vs SPY ${avgExcess != null ? `${sign(avgExcess)}${avgExcess.toFixed(2)}pp` : 'n/a'}  ` +
      `held ${avgHeld != null ? avgHeld.toFixed(1) + 'd' : 'n/a'}` +
      (n < 10 ? '  ⚠️ N<10 — pure noise' : '')
    );
  }
  console.log('');
}

// `picksOverride` lets the backtest harness (Step 3) feed graded replay
// picks through this exact same report — e.g. one run per strategy for a
// Pullback-vs-Breakout head-to-head — instead of reading the live file.
// With NO override it now reports each exit regime separately: the V2
// trade-plan record first (with plan-outcome rates), then the legacy V1
// weekly record — the two are never mixed into one number.
export async function runEvaluation(picksOverride?: GradedPick[], label?: string): Promise<void> {
  if (!picksOverride) {
    const all = loadGraded();
    const v2 = all.filter(g => regimeOf(g) === 'V2_TRADE_PLAN');
    const v1 = all.filter(g => regimeOf(g) === 'V1_WEEKLY');
    await evaluateSet(v2, label ?? 'V2 TRADE-PLAN REGIME (current)');
    if (v2.length > 0) printPlanOutcomes(v2);
    if (v1.length > 0) {
      await evaluateSet(v1, 'V1 WEEKLY REGIME (legacy — weekly drift scoring, different exit rules)');
    }
    return;
  }
  await evaluateSet(picksOverride.filter(g => g.outcome !== 'OPEN'), label);
}

async function evaluateSet(picks: GradedPick[], label?: string): Promise<void> {
  const n = picks.length;

  const BAR  = '─'.repeat(53);
  const DBAR = '═'.repeat(53);

  console.log('\n' + DBAR);
  console.log(`  STOCK BOT — HONEST PERFORMANCE EVALUATION${label ? ` — ${label}` : ''}`);
  console.log(`  ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`);
  console.log(DBAR + '\n');

  // ── Sample size ──────────────────────────────────────────
  console.log('SAMPLE SIZE');
  console.log(BAR);

  if (n === 0) {
    console.log('  No graded picks yet.');
    console.log('  Run --scorecard first, then come back after 2-3 weeks of paper trading.');
    console.log('\n' + DBAR + '\n');
    return;
  }

  const sortedByDate = [...picks].sort((a, b) => a.pickedDate.localeCompare(b.pickedDate));
  const earliest = sortedByDate[0].pickedDate;
  const latest   = sortedByDate[sortedByDate.length - 1].pickedDate;
  const weeksCovered = Math.max(
    1,
    (new Date(latest).getTime() - new Date(earliest).getTime()) / (1000 * 60 * 60 * 24 * 7)
  );

  console.log(`  N = ${n} graded picks`);
  console.log(`  Period: ${new Date(earliest).toLocaleDateString()} → ${new Date(latest).toLocaleDateString()}  (${weeksCovered.toFixed(1)} weeks)`);

  if (n < 10) {
    console.log(`\n  ⚠️  BELOW MINIMUM THRESHOLD`);
    console.log(`  Fewer than 10 picks is statistical noise. A coin flip`);
    console.log(`  produces results like this by chance. Do not make a`);
    console.log(`  funding decision on this data.\n`);
  } else if (n < 25) {
    console.log(`\n  ⚠️  Small sample — treat conclusions as tentative.`);
    console.log(`  Need 25+ picks across varied market conditions before`);
    console.log(`  the numbers become reliable.\n`);
  } else {
    console.log(`\n  ✅ Sample size adequate for preliminary conclusions.\n`);
  }

  // ── Win rate (the misleading number) ────────────────────
  const wins   = picks.filter(p => p.outcome === 'WIN');
  const losses = picks.filter(p => p.outcome === 'LOSS');
  const winRate = (wins.length / n) * 100;

  // OPTIONS_CALL is a closed historical category — no new options picks since
  // July 2026, but old grades stay in the record and are still reported here.
  const optPicks = picks.filter(p => p.pickType === 'OPTIONS_CALL');
  const stkPicks = picks.filter(p => p.pickType === 'STOCK_LONG');
  const optWins  = optPicks.filter(p => p.outcome === 'WIN').length;
  const stkWins  = stkPicks.filter(p => p.outcome === 'WIN').length;

  console.log('WIN RATE  (the number that fools people)');
  console.log(BAR);
  console.log(`  Overall:  ${wins.length}W / ${losses.length}L  =  ${winRate.toFixed(0)}%`);
  if (optPicks.length) {
    const r = ((optWins / optPicks.length) * 100).toFixed(0);
    console.log(`  Options (historical):  ${optWins}W / ${optPicks.length - optWins}L  =  ${r}%`);
  }
  if (stkPicks.length) {
    const r = ((stkWins / stkPicks.length) * 100).toFixed(0);
    console.log(`  Stocks:   ${stkWins}W / ${stkPicks.length - stkWins}L  =  ${r}%`);
  }
  console.log(`\n  ⚠️  A 70% win rate with large losers still loses money.`);
  console.log(`  Win rate alone tells you nothing. See Expectancy below.\n`);

  // ── Expectancy (the real verdict) ───────────────────────
  const avgStock    = picks.reduce((s, p) => s + p.stockReturnPct, 0) / n;
  const avgWinStock = wins.length  ? wins.reduce((s, p)   => s + p.stockReturnPct, 0) / wins.length   : 0;
  const avgLosStock = losses.length ? losses.reduce((s, p) => s + p.stockReturnPct, 0) / losses.length : 0;

  const optPnls   = optPicks.map(p => estimatedOptionsPnl(p.stockReturnPct, p.outcome));
  const avgOptPnl = optPnls.length ? optPnls.reduce((a, b) => a + b, 0) / optPnls.length : null;

  console.log('EXPECTANCY  (the number that actually matters)');
  console.log(BAR);
  console.log(`  Stock return across all ${n} picks:`);
  console.log(`    Avg: ${sign(avgStock)}${avgStock.toFixed(1)}%  |  Wins avg: +${avgWinStock.toFixed(1)}%  |  Losses avg: ${avgLosStock.toFixed(1)}%`);

  if (avgOptPnl !== null && optPicks.length > 0) {
    const optWinPnls  = optPicks.filter(p => p.outcome === 'WIN').map(p => estimatedOptionsPnl(p.stockReturnPct, p.outcome));
    const optLossPnls = optPicks.filter(p => p.outcome === 'LOSS').map(_ => -100);
    const avgOptWin   = optWinPnls.length  ? optWinPnls.reduce((a, b)  => a + b, 0) / optWinPnls.length  : 0;
    const avgOptLoss  = optLossPnls.length ? optLossPnls.reduce((a, b) => a + b, 0) / optLossPnls.length : 0;

    console.log(`\n  Estimated options P&L — HISTORICAL picks only (${optPicks.length} picks, ${OPTIONS_LEVERAGE}× leverage on wins, −100% on losses):`);
    console.log(`    Wins  (N=${optWins}): avg stock +${avgWinStock.toFixed(1)}% → est. option ${sign(avgOptWin)}${avgOptWin.toFixed(0)}%`);
    console.log(`    Losses (N=${optPicks.length - optWins}): est. option −100%`);
    console.log(`    Weighted expectancy: ${sign(avgOptPnl)}${avgOptPnl.toFixed(0)}% per options pick`);

    if (avgOptPnl > 0) {
      console.log(`\n  ✅ Positive estimated expectancy — but this is a rough model.`);
      console.log(`  Real IV drag, time decay, and bid/ask spread reduce this number.`);
    } else {
      console.log(`\n  ❌ Negative estimated expectancy.`);
      console.log(`  A positive stock win rate is not enough to overcome options decay.`);
      console.log(`  (This is why options picks were retired in July 2026.)`);
    }

    console.log(`\n  Reality check: options P&L is always more extreme than the stock move.`);
    console.log(`  +8% stock WIN  ≈  +${(8 * OPTIONS_LEVERAGE).toFixed(0)}% option (rough, depends on delta/IV).`);
    console.log(`  Stock LOSS near stop  ≈  −100% option (full premium wipeout).\n`);
  }

  // ── Directional environment ──────────────────────────────
  const upPicks   = picks.filter(p => p.stockReturnPct > 0);
  const downPicks = picks.filter(p => p.stockReturnPct <= 0);

  console.log('DIRECTIONAL ENVIRONMENT');
  console.log(BAR);
  console.log(`  Stock ended up:   ${upPicks.length} of ${n}  (${((upPicks.length / n) * 100).toFixed(0)}%)`);
  console.log(`  Stock ended down: ${downPicks.length} of ${n}  (${((downPicks.length / n) * 100).toFixed(0)}%)`);
  console.log(`\n  Sample spans ${weeksCovered.toFixed(1)} weeks.`);

  if (upPicks.length > downPicks.length * 2) {
    console.log(`  ⚠️  Heavily skewed toward up-moves — this likely reflects a rising`);
    console.log(`  market, not the bot's skill. This column stays empty of meaning`);
    console.log(`  until a downturn fills it in. Do not conclude the bot has edge\n`);
    console.log(`  until it has been tested through a genuine pullback.\n`);
  } else {
    console.log(`  Sample includes both up and down outcomes — more informative.\n`);
  }

  // ── Losing streak ────────────────────────────────────────
  const streak = maxLosingStreak(sortedByDate);

  console.log('WORST LOSING STREAK');
  console.log(BAR);
  console.log(`  Max consecutive losses: ${streak}`);

  if (streak >= 3) {
    console.log(`\n  ⚠️  ${streak} consecutive losses.`);
    console.log(`  That drawdown must be survivable without blowing the account.`);
    console.log(`  Rule of thumb: never risk more than 1-2% of account per pick.\n`);
  } else if (streak > 0) {
    console.log(`  (streak will grow with more picks — size positions conservatively)\n`);
  } else {
    console.log(`  No losing streak yet — almost certainly reflects small sample.\n`);
  }

  // ── vs. SPY ──────────────────────────────────────────────
  console.log('vs. BENCHMARK (SPY)');
  console.log(BAR);

  const spyReturn = await fetchSpyReturnSince(earliest);
  if (spyReturn !== null) {
    console.log(`  SPY return over same period:  ${sign(spyReturn)}${spyReturn.toFixed(1)}%`);
    console.log(`  Bot avg stock return:         ${sign(avgStock)}${avgStock.toFixed(1)}%`);
    const alpha = avgStock - spyReturn;
    if (alpha > 5) {
      console.log(`\n  ✅ Outperforming SPY by ${alpha.toFixed(1)}pp on stock returns.`);
      console.log(`  Note: this must also hold after transaction costs to matter.\n`);
    } else if (alpha > 0) {
      console.log(`\n  ⚠️  Marginally ahead of SPY (+${alpha.toFixed(1)}pp stock return).`);
      console.log(`  After transaction costs, possibly behind SPY.`);
      console.log(`  "Just buy SPY" may be the better trade.\n`);
    } else {
      console.log(`\n  ❌ Underperforming SPY by ${Math.abs(alpha).toFixed(1)}pp.`);
      console.log(`  The bot is adding single-stock risk without beating the index.\n`);
    }
  } else {
    console.log(`  Could not fetch SPY data for comparison period.`);
    console.log(`  The bar: beat SPY consistently or the bot adds risk without reward.\n`);
  }

  // ── Verdict ──────────────────────────────────────────────
  console.log('VERDICT');
  console.log(BAR);

  if (n < 10) {
    console.log(`  ⏳ INCONCLUSIVE — too few picks to judge.`);
    console.log(`  Paper-trade for 4-6 more weeks across mixed conditions,`);
    console.log(`  then re-run --evaluate.\n`);
  } else if (n < 25) {
    console.log(`  ⚠️  PROMISING BUT UNPROVEN — early numbers look reasonable,`);
    console.log(`  but sample is too small and market conditions too uniform.`);
    console.log(`  Paper-trade through a 5-10% market pullback before going live.\n`);
  } else {
    // Options expectancy only gates the verdict when the sample actually
    // contains historical OPTIONS_CALL picks; a stock-only sample isn't
    // penalized for a category that no longer exists.
    const hasOptEdge = avgOptPnl === null || avgOptPnl > 10;
    const hasSpyEdge = spyReturn !== null && avgStock > spyReturn + 2;
    if (hasOptEdge && hasSpyEdge) {
      console.log(`  ✅ SHOWS EDGE — positive expectancy, beats SPY, adequate sample.`);
      console.log(`  Start with minimum position size (1% risk per pick) and compare`);
      console.log(`  live fills vs. paper prices before scaling.\n`);
    } else {
      console.log(`  ⚠️  MIXED SIGNALS — some metrics positive, others not.`);
      console.log(`  Extend paper-trade period through varied market conditions`);
      console.log(`  and re-evaluate at N=30+.\n`);
    }
  }

  console.log(DBAR + '\n');
}
