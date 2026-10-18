import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('Forecast worker ignores Node watch-mode module-tracking messages', async () => {
  const child = spawn(
    process.execPath,
    ['--watch', '--watch-path=dist/src', 'dist/tests/fixtures/watch-forecast.js'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const closed = once(child, 'close');
  let output = '';
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Watch-mode forecast timed out: ' + output)),
        10_000,
      );
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes('FORECAST_WATCH_OK')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', () => {
        clearTimeout(timer);
        reject(new Error('Watch process exited before result: ' + output));
      });
    });
    assert.match(output, /FORECAST_WATCH_OK/);
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
});
