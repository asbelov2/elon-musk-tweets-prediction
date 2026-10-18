import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { Analysis, CollectionPreview, MarketConfig, Status } from '../src/shared/types.js';
import { createApp } from '../src/server/app.js';
import { Store, readCsv } from '../src/server/storage.js';
import { collectTracker, fetchTrackerCounter } from '../src/server/xtracker.js';
import { collectX } from '../src/server/x-api.js';
import type { Transport } from '../src/server/http.js';
import { HOUR, hour, iso } from '../src/server/time.js';
import {
  trackerFixture,
  whiteHouseFixture,
  SLUG,
  WHITE_HOUSE_SLUG,
  TRACKING_ID,
} from './fixtures/xtracker.js';
const now = Date.parse('2026-10-18T12:20:00Z');
function fixtures() {
  const elon = trackerFixture(now),
    whiteHouse = whiteHouseFixture(now);
  const transport: Transport = (url, headers) => {
    const white =
      url.hostname === 'gamma-api.polymarket.com'
        ? url.searchParams.get('slug') === WHITE_HOUSE_SLUG
        : url.pathname.includes('WhiteHouse') || url.pathname.includes(whiteHouse.detail.id);
    return (white ? whiteHouse : elon).transport(url, headers);
  };
  return { elon, whiteHouse, transport };
}
async function setup(t: TestContext, transport: Transport) {
  const store = new Store(':memory:');
  const app = await createApp({ store, transport, env: {}, now: () => now });
  t.after(async () => {
    await app.close();
    store.close();
  });
  return { app, store };
}

test('Account namespaces preserve legacy UTC rows and isolate every dataset case-insensitively', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const time = hour(now) - HOUR;
  store.db
    .prepare('INSERT INTO hours VALUES (?,?,?,?)')
    .run('live', iso(time).replace('.000Z', '+00:00'), 7, 'csv');
  store.saveHours([[time, 7]], 'live', 'csv', now);
  for (const dataset of ['live', 'xtracker', 'demo'] as const) {
    store.saveHours([[time, 17]], dataset, 'fixture', now, undefined, 'WhiteHouse');
    store.saveHours([[time, 23]], dataset, 'fixture', now, undefined, 'NASA');
    assert.equal(store.load(dataset, '@whitehouse').data.get(time), 17);
    assert.equal(store.load(dataset, 'nasa').data.get(time), 23);
    if (dataset !== 'live') assert.equal(store.load(dataset).data.size, 0);
  }
  assert.equal(store.load('live').data.get(time), 7);
  const updated = store.db.prepare('SELECT value FROM metadata WHERE key=?');
  assert.equal(updated.get('live:updated')?.value, iso(now));
  assert.equal(updated.get('live@whitehouse:updated')?.value, iso(now));
  store.saveHours([[time, 19]], 'live', 'fixture', now + 60_000, undefined, 'WhiteHouse');
  assert.equal(updated.get('live:updated')?.value, iso(now));
  assert.equal(updated.get('live@whitehouse:updated')?.value, iso(now + 60_000));
});

test('White House counter and export validate the selected identity, including cached tracking IDs', async () => {
  const f = fixtures();
  const result = await collectTracker(
    { days: 30, event_url: WHITE_HOUSE_SLUG, handle: 'WhiteHouse' },
    f.transport,
    now,
  );
  assert.equal(result.tracker?.handle, 'WhiteHouse');
  assert.equal(result.tracker?.count, f.whiteHouse.detail.stats.total);
  assert.equal(result.rows.length, 720);
  await assert.rejects(
    fetchTrackerCounter(WHITE_HOUSE_SLUG, f.transport, now, TRACKING_ID, 'WhiteHouse'),
    /другого/,
  );
  f.whiteHouse.profile.handle = 'WrongUser';
  await assert.rejects(
    collectTracker(
      { days: 30, event_url: WHITE_HOUSE_SLUG, handle: 'WhiteHouse' },
      f.transport,
      now,
    ),
    /другой аккаунт/,
  );
});

test('Both built-in markets collect and forecast independently with account-specific counters', async (t) => {
  const f = fixtures(),
    { app, store } = await setup(t, f.transport);
  const catalog = (await app.inject('/api/markets')).json<MarketConfig[]>();
  assert.equal(catalog.length, 2);
  assert.equal(catalog.find((m) => m.id === WHITE_HOUSE_SLUG)?.handle, 'WhiteHouse');
  const results: Analysis[] = [];
  for (const slug of [SLUG, WHITE_HOUSE_SLUG]) {
    const preview = await app.inject({
      method: 'POST',
      url: '/api/collect',
      payload: { source: 'xtracker', days: 30, event_url: slug },
    });
    assert.equal(preview.statusCode, 200, preview.body);
    const p = preview.json<CollectionPreview>();
    const saved = await app.inject({
      method: 'POST',
      url: '/api/collect/confirm',
      payload: { preview_id: p.preview_id, coverage_confirmed: true },
    });
    assert.equal(saved.statusCode, 200, saved.body);
    await app.inject('/api/event?url=' + slug);
    const forecast = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      payload: { dataset: 'xtracker', event_url: slug, start: '', end: '', rules_confirmed: true },
    });
    assert.equal(forecast.statusCode, 200, forecast.body);
    results.push(forecast.json<Analysis>());
  }
  assert.equal(results[0].handle, 'elonmusk');
  assert.equal(results[1].handle, 'WhiteHouse');
  assert.equal(results[0].current_count, f.elon.detail.stats.total);
  assert.equal(results[1].current_count, f.whiteHouse.detail.stats.total);
  assert.ok(results[1].mean > results[0].mean * 1.5);
  assert.equal(store.load('xtracker').data.size, 720);
  assert.equal(store.load('xtracker', 'whitehouse').data.size, 720);
  const elonStatus = (await app.inject('/api/status')).json<Status>();
  const whiteStatus = (await app.inject('/api/status?handle=whitehouse')).json<Status>();
  assert.equal(whiteStatus.handle, 'WhiteHouse');
  assert.equal(whiteStatus.xtracker.posts, 2 * elonStatus.xtracker.posts);
  const elonCsv = readCsv((await app.inject('/api/export?dataset=xtracker')).body);
  const whiteCsv = readCsv(
    (await app.inject('/api/export?dataset=xtracker&handle=WhiteHouse')).body,
  );
  assert.equal(
    whiteCsv.reduce((s, [, c]) => s + c, 0),
    2 * elonCsv.reduce((s, [, c]) => s + c, 0),
  );
  const mismatch = await app.inject({
    method: 'POST',
    url: '/api/analyze',
    payload: {
      handle: 'elonmusk',
      dataset: 'xtracker',
      event_url: WHITE_HOUSE_SLUG,
      start: '',
      end: '',
    },
  });
  assert.equal(mismatch.statusCode, 400);
  assert.match(mismatch.body, /Аккаунт/);
});

test('CSV imports and delayed collection confirmations remain attached to their original account', async (t) => {
  const f = fixtures(),
    { app, store } = await setup(t, f.transport);
  const preview = (
    await app.inject({
      method: 'POST',
      url: '/api/collect',
      payload: { event_url: WHITE_HOUSE_SLUG, days: 15 },
    })
  ).json<CollectionPreview>();
  await app.inject('/api/status?handle=elonmusk');
  await app.inject({
    method: 'POST',
    url: '/api/collect/confirm',
    payload: { preview_id: preview.preview_id, coverage_confirmed: true },
  });
  assert.equal(store.load('xtracker').data.size, 0);
  assert.equal(store.load('xtracker', 'WhiteHouse').data.size, 360);
  const response = await app.inject({
    method: 'POST',
    url: '/api/import',
    payload: {
      handle: 'WhiteHouse',
      content: `timestamp,count\n${iso(hour(now) - HOUR)},77`,
      coverage_confirmed: true,
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(store.load('live', 'WhiteHouse').data.get(hour(now) - HOUR), 77);
  assert.equal(store.load('live').data.size, 0);
});

test('New account markets validate before saving, persist across app restarts and do not import history automatically', async (t) => {
  const slug = 'nasa-of-tweets-october-13-october-20-2026';
  const f = trackerFixture(now, { handle: 'NASA', slug });
  const store = new Store(':memory:');
  let app = await createApp({ store, transport: f.transport, env: {}, now: () => now });
  t.after(async () => {
    await app.close();
    store.close();
  });
  const payload = {
    event_url: 'https://polymarket.com/ru/event/' + slug,
    handle: 'NASA',
    label: 'NASA posts',
  };
  const added = await app.inject({ method: 'POST', url: '/api/markets', payload });
  assert.equal(added.statusCode, 200, added.body);
  assert.equal(added.json<MarketConfig>().id, slug);
  assert.equal(store.load('xtracker', 'NASA').data.size, 0);
  await app.close();
  app = await createApp({ store, transport: f.transport, env: {}, now: () => now });
  assert.equal((await app.inject('/api/markets')).json<MarketConfig[]>().length, 3);
  const repeated = await app.inject({ method: 'POST', url: '/api/markets', payload });
  assert.equal(repeated.statusCode, 200, repeated.body);
  assert.equal((await app.inject('/api/markets')).json<MarketConfig[]>().length, 3);
  const wrong = await app.inject({
    method: 'POST',
    url: '/api/markets',
    payload: { ...payload, handle: 'OtherUser' },
  });
  assert.equal(wrong.statusCode, 400);
  const absent = await app.inject({
    method: 'POST',
    url: '/api/markets',
    payload: { ...payload, event_url: 'another-market' },
  });
  assert.equal(absent.statusCode, 400, absent.body);
  assert.equal((await app.inject('/api/markets')).json<MarketConfig[]>().length, 3);
  const unknown = await app.inject('/api/event?url=unknown-market');
  assert.equal(unknown.statusCode, 400);
});

test('Optional API X collection scopes both archive queries and timeline user lookups to the chosen account', async () => {
  const boundary = hour(now) - 15 * 24 * HOUR;
  for (const mode of ['archive', 'timeline'] as const) {
    const transport: Transport = async (url) => {
      if (url.pathname.includes('/by/username/')) {
        assert.equal(url.pathname, '/2/users/by/username/WhiteHouse');
        return { status: 200, json: async () => ({ data: { id: '1234' } }) };
      }
      if (mode === 'archive') assert.equal(url.searchParams.get('query'), 'from:WhiteHouse');
      else assert.equal(url.pathname, '/2/users/1234/tweets');
      return {
        status: 200,
        json: async () => ({
          data: [
            { id: '1', created_at: iso(boundary + HOUR) },
            { id: '2', created_at: iso(boundary - HOUR) },
          ],
        }),
      };
    };
    const result = await collectX(
      { handle: 'WhiteHouse', mode, days: 15, include_replies: false, include_reposts: true },
      transport,
      now,
      { X_BEARER_TOKEN: 'fixture-only' },
    );
    assert.equal(result.posts, 1);
  }
});
