// ============================================================
// TEST — paper account lifecycle (fully offline)
// Seeds $200, buys 3 picks Monday, marks daily, hits one target
// and one stop, force-closes the third at week end, and checks
// T+1 settlement timing, equity math (cash + invested = equity to
// the penny), frozen-quote carry, and equityHistory behavior.
// Run: npm run test:paper
// ============================================================

import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { StockPick, TechnicalIndicators } from './types';

// Sandbox: chdir into a temp dir BEFORE loading paperAccount, so its
// data/paper-account.json path resolves inside the sandbox. require()
// (not a hoisted import) makes the ordering explicit.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-account-test-'));
process.chdir(tmp);
process.env.PAPER_STARTING_BALANCE = '200';

/* eslint-disable @typescript-eslint/no-var-requires */
const {
  paperBuyPicks, paperDailyMark, paperApplyGrades, accountEquity,
  loadPaperAccount, getPaperSummary,
} = require('./paperAccount');

const ACCOUNT = path.join(tmp, 'data', 'paper-account.json');
const readAcct = () => JSON.parse(fs.readFileSync(ACCOUNT, 'utf-8'));
const r2 = (x: number) => Math.round(x * 100) / 100;

const technicals: TechnicalIndicators = {
  ticker: 'X', rsi: 50, macd: 0, macdSignal: 0,
  sma20: 0, sma50: 0, sma200: 0, support: 0, resistance: 0, trend: 'bullish',
};

function mkPick(ticker: string, price: number, target: number, stop: number, confidence: number, strategy: 'PULLBACK' | 'BREAKOUT'): StockPick {
  return {
    ticker, name: `${ticker} Inc`, pickType: 'STOCK_LONG',
    currentPrice: price, entryZone: { low: price * 0.99, high: price * 1.01 },
    targetPrice: target, stopLoss: stop, riskRewardRatio: 2.1,
    timeHorizon: '1-2 weeks', confidenceScore: confidence,
    catalysts: [], risks: [], summary: 'test', technicals, news: [],
    sector: 'Tech', addedAt: '2026-07-20T14:15:00.000Z', strategy,
  };
}

// ── Monday 2026-07-20: seed $200, buy 3 picks ───────────────
paperBuyPicks([
  mkPick('AAA', 40, 44, 37, 80, 'PULLBACK'),
  mkPick('BBB', 20, 22, 18.6, 75, 'BREAKOUT'),
  mkPick('CCC', 10, 11, 9.3, 70, 'PULLBACK'),
], '2026-07-20');

let acct = readAcct();
assert.strictEqual(acct.startingBalance, 200);
assert.strictEqual(acct.positions.length, 3);
const spent = r2(acct.positions.reduce((s: number, p: any) => s + p.costBasis, 0));
assert.strictEqual(r2(acct.cash + spent), 200, 'cash + cost of fills = starting balance');
assert.ok(acct.cash >= 0, 'cash never goes negative');
for (const p of acct.positions) {
  assert.ok(Math.abs(p.costBasis - 200 / 3) < 0.05, `${p.ticker} got an equal ~$66.67 slice`);
  const decimals = (String(p.shares).split('.')[1] ?? '').length;
  assert.ok(decimals <= 5, `${p.ticker} fractional shares at ≤5 decimals`);
}
// Day-0 equity: shares are floored to 5dp and cost to whole cents (so cash
// can never be overspent), which leaves < 1¢/position of sub-cent dust when
// the positions are marked back at the entry price. Bounded, not drift.
const day0 = accountEquity(acct);
assert.ok(Math.abs(day0 - 200) <= 0.03, `day-0 equity $${day0} within rounding dust of $200`);
console.log(`1. Monday buys ✅  3 fills totaling $${spent.toFixed(2)}, cash $${acct.cash.toFixed(2)}`);

// Re-running the same scan must not double-buy held names.
paperBuyPicks([mkPick('AAA', 41, 44, 37, 80, 'PULLBACK')], '2026-07-20');
acct = readAcct();
assert.strictEqual(acct.positions.length, 3, 'already-held ticker+strategy not re-bought');
console.log('2. duplicate-buy guard ✅');

// ── Tuesday: plain mark, no exits ───────────────────────────
(async () => {
  await paperDailyMark({ AAA: 41, BBB: 19.5, CCC: 10.1 }, new Set(), { today: '2026-07-21', spyClose: 500 });
  acct = readAcct();
  assert.strictEqual(acct.positions.length, 3);
  assert.strictEqual(acct.equityHistory.length, 1);
  let pt = acct.equityHistory[0];
  assert.strictEqual(pt.date, '2026-07-21');
  assert.strictEqual(pt.spyClose, 500);
  assert.strictEqual(r2(pt.cash + pt.invested), pt.equity, 'Tue: cash + invested = equity to the penny');
  console.log(`3. Tuesday mark ✅  equity $${pt.equity.toFixed(2)} (invested $${pt.invested.toFixed(2)})`);

  // ── Wednesday: AAA hits target, BBB hits stop, CCC marks ──
  await paperDailyMark({ AAA: 44.5, BBB: 18.5, CCC: 10.2 }, new Set(), { today: '2026-07-22', spyClose: 505 });
  acct = readAcct();
  assert.strictEqual(acct.positions.length, 1, 'AAA and BBB closed');
  assert.strictEqual(acct.positions[0].ticker, 'CCC');
  assert.strictEqual(acct.closedTrades.length, 2);

  const tgt = acct.closedTrades.find((t: any) => t.ticker === 'AAA');
  const stp = acct.closedTrades.find((t: any) => t.ticker === 'BBB');
  assert.strictEqual(tgt.reason, 'HIT_TARGET');
  assert.strictEqual(tgt.exitPrice, 44, 'sold at the TARGET price, not the through price');
  assert.strictEqual(stp.reason, 'HIT_STOP');
  assert.strictEqual(stp.exitPrice, 18.6, 'sold at the STOP price, not the through price');

  // Proceeds are pending, settling next trading day (T+1).
  assert.strictEqual(acct.pendingSettlement.length, 2);
  for (const p of acct.pendingSettlement) {
    assert.strictEqual(p.availableDate, '2026-07-23', 'sale on Wed 07-22 settles Thu 07-23');
  }
  const pendingSum = r2(acct.pendingSettlement.reduce((s: number, p: any) => s + p.amount, 0));
  assert.strictEqual(pendingSum, r2(tgt.shares * 44 + stp.shares * 18.6), 'pending = exact sale proceeds');

  pt = acct.equityHistory[1];
  assert.strictEqual(acct.equityHistory.length, 2, 'one point per daily check');
  assert.strictEqual(r2(pt.cash + pt.invested), pt.equity, 'Wed: cash(+pending) + invested = equity');
  assert.strictEqual(pt.invested, r2(acct.positions[0].shares * 10.2), 'invested = CCC at its fresh mark');
  console.log(`4. Wednesday exits ✅  target +$${tgt.pnlDollars.toFixed(2)}, stop -$${Math.abs(stp.pnlDollars).toFixed(2)}, $${pendingSum.toFixed(2)} settling T+1`);

  // ── Thursday: settlement matures; CCC quote is FROZEN ─────
  const cashBefore = acct.cash;
  await paperDailyMark({}, new Set(['CCC']), { today: '2026-07-23', spyClose: 507 });
  acct = readAcct();
  assert.strictEqual(acct.pendingSettlement.length, 0, 'T+1 proceeds swept into cash');
  assert.strictEqual(acct.cash, r2(cashBefore + pendingSum), 'settled cash grew by exactly the proceeds');
  const ccc = acct.positions[0];
  assert.strictEqual(ccc.markFrozen, true, 'frozen ticker flagged for the dashboard');
  assert.strictEqual(ccc.lastMark, 10.2, 'frozen quote NOT marked — carries last good price');
  assert.strictEqual(ccc.lastMarkDate, '2026-07-22');
  assert.strictEqual(acct.equityHistory.length, 3);
  pt = acct.equityHistory[2];
  assert.strictEqual(r2(pt.cash + pt.invested), pt.equity, 'Thu: equity math still reconciles');
  console.log(`5. Thursday ✅  settlement swept ($${pendingSum.toFixed(2)} → cash), frozen CCC carried at $${ccc.lastMark}`);

  // Same-day re-run replaces the point instead of appending a duplicate.
  await paperDailyMark({}, new Set(['CCC']), { today: '2026-07-23', spyClose: 507 });
  acct = readAcct();
  assert.strictEqual(acct.equityHistory.length, 3, 'same-date re-mark replaces, never duplicates');
  console.log('6. same-day re-mark ✅  no duplicate equity point');

  // ── Monday 2026-07-27: weekly grading force-closes CCC ────
  paperApplyGrades([{
    ticker: 'CCC', pickType: 'STOCK_LONG', strategy: 'PULLBACK',
    entryPrice: 10, targetPrice: 11, stopLoss: 9.3, finalPrice: 10.5,
    pickedDate: '2026-07-20T14:15:00.000Z', gradedDate: '2026-07-27T14:15:00.000Z',
    outcome: 'WIN', stockReturnPct: 5, note: 'Closed between levels (up)',
  }], '2026-07-27');
  acct = readAcct();
  assert.strictEqual(acct.positions.length, 0, 'all positions closed');
  assert.strictEqual(acct.closedTrades.length, 3);
  const wc = acct.closedTrades.find((t: any) => t.ticker === 'CCC');
  assert.strictEqual(wc.reason, 'WEEK_CLOSE');
  assert.strictEqual(wc.exitPrice, 10.5, 'force-closed at the graded final price');
  assert.strictEqual(acct.pendingSettlement.length, 1);
  assert.strictEqual(acct.pendingSettlement[0].availableDate, '2026-07-28');
  console.log('7. week-close ✅  CCC sold at graded $10.50, settles 2026-07-28');

  // ── Final reconciliation: every penny accounted for ───────
  const finalEquity = accountEquity(acct);
  const totalPnl = r2(acct.closedTrades.reduce((s: number, t: any) => s + t.pnlDollars, 0));
  assert.strictEqual(finalEquity, r2(200 + totalPnl + (200 - spent - (200 - spent))),
    'equity = start + Σ realized P&L');
  assert.strictEqual(finalEquity, r2(200 + totalPnl), 'pennies reconcile end-to-end');

  const summary = getPaperSummary();
  assert.ok(summary, 'summary readable');
  assert.strictEqual(summary.equity, finalEquity);
  assert.strictEqual(summary.spyReturnPct, r2(((507 - 500) / 500) * 100), 'SPY benchmark from equityHistory');
  console.log(`8. reconciliation ✅  equity $${finalEquity.toFixed(2)} = $200 start ${totalPnl >= 0 ? '+' : '-'} $${Math.abs(totalPnl).toFixed(2)} realized P&L`);

  // ── Corrupt-file resilience: log and continue, never throw ─
  fs.writeFileSync(ACCOUNT, '{not json');
  assert.strictEqual(loadPaperAccount(), null, 'corrupt file → null, not a throw');
  await paperDailyMark({ AAA: 1 }, new Set(), { today: '2026-07-28', spyClose: 508 }); // must not throw
  paperBuyPicks([mkPick('DDD', 5, 6, 4.5, 70, 'PULLBACK')], '2026-07-28');            // must not throw
  assert.strictEqual(fs.readFileSync(ACCOUNT, 'utf-8'), '{not json', 'corrupt file left untouched for inspection');
  console.log('9. corrupt-file guard ✅  ops no-op, file preserved');

  console.log('\nALL PAPER-ACCOUNT LIFECYCLE TESTS PASSED');
})().catch(err => { console.error(err); process.exit(1); });
