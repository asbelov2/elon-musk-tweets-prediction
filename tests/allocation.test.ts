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
