import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  collectTracker,
  fetchTrackerCounter,
  assertTrackerPeriod,
} from '../src/server/xtracker.js';
import { forecast, mean, simulate } from '../src/server/model.js';
import { DAY, HOUR } from '../src/server/time.js';
import { trackerFixture, SLUG } from './fixtures/xtracker.js';

test('Official Export Data without type fields reconciles IDs, hours and Post Counter', async () => {
  const f = trackerFixture(),
    result = await collectTracker({ days: 30, event_url: SLUG }, f.transport, f.now);
  assert.equal(result.rows.length, 720);
  assert.equal(result.tracker?.export_records, f.posts.length);
  assert.equal(result.tracker?.count, f.detail.stats.total);
  assert.equal(result.tracker?.sync_ok, true);
  // Replies are deliberately not reclassified; the tracker and its counter own the composition.
  assert.equal(
    result.posts,
    result.rows.reduce((s, [, c]) => s + c, 0),
  );
});
test('Counter inclusive :59:59 end becomes the market exclusive hour, including ET conversion', async () => {
  const f = trackerFixture(),
    { report } = await fetchTrackerCounter(SLUG, f.transport, f.now);
  assert.equal(report.end, '2026-10-20T16:00:00.000Z');
  assert.equal(report.local_start, '2026-10-13T12:00');
  assert.equal(report.local_end, '2026-10-20T12:00');
  assertTrackerPeriod(report, f.start, f.end);
  assert.throws(() => assertTrackerPeriod(report, f.start, f.end + HOUR), /Период/);
  assert.equal(report.count - report.completed_count, 2);
});
test('Truncated full export is rejected against the source record count', async () => {
  const f = trackerFixture();
  f.posts.splice(0, 1);
  await assert.rejects(collectTracker({ days: 30, event_url: SLUG }, f.transport, f.now), /усечён/);
});
test('An inconsistent export is rejected even if its global record count matches', async () => {
  const f = trackerFixture();
  const p = f.posts.find((p) => Date.parse(p.createdAt) > f.start)!;
  p.createdAt = new Date(f.start - HOUR).toISOString();
  await assert.rejects(
    collectTracker({ days: 30, event_url: SLUG }, f.transport, f.now),
    /расходится/,
  );
});
test('Source sync errors and old sync times disable signals without hiding the counter', async () => {
  const f = trackerFixture();
  f.profile.lastSyncError = new Date(f.now).toISOString();
  const { report } = await fetchTrackerCounter(SLUG, f.transport, f.now);
  assert.equal(report.count, f.detail.stats.total);
  assert.equal(report.sync_ok, false);
  assert.ok(report.warnings.length);
});
test('Missing hourly stats, inconsistent cumulative totals and daily buckets fail closed', async () => {
  for (const change of [
    (f: ReturnType<typeof trackerFixture>) => {
      f.detail.stats.daily.splice(2, 1);
    },
    (f: ReturnType<typeof trackerFixture>) => {
      f.detail.stats.daily[0].cumulative++;
    },
    (f: ReturnType<typeof trackerFixture>) => {
      f.detail.stats.total++;
    },
  ]) {
    const f = trackerFixture();
    change(f);
    await assert.rejects(fetchTrackerCounter(SLUG, f.transport, f.now));
  }
});
test('Periods not tracked by the source are not filled with zero', async () => {
  const f = trackerFixture();
  f.windows[1].endDate = new Date(f.start - 2 * DAY).toISOString();
  const result = await collectTracker({ days: 30, event_url: SLUG }, f.transport, f.now);
  assert.ok(result.rows.length < 720);
  assert.ok(!new Map(result.rows).has(f.start - DAY));
});
test('Duplicate IDs never count twice; conflicting timestamps are rejected', async () => {
  const f = trackerFixture();
  f.posts.push({ ...f.posts[0] });
  const result = await collectTracker({ days: 30, event_url: SLUG }, f.transport, f.now);
  assert.equal(result.tracker?.export_records, f.profile._count.posts);
  f.posts.at(-1)!.createdAt = new Date(f.now - HOUR).toISOString();
  await assert.rejects(
    collectTracker({ days: 30, event_url: SLUG }, f.transport, f.now),
    /разные даты/,
  );
});
test('Current Post Counter anchors the forecast including the partial hour', async () => {
  const f = trackerFixture(),
    collection = await collectTracker({ days: 30, event_url: SLUG }, f.transport, f.now),
    report = collection.tracker!;
  const result = forecast(
    new Map(collection.rows),
    f.start,
    f.end,
    'America/New_York',
    f.now,
    2000,
    { count: report.count, as_of: f.now },
  );
  assert.equal(result.result.current_count, report.count);
  assert.ok(result.draws.every((n) => n >= report.count));
  assert.equal(result.result.cutoff, new Date(f.now).toISOString());
});
test('Remaining-hour exposure prevents predicting already elapsed minutes twice', () => {
  const fitted = {
    rates: Array.from({ length: 7 }, () => Array<number>(24).fill(12)),
    shape: 1e6,
    uncertainty_shape: 1e9,
  };
  const t = Date.parse('2026-10-18T12:00:00Z');
  const draws = simulate(fitted, t + 45 * 60_000, t + HOUR, 'UTC', 50000);
  assert.ok(Math.abs(mean(draws) - 3) < 0.08);
});
test('No X token or publication-type flags are required by XTracker', async () => {
  const f = trackerFixture();
  await assert.rejects(collectTracker({ days: 30 }, f.transport, f.now), /ссылку/);
  f.detail.marketLink = 'https://polymarket.com/event/different';
  await assert.rejects(fetchTrackerCounter(SLUG, f.transport, f.now), /Не найдено|другого/);
});
