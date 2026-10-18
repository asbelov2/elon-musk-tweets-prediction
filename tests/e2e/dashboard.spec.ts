import { test, expect } from '@playwright/test';

test('Demo, charts, position filters and parameter invalidation', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.locator('#demo-empty').click();
  await expect(page.locator('#result-content')).toBeVisible();
  await expect(page.locator('#demo-banner')).toBeVisible();
  await expect(page.locator('#positions-body tr')).toHaveCount(14);
  expect(await page.locator('#distribution svg rect').count()).toBeGreaterThan(0);
  await page.locator('#position-filter').selectOption('YES');
  await expect(page.locator('#positions-body tr')).toHaveCount(7);
  await page.locator('#budget').fill('200');
  await expect(page.locator('#result-content')).toBeHidden();
  await page.locator('#analyze').click();
  await expect(page.locator('#result-content')).toBeVisible();
  await page.locator('#go-live').click();
  await expect(page.locator('#demo-banner')).toBeHidden();
  await expect(page.locator('#result-content')).toBeHidden();
  expect(errors).toEqual([]);
});

test('CSV import, forecast without a market and CSV export', async ({ page }) => {
  const end = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const content =
    'timestamp,count\n' +
    Array.from(
      { length: 40 * 24 },
      (_, i) => `${new Date(end - (40 * 24 - i) * 3_600_000).toISOString()},${i % 7}`,
    ).join('\n');
  await page.goto('/');
  await page
    .locator('#csv-file')
    .setInputFiles({ name: 'history.csv', mimeType: 'text/csv', buffer: Buffer.from(content) });
  await page.locator('#csv-confirm').check();
  await page.locator('#import').click();
  await expect(page.locator('#message')).toContainText('Импортировано 960');
  await page.locator('#event-url').fill('');
  await page.locator('#timezone').selectOption('UTC');
  await page.locator('#start').fill(new Date(end).toISOString().slice(0, 16));
  await page.locator('#end').fill(new Date(end + 86_400_000).toISOString().slice(0, 16));
  await page.locator('#analyze').click();
  await expect(page.locator('#result-content')).toBeVisible();
  await expect(page.locator('#result-title')).not.toContainText('демо');
  await expect(page.locator('#positions-body')).toContainText('Рынок не выбран');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByText('Экспорт реальной истории в CSV').click(),
  ]);
  expect(download.suggestedFilename()).toBe('tweets-hourly.csv');
});

test('X source controls and offline API documentation', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.locator('#tab-tracker').click();
  await expect(page.locator('#x-options')).toBeVisible();
  await expect(page.locator('#x-key-status')).toContainText('не настроен');
  await page.locator('#collector-source').selectOption('xtracker');
  await expect(page.locator('#x-options')).toBeHidden();
  await page.locator('#collector-source').selectOption('x');
  await page.locator('#x-mode').selectOption('timeline');
  await expect(page.locator('#x-options')).toBeVisible();
  await page.goto('/api/docs');
  await expect(page.locator('#api-paths summary')).toHaveCount(9);
  expect(await page.locator('#api-schemas summary').count()).toBeGreaterThanOrEqual(2);
  expect(errors).toEqual([]);
});

test('Dashboard fits mobile and desktop viewports', async ({ page }) => {
  await page.goto('/');
  await page.locator('#demo-empty').click();
  await expect(page.locator('#result-content')).toBeVisible();
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
});
