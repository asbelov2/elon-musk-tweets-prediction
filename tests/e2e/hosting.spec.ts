import { test, expect } from '@playwright/test';
import type { createApp as AppFactory } from '../../src/server/app.js';
import type { Store as StoreInstance } from '../../src/server/storage.js';
const password = 'browser-fixture-password-1234';
let app: Awaited<ReturnType<typeof AppFactory>>;
let store: StoreInstance;
let base = '';
test.beforeAll(async () => {
  const { createApp } = (await import(
    new URL('../../dist/src/server/app.js', import.meta.url).href
  )) as { createApp: typeof AppFactory };
  const { Store } = (await import(
    new URL('../../dist/src/server/storage.js', import.meta.url).href
  )) as { Store: new (path?: string) => StoreInstance };
  store = new Store(':memory:');
  app = await createApp({
    store,
    env: { WRITE_ACCESS: 'admin', ADMIN_PASSWORD: password, HTTP_RATE_LIMIT: '120' },
  });
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});
test.afterAll(async () => {
  await app.close();
  store.close();
});
test('Optional admin mode keeps the public forecast UI and hides management controls', async ({
  page,
}) => {
  await page.goto(base);
  await expect(page.locator('#market-select option')).toHaveCount(2);
  await expect(page.locator('#admin-link')).toBeVisible();
  await expect(page.locator('#history-management')).toBeHidden();
  await expect(page.locator('#add-market-form')).toBeHidden();
  await expect(page.locator('#access-note')).toContainText('администратор');
  await expect(page.locator('#analyze')).toBeVisible();
  await expect(page.locator('#demo-empty')).toHaveCount(0);
  await expect(page.locator('#texas-clock')).toBeVisible();
});
test('Browser HTTP authentication restores management controls after the admin redirect', async ({
  browser,
}) => {
  const context = await browser.newContext({ httpCredentials: { username: 'admin', password } });
  try {
    const page = await context.newPage();
    await page.goto(base + '/api/admin');
    await expect(page.locator('#market-select option')).toHaveCount(2);
    await expect(page.locator('#history-management')).toBeVisible();
    await expect(page.locator('#add-market-form')).toBeVisible();
    await expect(page.locator('#admin-link')).toBeHidden();
  } finally {
    await context.close();
  }
});
