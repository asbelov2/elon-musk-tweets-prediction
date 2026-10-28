import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type {
  Analysis,
  CollectionPreview,
  DemoEvent,
  Status,
  MarketEvent,
} from '../src/shared/types.js';
import { createApp } from '../src/server/app.js';
import { demoHours } from '../src/server/demo.js';
import type { Transport } from '../src/server/http.js';
import { readCsv, Store } from '../src/server/storage.js';
import { DAY, HOUR, hour, iso } from '../src/server/time.js';
import { trackerFixture, SLUG } from './fixtures/xtracker.js';

const now = Date.parse('2026-10-18T12:20:00Z');
async function setup(t: TestContext, transport?: Transport) {
  const store = new Store(':memory:');
  const app = await createApp({ store, transport, env: {}, now: () => now });
  t.after(async () => {
    await app.close();
    store.close();
  });
  return { app, store };
}
test('Complete demo workflow runs the real forecast worker and returns 14 positions', async (t) => {
  const { app } = await setup(t);
  assert.equal((await app.inject('/')).statusCode, 200);
  const demo = (
    await app.inject({ method: 'POST', url: '/api/demo', payload: {} })
  ).json<DemoEvent>();
  const response = await app.inject({
    method: 'POST',
    url: '/api/analyze',
    payload: {
      dataset: 'demo',
      start: demo.start,
      end: demo.end,
      timezone: demo.timezone,
      rules_confirmed: true,
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json<Analysis>();
  assert.equal(result.positions.length, 14);
  assert.equal(result.activity?.timezone, demo.timezone);
  assert.equal(result.activity?.weekdays.length, 7);
  assert.equal(result.activity?.upcoming.length, 6);
  assert.equal(result.backtest.days, 14);
  assert.equal(result.event?.demo, true);
  assert.equal((await app.inject('/api/status')).json<Status>().live.hours, 0);
});
test('All static assets, CSP and local OpenAPI documentation are served', async (t) => {
  const { app } = await setup(t);
  for (const url of [
    '/',
    '/api/docs',
    '/static/app.js',
    '/static/api.js',
    '/static/style.css',
    '/static/favicon.svg',
  ]) {
    const response = await app.inject(url);
    assert.equal(response.statusCode, 200, url);
    assert.match(response.headers['content-security-policy'] as string, /script-src 'self'/);
  }
  const schema = (await app.inject('/openapi.json')).json<{ paths: Record<string, unknown> }>();
  assert.ok(schema.paths['/api/analyze']);
  assert.ok(schema.paths['/api/history/preview']);
  assert.ok(schema.paths['/api/history/confirm']);
  assert.equal(schema.paths['/api/collect'], undefined);
});
test('Validation rejects negative/nonfinite budgets, naive CSV times and unconfirmed coverage', async (t) => {
  const { app } = await setup(t);
  const invalid = await app.inject({
    method: 'POST',
    url: '/api/analyze',
    payload: { start: '2026-10-18T00:00', end: '2026-10-19T00:00', budget: -1 },
  });
  assert.equal(invalid.statusCode, 422);
  const response = await app.inject({
    method: 'POST',
    url: '/api/import',
    payload: { content: 'timestamp,count\n2026-01-01T00:00:00Z,3' },
  });
  assert.equal(response.statusCode, 400);
  assert.equal((await app.inject('/api/status')).json<Status>().live.hours, 0);
});
test('Empty history reports a useful error through the forecast worker', async (t) => {
  const { app } = await setup(t);
  const response = await app.inject({
    method: 'POST',
    url: '/api/analyze',
    payload: { start: '2026-10-18T00:00', end: '2026-10-19T00:00' },
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.json<{ detail: string }>().detail, /историю/);
});
test('Cross-origin mutations are blocked and oversized requests rejected', async (t) => {
  const { app } = await setup(t);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/demo',
        payload: {},
        headers: { origin: 'https://evil.example' },
      })
    ).statusCode,
    403,
  );
  const response = await app.inject({
    method: 'POST',
    url: '/api/import',
    payload: { content: 'x'.repeat(6_000_001), coverage_confirmed: true },
  });
  assert.equal(response.statusCode, 413);
});
test('Import/export and a real-dataset forecast preserve hourly counts', async (t) => {
  const { app } = await setup(t),
    rows = demoHours(now).slice(-35 * 24);
  const content = 'timestamp,count\n' + rows.map(([t, c]) => `${iso(t)},${c}`).join('\n');
  const imported = await app.inject({
    method: 'POST',
    url: '/api/import',
    payload: { content, coverage_confirmed: true },
  });
  assert.equal(imported.statusCode, 200, imported.body);
  assert.equal(imported.json<{ imported_hours: number }>().imported_hours, 840);
  const exported = await app.inject('/api/export');
  assert.deepEqual(readCsv(exported.body), rows);
  const start = hour(now),
    response = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      payload: { dataset: 'live', start: iso(start), end: iso(start + DAY), timezone: 'UTC' },
    });
  assert.equal(response.statusCode, 200, response.body);
  assert.ok(response.json<Analysis>().mean > 0);
  assert.deepEqual(response.json<Analysis>().positions, []);
});
test('Collection preview never writes data before explicit confirmation', async (t) => {
  const { transport } = trackerFixture(now);
  const { app, store } = await setup(t, transport);
  const preview = (
    await app.inject({
      method: 'POST',
      url: '/api/history/preview',
      payload: { source: 'xtracker', days: 15, event_url: SLUG },
    })
  ).json<CollectionPreview>();
  assert.ok(preview.preview_id);
  assert.equal(store.load().data.size, 0);
  const rejected = await app.inject({
    method: 'POST',
    url: '/api/history/confirm',
    payload: { preview_id: preview.preview_id },
  });
  assert.equal(rejected.statusCode, 400);
  assert.equal(store.load().data.size, 0);
  const confirmed = await app.inject({
    method: 'POST',
    url: '/api/history/confirm',
    payload: { preview_id: preview.preview_id, coverage_confirmed: true },
  });
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  assert.equal(store.load('xtracker').data.size, 360);
  assert.equal(store.load('live').data.size, 0);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/history/confirm',
        payload: { preview_id: preview.preview_id, coverage_confirmed: true },
      })
    ).statusCode,
    400,
  );
});
test('Legacy collection preview remains compatible with the current confirmation route', async (t) => {
  const { transport } = trackerFixture(now);
  const { app, store } = await setup(t, transport);
  const response = await app.inject({
    method: 'POST',
    url: '/api/collect',
    payload: { source: 'xtracker', days: 15, event_url: SLUG },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(store.load('xtracker').data.size, 0);
  const confirmed = await app.inject({
    method: 'POST',
    url: '/api/history/confirm',
    payload: {
      preview_id: response.json<CollectionPreview>().preview_id,
      coverage_confirmed: true,
    },
  });
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  assert.equal(store.load('xtracker').data.size, 360);
});
test('Invalid collection depth is rejected before any provider request or write', async (t) => {
  let calls = 0;
  const { app, store } = await setup(t, async () => {
    calls++;
    throw new Error('Should not call');
  });
  for (const url of ['/api/history/preview', '/api/collect']) {
    for (const days of ['', null, 14, 15.5, 121]) {
      const response = await app.inject({ method: 'POST', url, payload: { days } });
      assert.equal(response.statusCode, 422, response.body);
      assert.match(response.json<{ detail: string }>().detail, /days/);
    }
  }
  assert.equal(calls, 0);
  assert.equal(store.load('xtracker').data.size, 0);
});
test('X collection without a key cannot make metered network calls', async (t) => {
  let calls = 0;
  const { app } = await setup(t, async () => {
    calls++;
    throw new Error('Should not call');
  });
  const response = await app.inject({
    method: 'POST',
    url: '/api/collect',
    payload: { source: 'x', days: 30 },
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.json<{ detail: string }>().detail, /X_BEARER_TOKEN/);
  assert.equal(calls, 0);
});
test('XTracker automatically verifies rules, anchors Post Counter and blocks signals on sync error', async (t) => {
  const f = trackerFixture(now),
    { app, store } = await setup(t, f.transport);
  const previewResponse = await app.inject({
    method: 'POST',
    url: '/api/collect',
    payload: {
      source: 'xtracker',
      days: 30,
      event_url: SLUG,
      include_replies: false,
      include_reposts: false,
    },
  });
  assert.equal(previewResponse.statusCode, 200, previewResponse.body);
  const preview = previewResponse.json<CollectionPreview>();
  await app.inject({
    method: 'POST',
    url: '/api/collect/confirm',
    payload: { preview_id: preview.preview_id, coverage_confirmed: true },
  });
  const event = (await app.inject('/api/event?url=' + SLUG)).json<MarketEvent>();
  for (const market of event.markets)
    for (const book of Object.values(market.books)) book.fetched_at = iso(now);
  store.snapshot(SLUG, event);
  const payload = {
    dataset: 'xtracker',
    event_url: SLUG,
    start: iso(f.start),
    end: iso(f.end),
    timezone: 'America/New_York',
    rules_confirmed: false,
  };
  const response = await app.inject({ method: 'POST', url: '/api/analyze', payload });
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json<Analysis>();
  assert.equal(result.current_count, f.detail.stats.total);
  assert.equal(result.tracker?.verified, true);
  assert.equal(result.fresh, true);
  assert.ok(result.positions.some((p) => p.signal));
  assert.ok(result.warnings.every((warning) => !warning.includes('Подтвердите')));
  assert.equal(store.load('live').data.size, 0);
  f.profile.lastSyncError = iso(now);
  const failed = (
    await app.inject({ method: 'POST', url: '/api/analyze', payload })
  ).json<Analysis>();
  assert.equal(failed.fresh, false);
  assert.equal(failed.tracker?.sync_ok, false);
  assert.ok(failed.positions.every((p) => !p.signal));
  const wrong = await app.inject({
    method: 'POST',
    url: '/api/analyze',
    payload: { ...payload, start: '', end: iso(f.end + HOUR), timezone: 'UTC' },
  });
  assert.equal(wrong.statusCode, 200);
  assert.equal(wrong.json<Analysis>().end, iso(f.end));
  assert.equal(wrong.json<Analysis>().start, iso(f.start));
  assert.equal(wrong.json<Analysis>().timezone, 'America/New_York');
  const exported = await app.inject('/api/export?dataset=xtracker');
  assert.equal(readCsv(exported.body).length, 720);
});
test('A manual rules checkbox cannot make API X/CSV history authoritative for a Post Counter market', async (t) => {
  const f = trackerFixture(now),
    { app, store } = await setup(t, f.transport);
  store.saveHours(demoHours(now), 'live', 'csv', now);
  const event = (await app.inject('/api/event?url=' + SLUG)).json<MarketEvent>();
  for (const market of event.markets)
    for (const book of Object.values(market.books)) book.fetched_at = iso(now);
  store.snapshot(SLUG, event);
  const response = await app.inject({
    method: 'POST',
    url: '/api/analyze',
    payload: {
      dataset: 'live',
      event_url: SLUG,
      start: iso(f.start),
      end: iso(f.end),
      timezone: 'UTC',
      rules_confirmed: true,
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json<Analysis>();
  assert.ok(result.positions.every((p) => !p.signal));
  assert.ok(result.warnings.some((w) => w.includes('отдельную историю XTracker')));
});
test('Demo window mismatch gives a forecast without market positions', async (t) => {
  const { app } = await setup(t),
    demo = (await app.inject({ method: 'POST', url: '/api/demo', payload: {} })).json<DemoEvent>();
  const response = await app.inject({
    method: 'POST',
    url: '/api/analyze',
    payload: {
      dataset: 'demo',
      start: demo.start,
      end: demo.end.slice(0, 11) + '13:00',
      timezone: demo.timezone,
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json<Analysis>().positions, []);
});
test('Health endpoint remains responsive while a worker computes a forecast', async (t) => {
  const { app, store } = await setup(t);
  store.saveHours(demoHours(now), 'demo', 'synthetic', now);
  const demo = (
    await app.inject({ method: 'POST', url: '/api/demo', payload: {} })
  ).json<DemoEvent>();
  const computation = app.inject({
    method: 'POST',
    url: '/api/analyze',
    payload: { dataset: 'demo', start: demo.start, end: demo.end, timezone: demo.timezone },
  });
  const health = await app.inject('/api/health');
  assert.equal(health.statusCode, 200);
  assert.equal(health.json<{ status: string }>().status, 'ok');
  assert.equal((await computation).statusCode, 200);
});
