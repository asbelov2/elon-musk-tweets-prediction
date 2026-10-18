import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { HourData, Side } from '../src/shared/types.js';
import { demoEvent, demoHours } from '../src/server/demo.js';
import { backtest, completeDays, fit, forecast, mean, simulate } from '../src/server/model.js';
import { Random } from '../src/server/random.js';
import { Store, readCsv } from '../src/server/storage.js';
import { DAY, HOUR, hour, localTime, parseTime } from '../src/server/time.js';
import { evaluate, fillOrder } from '../src/server/trading.js';

const now = Date.parse('2026-10-18T12:20:00Z'),
  cutoff = hour(now),
  data = new Map(demoHours(now));
const near = (actual: number, expected: number, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected} ± ${tolerance}`);

test('CSV parsing, idempotent upsert and compatibility with existing UTC database keys', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const ts = cutoff - 3 * HOUR;
  store.db
    .prepare('INSERT INTO hours VALUES (?,?,?,?)')
    .run('live', new Date(ts).toISOString().replace('.000Z', '+00:00'), 2, 'csv');
  const rows = readCsv(`\ufefftimestamp,count\r\n"${new Date(ts).toISOString()}",4\r\n`);
  store.saveHours(rows, 'live', 'csv', now);
  store.saveHours(rows, 'live', 'csv', now);
  assert.deepEqual([...store.load().data], [[ts, 4]]);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM hours').get()?.n, 1);
});
test('Invalid CSV and naive timestamps are rejected', () => {
  for (const csv of [
    'x,y\n1,2',
    'timestamp,count\n2026-01-01T00:00:00Z,3.0',
    'timestamp,count\n2026-01-01T00:00:00Z,-1',
    'timestamp,count\n2026-01-01T00:00:00,2',
  ])
    assert.throws(() => readCsv(csv));
  assert.equal(parseTime('2026-01-01T03:00:00+03:00'), parseTime('2026-01-01T00:00:00Z'));
  assert.throws(() => parseTime('2026-02-30T00:00:00Z'));
});
test('Import validation is atomic and rejects duplicate, future and partial hours', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const ts = cutoff - HOUR;
  store.saveHours([[ts, 2]], 'live', 'csv', now);
  assert.throws(() =>
    store.saveHours(
      [
        [ts, 8],
        [ts - HOUR, -1],
      ],
      'live',
      'csv',
      now,
    ),
  );
  assert.equal(store.load().data.get(ts), 2);
  assert.throws(
    () =>
      store.saveHours(
        [
          [ts, 2],
          [ts, 3],
        ],
        'live',
        'csv',
        now,
      ),
    /повторяется/,
  );
  for (const time of [ts + 1, cutoff, cutoff + DAY])
    assert.throws(() => store.saveHours([[time, 3]], 'live', 'csv', now));
});
test('Demo data never leaks into live history', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.saveHours([[cutoff - HOUR, 4]], 'demo', 'synthetic', now);
  assert.equal(store.load('live').data.size, 0);
});
test('Previously saved market snapshots remain readable', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const event = demoEvent(now);
  store.snapshot('demo', event);
  assert.deepEqual(store.getSnapshot('demo'), event);
  assert.equal(store.getSnapshot('absent'), null);
});
test('TS fit matches reference model parameters for UTC and New York', () => {
  interface Reference {
    start: string;
    cutoff: string;
    counts: number[];
    fits: Record<
      string,
      {
        mean: number;
        variance: number;
        shape: number;
        effective_days: number;
        uncertainty_shape: number;
        rates: number[][];
        days: number;
      }
    >;
  }
  const reference = JSON.parse(
    readFileSync('tests/fixtures/model-reference.json', 'utf8'),
  ) as Reference;
  const history: HourData = new Map(
    reference.counts.map((c, i) => [parseTime(reference.start) + i * HOUR, c]),
  );
  for (const [zone, expected] of Object.entries(reference.fits)) {
    const actual = fit(history, parseTime(reference.cutoff), zone);
    for (const key of ['mean', 'variance', 'shape', 'effective_days', 'uncertainty_shape'] as const)
      near(actual[key], expected[key], Math.max(1e-10, Math.abs(expected[key]) * 1e-12));
    assert.equal(actual.days.length, expected.days);
    actual.rates.forEach((day, d) => day.forEach((rate, h) => near(rate, expected.rates[d][h])));
  }
});
test('Forecast includes observed posts once, normalizes probabilities and orders quantiles', () => {
  const start = cutoff - 3 * DAY,
    { draws, result } = forecast(data, start, cutoff + 2 * DAY, 'UTC', now, 5000);
  assert.equal(
    result.current_count,
    [...data].filter(([t]) => t >= start && t < cutoff).reduce((a, [, c]) => a + c, 0),
  );
  assert.ok(draws.every((x) => x >= result.current_count));
  near(
    result.histogram.reduce((a, b) => a + b.probability, 0),
    1,
  );
  assert.ok(result.low <= result.median && result.median <= result.high);
});
test('Missing hour is unknown, not zero', () => {
  const changed = new Map(data);
  changed.delete(cutoff - 2 * HOUR);
  assert.throws(() => forecast(changed, cutoff - DAY, cutoff + DAY, 'UTC', now), /отсутствуют/);
});
test('Stale history and isolated recent observations disable eligibility', () => {
  const stale = new Map([...data].filter(([t]) => t < cutoff - 6 * HOUR));
  assert.equal(forecast(stale, cutoff - DAY, cutoff + DAY, 'UTC', now, 500).result.fresh, false);
  const isolated = new Map([...data].filter(([t]) => t < cutoff - 10 * DAY));
  isolated.set(cutoff - HOUR, 2);
  assert.equal(forecast(isolated, cutoff, cutoff + DAY, 'UTC', now, 500).result.fresh, false);
});
test('Future data and incomplete days never leak into a fit', () => {
  const baseline = fit(data, cutoff, 'UTC'),
    changed = new Map(data);
  for (let i = 0; i < 24; i++) changed.set(cutoff + i * HOUR, 9999);
  changed.set(cutoff - HOUR, 9999);
  assert.deepEqual(fit(changed, cutoff, 'UTC').rates, baseline.rates);
});
test('Adding known posts shifts every total by the same amount', () => {
  const start = cutoff - 6 * HOUR,
    changed = new Map(data);
  for (let i = 0; i < 6; i++) changed.set(start + i * HOUR, changed.get(start + i * HOUR)! + 2);
  const a = forecast(data, start, cutoff + 12 * HOUR, 'UTC', now, 1000).draws;
  const b = forecast(changed, start, cutoff + 12 * HOUR, 'UTC', now, 1000).draws;
  assert.ok(a.every((n, i) => b[i] - n === 12));
});
test('Completed windows are deterministic and future windows do not count a gap', () => {
  const completed = forecast(data, cutoff - 8 * HOUR, cutoff - 2 * HOUR, 'UTC', now, 500);
  assert.equal(completed.result.low, completed.result.high);
  assert.ok(completed.draws.every((d) => d === completed.result.current_count));
  const future = forecast(data, cutoff + 2 * DAY, cutoff + 3 * DAY, 'UTC', now, 500).result;
  assert.equal(future.current_count, 0);
  assert.ok(future.mean > 0);
});
test('Short/zero history, invalid windows and long horizons are rejected', () => {
  assert.throws(
    () => fit(new Map([...data].filter(([t]) => t > cutoff - 7 * DAY)), cutoff, 'UTC'),
    /14/,
  );
  assert.throws(() => fit(new Map([...data].map(([t]) => [t, 0])), cutoff, 'UTC'), /нулей/);
  assert.throws(() => forecast(data, cutoff + 1, cutoff + DAY, 'UTC', now));
  assert.throws(() => forecast(data, cutoff, cutoff + 32 * DAY, 'UTC', now));
});
test('Seeded random sampling is reproducible and uniforms exclude endpoints', () => {
  const a = new Random(1),
    b = new Random(1);
  for (let i = 0; i < 1000; i++) {
    const x = a.uniform();
    assert.equal(x, b.uniform());
    assert.ok(x > 0 && x < 1);
  }
});
test('Gamma samples match means and variances, including shape below one', () => {
  for (const shape of [0.3, 3, 100]) {
    const rng = new Random(118),
      n = 100_000,
      draws = Float64Array.from({ length: n }, () => rng.gamma(shape, 2)),
      mu = mean(draws);
    near(mu, shape * 2, 6 * Math.sqrt((shape * 4) / n));
    near(mean(draws.map((d) => (d - mu) ** 2)), shape * 4, shape * 4 * 0.07);
  }
});
test('Poisson small and large mean algorithms match count moments', () => {
  for (const lambda of [0.5, 29, 30, 1000, 10000]) {
    const rng = new Random(119),
      n = 60_000,
      draws = Float64Array.from({ length: n }, () => rng.poisson(lambda)),
      mu = mean(draws);
    near(mu, lambda, 6 * Math.sqrt(lambda / n));
    near(mean(draws.map((d) => (d - mu) ** 2)), lambda, lambda * 0.04);
    assert.ok(draws.every((d) => d >= 0 && Number.isInteger(d)));
  }
  assert.equal(new Random().poisson(0), 0);
});
test('Gamma–Poisson preserves shared daily intensity and predictive variance', () => {
  const fitted = {
    rates: Array.from({ length: 7 }, () => Array<number>(24).fill(2)),
    shape: 3,
    uncertainty_shape: 1e9,
  };
  const draws = simulate(
      fitted,
      Date.parse('2026-01-01T00:00:00Z'),
      Date.parse('2026-01-02T00:00:00Z'),
      'UTC',
      100_000,
    ),
    mu = mean(draws);
  near(mu, 48, 0.6);
  near(mean(draws.map((d) => (d - mu) ** 2)), 48 + 48 ** 2 / 3, 35);
});
test('DST days contain 23 and 25 hours; ambiguous/nonexistent local times fail', () => {
  for (const [date, expected] of [
    ['2026-03-08', 23],
    ['2026-11-01', 25],
  ] as const) {
    const start = Date.parse(date + 'T00:00:00Z'),
      history = new Map(Array.from({ length: 168 }, (_, i) => [start + (i - 72) * HOUR, 1]));
    assert.equal(
      completeDays(history, start + 4 * DAY, 'America/New_York').find((d) => d.day === date)?.rows
        .length,
      expected,
    );
  }
  for (const value of ['2026-03-08T02:00', '2026-11-01T01:00'])
    assert.throws(() => localTime(value, 'America/New_York'));
  assert.equal(
    localTime('2026-10-13T12:00', 'America/New_York'),
    parseTime('2026-10-13T16:00:00Z'),
  );
  assert.throws(() => localTime('2026-10-13T12:00', 'Invalid/Zone'));
});
test('Rolling backtest actually executes 14 holdouts', () => {
  const result = backtest(data, cutoff, 'UTC');
  assert.equal(result.days, 14);
  assert.notEqual(result.mae, null);
  assert.ok(result.coverage80 !== null && result.coverage80 >= 0 && result.coverage80 <= 1);
});
test('Ask sweep includes depth and expenses in budget', () => {
  const fill = fillOrder(
    [
      { price: 0.6, size: 100 },
      { price: 0.4, size: 10 },
    ],
    50,
    0.1,
  );
  near(fill.total, 50);
  near(fill.shares, 10 + (50 / 1.1 - 4) / 0.6);
  assert.ok(fill.vwap! > 0.4);
});
test('YES/NO probabilities are complements; profit is net of expenses', () => {
  const event = demoEvent(now);
  event.markets = event.markets.slice(0, 1);
  for (const side of ['yes', 'no'] as Side[])
    event.markets[0].books[side] = {
      asks: [{ price: 0.4, size: 1000 }],
      fetched_at: new Date(now).toISOString(),
    };
  const rows = evaluate(
    Float64Array.from([...Array<number>(70).fill(100), ...Array<number>(30).fill(300)]),
    event,
    100,
    100,
    5,
    true,
    now,
  );
  const yes = rows.find((p) => p.side === 'YES')!,
    no = rows.find((p) => p.side === 'NO')!;
  near(yes.probability + no.probability, 1);
  near(yes.expected_profit!, 0.7 * yes.shares - 100);
  assert.equal(yes.signal, true);
  assert.equal(no.signal, false);
});
test('Stale quotes, insufficient depth and unconfirmed rules disable signals', () => {
  const event = demoEvent(now);
  event.markets = event.markets.slice(0, 1);
  for (const side of ['yes', 'no'] as Side[])
    event.markets[0].books[side] = {
      asks: [{ price: 0.01, size: 1 }],
      fetched_at: new Date(now - 300_000).toISOString(),
    };
  const rows = evaluate(new Float64Array(100).fill(100), event, 100, 0, 0, false, now);
  assert.ok(rows.every((r) => !r.signal && r.reasons.length >= 3));
});
