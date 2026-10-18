import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recommend } from '../src/shared/allocation.js';
import { demoEvent } from '../src/server/demo.js';
import { evaluate } from '../src/server/trading.js';
import type { Analysis } from '../src/shared/types.js';

test('Budget guide keeps cash, buys only one side and respects liquidity and stale data', () => {
  const now = Date.parse('2026-10-18T12:20:00Z');
  const event = demoEvent(now);
  const draws = new Float64Array(100).fill(event.markets[2]!.lower);
  const analysis = {
    dataset: 'demo',
    fresh: true,
    event,
    positions: evaluate(draws, event, 100, 100, 5, true, now),
  } as Analysis;
  const result = recommend(analysis, 200, 0.01, 0.05, now);
  assert.ok(result);
  assert.ok(result.total > 0 && result.total <= 50);
  assert.ok(result.expectedProfit > 0);
  assert.equal(recommend(analysis, 0, 0.01, 0.05, now), null);
  assert.equal(recommend({ ...analysis, fresh: false }, 200, 0.01, 0.05, now), null);
  assert.equal(
    recommend({ ...analysis, dataset: 'xtracker' }, 200, 0.01, 0.05, now + 121000),
    null,
  );
  for (const market of event.markets)
    for (const book of Object.values(market.books)) for (const ask of book.asks) ask.size = 0.001;
  assert.equal(recommend(analysis, 200, 0.01, 0.05, now), null);
});

import { allocateBank } from '../src/shared/allocation.js';
const allocationNow = Date.parse('2026-10-18T12:20:00Z');
function binaryAnalysis(probability = 0.5, price = 0.6, side: 'yes' | 'no' = 'yes') {
  const event = demoEvent(allocationNow);
  event.markets = event.markets.slice(0, 2).map((market, index) => ({
    ...market,
    lower: index,
    upper: index === 0 ? 0 : null,
    books: {
      [side]: {
        asks: [{ price, size: 100000 }],
        fetched_at: new Date(allocationNow).toISOString(),
      },
    },
  }));
  const draws = Float64Array.from({ length: 100 }, (_, i) => (i < probability * 100 ? 0 : 1));
  return {
    dataset: 'demo',
    fresh: true,
    event,
    positions: evaluate(draws, event, 100, 0, 5, true, allocationNow),
  } as Analysis;
}
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);

test('Full-bank scenario remains available with negative EV while cash is recommended', () => {
  const analysis = binaryAnalysis();
  assert.equal(recommend(analysis, 100, 0, 0.05, allocationNow), null);
  const plan = allocateBank(analysis, 100, 0, allocationNow);
  assert.equal(plan.rows.length, 2);
  assert.equal(plan.invested, 100);
  assert.equal(plan.cash, 0);
  assert.deepEqual(
    plan.rows.map((row) => row.total),
    [50, 50],
  );
  close(plan.expectedProfit, 100 / 0.6 / 2 - 100);
  close(plan.worstProfit, plan.expectedProfit);
  close(plan.lossProbability, 1);
  close(
    plan.expectedProfit,
    plan.rows.reduce((sum, row) => sum + row.expectedProfit, 0),
  );
});

test('Joint NO payouts preserve dependence: complementary winning contracts cannot both lose', () => {
  const plan = allocateBank(binaryAnalysis(0.5, 0.4, 'no'), 100, 0, allocationNow);
  assert.ok(plan.rows.every((row) => row.side === 'NO'));
  close(plan.expectedProfit, 25);
  close(plan.worstProfit, 25);
  close(plan.lossProbability, 0);
});

test('Allocation favors the more likely range, honors fees and depth, and leaves unfilled cash', () => {
  const analysis = binaryAnalysis(0.8, 0.5);
  const plan = allocateBank(analysis, 123.45, 0.01, allocationNow);
  assert.equal(plan.invested, 123.45);
  assert.ok(
    plan.rows.find((row) => row.marketId === analysis.event!.markets[0].id)!.total > 61.725,
  );
  for (const row of plan.rows) close(row.total, row.shares * 0.5 * 1.01);
  for (const market of analysis.event!.markets)
    market.books.yes!.asks = [
      { price: 0.5, size: 3 },
      { price: 0.6, size: 4 },
    ];
  const thin = allocateBank(analysis, 100, 0.01, allocationNow);
  assert.ok(thin.rows.every((row) => row.shares <= 7 + 1e-9));
  assert.ok(thin.invested > 0 && thin.invested <= 2 * (3 * 0.5 + 4 * 0.6) * 1.01);
  close(thin.invested + thin.cash, 100);
  assert.match(thin.warnings.join(' '), /глубины/);
});

test('Unlisted ranges keep their probability and downside instead of being normalized away', () => {
  const analysis = binaryAnalysis(0.6, 0.4);
  analysis.event!.markets = analysis.event!.markets.slice(0, 1);
  const plan = allocateBank(analysis, 100, 0, allocationNow);
  assert.equal(plan.rows.length, 1);
  close(plan.expectedProfit, 50);
  close(plan.worstProfit, -100);
  close(plan.lossProbability, 0.4);
});

test('Stale or ineligible signals retain a labeled hypothetical plan; no asks retain cash', () => {
  const analysis = binaryAnalysis();
  analysis.dataset = 'live';
  analysis.fresh = false;
  analysis.positions.forEach((row) => {
    row.signal = false;
  });
  const plan = allocateBank(analysis, 100, 0, allocationNow + 121000);
  assert.equal(plan.invested, 100);
  assert.match(plan.warnings.join(' '), /свежести/);
  assert.match(plan.warnings.join(' '), /120 секунд/);
  for (const market of analysis.event!.markets) market.books.yes!.asks = [];
  const empty = allocateBank(analysis, 100, 0, allocationNow);
  assert.equal(empty.invested, 0);
  assert.equal(empty.cash, 100);
  assert.match(empty.warnings.join(' '), /Нет доступных/);
});

test('Rejects overlapping or inconsistent resolution scenarios and malformed budgets', () => {
  const analysis = binaryAnalysis();
  for (const budget of [NaN, Infinity, -1, 0, 0.001, 1000001])
    assert.equal(allocateBank(analysis, budget, 0, allocationNow).rows.length, 0);
  analysis.event!.markets[0].upper = 1;
  assert.equal(allocateBank(analysis, 100, 0, allocationNow).rows.length, 0);
  analysis.event!.markets[0].upper = 0;
  analysis.positions.find(
    (row) => row.market_id === analysis.event!.markets[0].id && row.side === 'YES',
  )!.probability = 0.8;
  assert.equal(allocateBank(analysis, 100, 0, allocationNow).rows.length, 0);
});
