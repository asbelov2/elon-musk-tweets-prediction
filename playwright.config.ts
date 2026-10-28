import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:8011',
    headless: true,
    trace: 'retain-on-failure',
    launchOptions: {
      executablePath:
        process.env.CHROMIUM_EXECUTABLE ??
        (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
    },
  },
  webServer: {
    command: 'npm run build && node dist/tests/fixtures/browser-server.js',
    url: 'http://127.0.0.1:8011/api/health',
    timeout: 60_000,
    reuseExistingServer: false,
    env: {
      PORT: '8011',
      TWEETSCOPE_HOST: '127.0.0.1',
      TWEET_DB: join(tmpdir(), `tweetscope-e2e-${randomUUID()}.sqlite3`),
      X_BEARER_TOKEN: '',
      TWITTER_BEARER_TOKEN: '',
    },
  },
});
