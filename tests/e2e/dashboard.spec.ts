import { test, expect } from '@playwright/test';
import { trackerFixture, SLUG } from '../fixtures/xtracker.js';
import { collectTracker } from '../../src/server/xtracker.js';

test('Demo, outcome probabilities and interactive budget without recalculation', async ({
  page,
}) => {
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
  await expect(page.locator('#result-content')).toBeVisible();
  await expect(page.locator('#allocation')).not.toBeEmpty();
  await expect(page.locator('#outcomes progress')).toHaveCount(7);
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
  await page.locator('#tab-csv').click();
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
  await page.locator('#collector-source').selectOption('x');
  await expect(page.locator('#x-options')).toBeVisible();
  await expect(page.locator('#x-key-status')).toContainText('не настроен');
  await page.locator('#collector-source').selectOption('xtracker');
  await expect(page.locator('#x-options')).toBeHidden();
  await page.locator('#collector-source').selectOption('x');
  await page.locator('#x-mode').selectOption('timeline');
  await expect(page.locator('#x-options')).toBeVisible();
  await page.goto('/api/docs');
  await expect(page.locator('#api-paths summary')).toHaveCount(10);
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

test('XTracker preview, isolated history and authoritative period controls', async ({ page }) => {
  const fixture = trackerFixture(),
    collection = await collectTracker(
      { days: 30, event_url: SLUG },
      fixture.transport,
      fixture.now,
    ),
    report = collection.tracker!;
  let saved = false;
  const empty = { hours: 0, posts: 0, sources: [], start: null, end: null };
  await page.route('**/api/status', (route) =>
    route.fulfill({
      json: {
        live: empty,
        demo: empty,
        xtracker: saved
          ? {
              hours: collection.rows.length,
              posts: collection.posts,
              sources: ['xtracker:post-counter:v1'],
              start: collection.start,
              end: collection.end,
            }
          : empty,
        x_api: { credentials_present: false },
      },
    }),
  );
  await page.route('**/api/collect', (route) =>
    route.fulfill({
      json: {
        posts: collection.posts,
        start: collection.start,
        end: collection.end,
        notice: collection.notice,
        tracker: report,
        preview_id: 'preview',
        hours: collection.rows.length,
      },
    }),
  );
  await page.route('**/api/collect/confirm', (route) => {
    saved = true;
    return route.fulfill({ json: { imported_hours: collection.rows.length, dataset: 'xtracker' } });
  });
  await page.route('**/api/xtracker?*', (route) => route.fulfill({ json: report }));
  await page.goto('/');
  await expect(page.locator('#history-source')).toHaveValue('xtracker');
  await page.locator('#tab-tracker').click();
  await expect(page.locator('#collector-source')).toHaveValue('xtracker');
  await expect(page.locator('#x-filters')).toBeHidden();
  await page.locator('#collect').click();
  await expect(page.locator('#collection-preview')).toBeVisible();
  await expect(page.locator('#preview-text')).toContainText('Post Counter');
  await expect(page.locator('#tracker-summary')).toContainText(String(report.count));
  await expect(page.locator('#start')).toHaveValue(report.local_start);
  await expect(page.locator('#end')).toHaveValue(report.local_end);
  await page.locator('#tracker-confirm').check();
  await page.locator('#confirm-collect').click();
  await expect(page.locator('#message')).toContainText('Сохранено 720');
  await expect(page.locator('#data-summary')).toContainText('xtracker:post-counter:v1');
  await page.locator('#start').fill('2026-10-14T12:00');
  await page.locator('#sync-tracker').click();
  await expect(page.locator('#start')).toHaveValue(report.local_start);
});
