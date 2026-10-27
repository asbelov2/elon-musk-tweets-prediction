import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server/app.js';
import { webConfig } from '../src/server/web-config.js';
import { Store } from '../src/server/storage.js';
import type { Status } from '../src/shared/types.js';

const password = 'fixture-password-12345678';
const basic = 'Basic ' + Buffer.from('admin:' + password).toString('base64');
const publicOrigin = 'https://tweets.example.com';
async function setup(t: TestContext, extra: Record<string, string> = {}) {
  const store = new Store(':memory:');
  let calls = 0;
  const app = await createApp({
    store,
    env: { NODE_ENV: 'production', PUBLIC_URL: publicOrigin, ...extra },
    transport: async () => {
      calls++;
      throw new Error('unexpected external request');
    },
  });
  t.after(async () => {
    await app.close();
    store.close();
  });
  return { app, store, providerCalls: () => calls };
}
test('Production defaults to all-public functions and accepts its HTTPS origin through a proxy', async (t) => {
  const { app, store } = await setup(t);
  assert.equal((await app.inject('/')).statusCode, 200);
  const status = (await app.inject('/api/status')).json<Status>();
  assert.equal(status.access?.can_manage_data, true);
  assert.equal(status.access?.write_access, 'public');
  const response = await app.inject({
    method: 'POST',
    url: '/api/import',
    headers: { origin: publicOrigin, host: 'app:8000' },
    payload: { content: 'timestamp,count\n2026-01-01T00:00:00Z,7', coverage_confirmed: true },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(store.load('live').data.size, 1);
  const blocked = await app.inject({
    method: 'POST',
    url: '/api/demo',
    headers: {
      origin: 'https://evil.example',
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'https',
    },
    payload: {},
  });
  assert.equal(blocked.statusCode, 403);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/demo',
        headers: { 'sec-fetch-site': 'cross-site' },
        payload: {},
      })
    ).statusCode,
    403,
  );
});
test('Optional administrator mode keeps public calculations available and protects every management path', async (t) => {
  const { app, providerCalls } = await setup(t, {
    WRITE_ACCESS: 'admin',
    ADMIN_PASSWORD: password,
  });
  assert.equal((await app.inject('/')).statusCode, 200);
  assert.equal((await app.inject('/api/health')).statusCode, 200);
  assert.equal((await app.inject('/api/status')).json<Status>().access?.can_manage_data, false);
  for (const url of [
    '/api/import',
    '/api/history/preview',
    '/api/history/confirm',
    '/api/collect',
    '/api/collect/confirm',
    '/api/markets',
  ]) {
    const result = await app.inject({
      method: 'POST',
      url,
      headers: { origin: publicOrigin },
      payload: {},
    });
    assert.equal(result.statusCode, 401, url);
    assert.match(result.headers['www-authenticate'] as string, /Basic/);
  }
  assert.equal(providerCalls(), 0);
  const encoded = await app.inject({
    method: 'POST',
    url: '/api/%69mport',
    headers: { origin: publicOrigin },
    payload: {},
  });
  assert.ok([401, 404].includes(encoded.statusCode));
  const authenticated = (
    await app.inject({ url: '/api/status', headers: { authorization: basic } })
  ).json<Status>();
  assert.equal(authenticated.access?.can_manage_data, true);
  const navigation = await app.inject({ url: '/api/admin', headers: { authorization: basic } });
  assert.equal(navigation.statusCode, 302);
  assert.equal(navigation.headers.location, '/');
  const wrong = await app.inject({
    url: '/api/admin',
    headers: { authorization: 'Basic ' + Buffer.from('admin:wrong').toString('base64') },
  });
  assert.equal(wrong.statusCode, 401);
});
test('Rate limits isolate client IPs through the configured proxy and never block health checks', async (t) => {
  const { app } = await setup(t, { HTTP_RATE_LIMIT: '2', TRUST_PROXY_HOPS: '1' });
  for (let i = 0; i < 2; i++)
    assert.equal(
      (await app.inject({ url: '/api/status', headers: { 'x-forwarded-for': '203.0.113.10' } }))
        .statusCode,
      200,
    );
  const limited = await app.inject({
    url: '/api/status',
    headers: { 'x-forwarded-for': '203.0.113.10' },
  });
  assert.equal(limited.statusCode, 429);
  assert.ok(limited.headers['retry-after']);
  assert.equal(
    (await app.inject({ url: '/api/status', headers: { 'x-forwarded-for': '203.0.113.11' } }))
      .statusCode,
    200,
  );
  for (let i = 0; i < 4; i++) assert.equal((await app.inject('/api/health')).statusCode, 200);
});
test('Production configuration rejects bad origins and incomplete optional authentication', () => {
  assert.throws(() => webConfig({ NODE_ENV: 'production' }), /PUBLIC_URL/);
  for (const value of [
    'https://example.com/path',
    'https://user:password@example.com',
    'file:///app',
    'https://example.com?query=1',
  ])
    assert.throws(() => webConfig({ PUBLIC_URL: value }), /PUBLIC_URL/);
  assert.throws(() => webConfig({ WRITE_ACCESS: 'admin' }), /ADMIN_PASSWORD/);
  assert.throws(() => webConfig({ WRITE_ACCESS: 'other' }), /WRITE_ACCESS/);
  assert.throws(() => webConfig({ TRUST_PROXY_HOPS: '-1' }), /TRUST_PROXY_HOPS/);
  assert.equal(
    webConfig({ PUBLIC_URL: 'https://example.com/' }).publicOrigin,
    'https://example.com',
  );
});
test('Online SQLite backup includes committed WAL writes and refuses to replace existing files', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tweetscope-backup-'));
  const source = join(root, 'source.sqlite3'),
    destination = join(root, 'backup.sqlite3');
  const store = new Store(source);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  store.saveHours(
    [[Date.parse('2026-01-01T00:00:00Z'), 7]],
    'live',
    'csv',
    Date.parse('2026-01-02T00:00:00Z'),
  );
  store.setMetadata('test:backup', { value: 'kept' });
  const run = (file: string) =>
    spawnSync(process.execPath, ['dist/scripts/backup.js', file], {
      env: { ...process.env, TWEET_DB: source },
      encoding: 'utf8',
    });
  const copied = run(destination);
  assert.equal(copied.status, 0, copied.stderr);
  const db = new DatabaseSync(destination, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    assert.equal(db.prepare('SELECT count FROM hours').get()?.count, 7);
    assert.equal(
      db.prepare('SELECT value FROM metadata WHERE key=?').get('test:backup')?.value,
      JSON.stringify({ value: 'kept' }),
    );
  } finally {
    db.close();
  }
  assert.notEqual(run(source).status, 0);
  const protectedFile = join(root, 'keep.txt');
  writeFileSync(protectedFile, 'keep');
  assert.notEqual(run(protectedFile).status, 0);
  assert.equal(readFileSync(protectedFile, 'utf8'), 'keep');
  assert.equal(existsSync(source), true);
});
