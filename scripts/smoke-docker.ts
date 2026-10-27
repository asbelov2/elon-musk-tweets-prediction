import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { DemoEvent, Analysis, Status } from '../src/shared/types.js';

const exec = promisify(execFile);
const docker = async (...args: string[]) =>
  (await exec('docker', args, { maxBuffer: 4_000_000 })).stdout.trim();
const image = process.argv[2] ?? 'tweetscope:local';
const name = `tweetscope-smoke-${randomUUID()}`;
const volume = name + '-data';
const password = randomBytes(24).toString('base64url');
const basic = 'Basic ' + Buffer.from('admin:' + password).toString('base64');
const origin = 'https://tweetscope.example';
let base = '';
async function start(mode: 'public' | 'admin') {
  await docker(
    'run',
    '-d',
    '--name',
    name,
    '--init',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=64m',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--memory',
    '1g',
    '-e',
    'PUBLIC_URL=' + origin,
    '-e',
    'WRITE_ACCESS=' + mode,
    '-e',
    'ADMIN_PASSWORD=' + password,
    '-e',
    'X_BEARER_TOKEN=',
    '-e',
    'TWITTER_BEARER_TOKEN=',
    '-p',
    '127.0.0.1::8000',
    '-v',
    volume + ':/app/data',
    image,
  );
  const port = (await docker('port', name, '8000/tcp')).split(':').at(-1)!;
  base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(base + '/api/health', { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Container did not become healthy');
}
async function json<T>(path: string, payload?: unknown, auth = false): Promise<T> {
  const response = await fetch(base + path, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: {
      Origin: origin,
      ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(auth ? { Authorization: basic } : {}),
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    signal: AbortSignal.timeout(35_000),
  });
  assert.equal(
    response.status,
    200,
    `${path}: ${response.status} ${await response.clone().text()}`,
  );
  return (await response.json()) as T;
}
async function stop() {
  await docker('stop', '-t', '40', name);
  assert.equal(await docker('inspect', '--format', '{{.State.ExitCode}}', name), '0');
  await docker('rm', name);
}
try {
  await docker('volume', 'create', volume);
  await start('public');
  assert.equal(await docker('exec', name, 'id', '-u'), '1000');
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/static/app.js')).status, 200);
  assert.equal((await json<Status>('/api/status')).access?.can_manage_data, true);
  const demo = await json<DemoEvent>('/api/demo', {});
  const analysis = await json<Analysis>('/api/analyze', {
    dataset: 'demo',
    start: demo.start,
    end: demo.end,
    timezone: demo.timezone,
    rules_confirmed: true,
  });
  assert.equal(analysis.positions.length, 14);
  assert.equal(analysis.activity?.weekdays.length, 7);
  const before = await json<Status>('/api/status');
  assert.ok(before.demo.hours > 0);
  const content = `timestamp,count\n${new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3_600_000).toISOString()},7`;
  await json('/api/import', { content, coverage_confirmed: true });
  const denied = await fetch(base + '/api/demo', {
    method: 'POST',
    headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(denied.status, 403);
  await docker('exec', name, 'node', 'dist/scripts/backup.js', '/app/data/backups/smoke.sqlite3');
  const check = await docker(
    'exec',
    name,
    'node',
    '--input-type=module',
    '-e',
    "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync('/app/data/backups/smoke.sqlite3',{readOnly:true}); if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||db.prepare(\"SELECT count(*) AS n FROM hours WHERE dataset='live'\").get().n!==1)process.exit(1);db.close();",
  );
  assert.equal(check, '');
  await stop();
  await start('admin');
  const after = await json<Status>('/api/status');
  assert.equal(after.demo.hours, before.demo.hours);
  assert.equal(after.live.posts, 7);
  assert.equal(after.access?.can_manage_data, false);
  const blocked = await fetch(base + '/api/import', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, coverage_confirmed: true }),
  });
  assert.equal(blocked.status, 401);
  await json('/api/import', { content, coverage_confirmed: true }, true);
  assert.equal((await json<Status>('/api/status', undefined, true)).access?.can_manage_data, true);
  await stop();
  console.log(
    'Docker smoke passed: public UI/API, worker forecast, non-root read-only runtime, SQLite persistence, online backup, HTTPS origin and optional administration.',
  );
} catch (error) {
  try {
    process.stderr.write(await docker('logs', name));
  } catch {}
  throw error;
} finally {
  try {
    await docker('rm', '-f', name);
  } catch {}
  await docker('volume', 'rm', volume);
}
