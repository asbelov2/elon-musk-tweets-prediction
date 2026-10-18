import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { Analysis, CollectionPreview, DemoEvent, Status } from '../src/shared/types.js';
import { createApp } from '../src/server/app.js';
import { demoHours } from '../src/server/demo.js';
import type { Transport } from '../src/server/http.js';
import { readCsv, Store } from '../src/server/storage.js';
import { DAY, HOUR, hour, iso } from '../src/server/time.js';

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
  const transport: Transport = async () => ({
    status: 200,
    json: async () => ({
      data: {
        posts: [{ id: '1', createdAt: iso(hour(now) - HOUR), type: 'tweet' }],
        pagination: { hasMore: false },
      },
    }),
  });
  const { app, store } = await setup(t, transport);
  const preview = (
    await app.inject({
      method: 'POST',
      url: '/api/collect',
      payload: { source: 'xtracker', days: 15 },
    })
  ).json<CollectionPreview>();
  assert.ok(preview.preview_id);
  assert.equal(store.load().data.size, 0);
  const rejected = await app.inject({
    method: 'POST',
    url: '/api/collect/confirm',
    payload: { preview_id: preview.preview_id },
  });
  assert.equal(rejected.statusCode, 400);
  assert.equal(store.load().data.size, 0);
  const confirmed = await app.inject({
    method: 'POST',
    url: '/api/collect/confirm',
    payload: { preview_id: preview.preview_id, coverage_confirmed: true },
  });
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  assert.equal(store.load().data.size, 360);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/collect/confirm',
        payload: { preview_id: preview.preview_id, coverage_confirmed: true },
      })
    ).statusCode,
    400,
  );
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
