// ============================================================
// TEST — positionSizing (pure sizing module)
// Run: npm run test:sizing
// ============================================================

import assert from 'assert';
import { sizePicks, MIN_NOTIONAL, SHARE_DECIMALS } from './positionSizing';

function pick(ticker: string, entryPrice: number, confidenceScore: number, strategy = 'PULLBACK') {
  return { ticker, entryPrice, confidenceScore, strategy };
}

// ── 1. Normal case: equal notional, fractional shares ───────
{
  const { orders, skipped, totalCost } = sizePicks(200, [
    pick('AAA', 42.15, 80),
    pick('BBB', 187.30, 75),
    pick('CCC', 9.87, 70),
  ]);
  assert.strictEqual(orders.length, 3);
  assert.strictEqual(skipped.length, 0);

  // Each order gets ~$66.67 of notional; shares floored to 5 decimals.
  const notional = 200 / 3;
  for (const o of orders) {
    const rawShares = notional / o.entryPrice;
    const floored = Math.floor(rawShares * 10 ** SHARE_DECIMALS) / 10 ** SHARE_DECIMALS;
    assert.strictEqual(o.shares, floored, `${o.ticker} shares floored to 5dp`);
    const shareStr = String(o.shares).split('.')[1] ?? '';
    assert.ok(shareStr.length <= SHARE_DECIMALS, `${o.ticker} share precision`);
    assert.ok(o.costBasis <= notional, `${o.ticker} cost within its allocation (cents floored, never up)`);
    assert.strictEqual(o.costBasis, Math.floor(o.shares * o.entryPrice * 100 + 1e-9) / 100);
  }
  assert.ok(totalCost <= 200, 'never allocates more than available cash');
  assert.ok(totalCost > 195, 'flooring only leaves slivers behind');
  console.log(`1. normal case ✅  3 orders, total $${totalCost.toFixed(2)} of $200`);
}

// ── 2. Thin cash: fund by confidence order, skip the rest ───
{
  // $12 across 3 picks would be $4 each (< $5 min) → fund only
  // floor(12/5)=2 picks, chosen by confidenceScore descending.
  const { orders, skipped, totalCost } = sizePicks(12, [
    pick('LOW', 10, 60),
    pick('HIGH', 20, 90),
    pick('MID', 15, 75),
  ]);
  assert.strictEqual(orders.length, 2);
  assert.deepStrictEqual(orders.map(o => o.ticker).sort(), ['HIGH', 'MID'], 'highest-confidence picks funded');
  assert.strictEqual(skipped.length, 1);
  assert.strictEqual(skipped[0].ticker, 'LOW');
  assert.ok(/thin/.test(skipped[0].reason), 'skip reason explains the thin-cash cut');
  for (const o of orders) assert.ok(o.costBasis >= MIN_NOTIONAL - 0.01, 'funded positions clear the minimum');
  assert.ok(totalCost <= 12);
  console.log(`2. thin cash ✅  funded HIGH+MID at $${(12 / 2).toFixed(2)} each, skipped LOW`);
}

// ── 3. Cash below the $5 floor: everything skipped ──────────
{
  const { orders, skipped, totalCost } = sizePicks(4.5, [pick('AAA', 10, 80), pick('BBB', 20, 70)]);
  assert.strictEqual(orders.length, 0);
  assert.strictEqual(skipped.length, 2);
  assert.ok(skipped.every(s => /below the \$5 minimum/.test(s.reason)));
  assert.strictEqual(totalCost, 0);
  console.log('3. sub-$5 cash ✅  all picks skipped with reasons');
}

// ── 4. Zero picks ───────────────────────────────────────────
{
  const { orders, skipped, totalCost } = sizePicks(200, []);
  assert.deepStrictEqual(orders, []);
  assert.deepStrictEqual(skipped, []);
  assert.strictEqual(totalCost, 0);
  console.log('4. zero picks ✅  empty result, no throw');
}

// ── 5. Bad prices are skipped, good picks still fund ────────
{
  const { orders, skipped } = sizePicks(100, [
    pick('GOOD', 25, 80),
    { ticker: 'BADPRICE', entryPrice: 0, confidenceScore: 90, strategy: 'BREAKOUT' },
  ]);
  assert.strictEqual(orders.length, 1);
  assert.strictEqual(orders[0].ticker, 'GOOD');
  assert.strictEqual(orders[0].costBasis, 100, 'lone fundable pick gets the full allocation');
  assert.strictEqual(skipped.length, 1);
  assert.ok(/no usable entry price/.test(skipped[0].reason));
  console.log('5. bad price ✅  skipped, remaining pick takes full cash');
}

console.log('\nALL POSITION-SIZING TESTS PASSED');
