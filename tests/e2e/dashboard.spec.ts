import { test, expect } from '@playwright/test';
import { trackerFixture, SLUG } from '../fixtures/xtracker.js';
import { collectTracker } from '../../src/server/xtracker.js';
import type { Analysis } from '../../src/shared/types.js';

test('Demo, outcome probabilities and interactive budget without recalculation', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  const analysisResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/analyze'),
  );
  await page.locator('#demo-empty').click();
  const analysis = (await (await analysisResponse).json()) as Analysis;
  await expect(page.locator('#result-content')).toBeVisible();
  await expect(page.locator('#demo-banner')).toBeVisible();
  await expect(page.locator('#positions-body tr')).toHaveCount(14);
  const markets = [...analysis.event!.markets].sort((a, b) => a.lower - b.lower);
  await expect(page.locator('#outcomes .outcome-label')).toHaveText(markets.map((m) => m.label));
  await expect(page.locator('#outcome-summary')).toContainText('Диапазоны по возрастанию');
  const peak = analysis.positions
    .filter((p) => p.side === 'YES')
    .sort((a, b) => b.probability - a.probability)[0];
  await expect(page.locator('#outcomes .is-most-likely')).toContainText(peak.label);
  await expect(page.locator('#distribution svg rect')).toHaveCount(markets.length);
  for (const [i, market] of markets.entries()) {
    const p = analysis.positions.find(
      (p) => p.market_id === market.id && p.side === 'YES',
    )!.probability;
    await expect(page.locator('#distribution rect title').nth(i)).toHaveText(
      `${market.label}: ${new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(p * 100)}%`,
    );
  }
  expect(await page.locator('#distribution svg text').allTextContents()).toEqual(
    expect.arrayContaining(markets.map((m) => m.label)),
  );
  await page.locator('#position-filter').selectOption('YES');
  await expect(page.locator('#positions-body tr')).toHaveCount(7);
  await page.locator('#budget').fill('200');
  await expect(page.locator('#result-content')).toBeVisible();
  await expect(page.locator('#allocation')).not.toBeEmpty();
  await expect(page.locator('#bank-plan')).toBeVisible();
  await expect(page.locator('#outcomes progress')).toHaveCount(7);
  await page.locator('#go-live').click();
  await expect(page.locator('#demo-banner')).toBeHidden();
  await expect(page.locator('#result-content')).toBeHidden();
  expect(errors).toEqual([]);
});

test('Cash advice keeps a full-bank scenario visible and budget changes do not repeat forecasting', async ({
  page,
}) => {
  let forecasts = 0;
  await page.route('**/api/analyze', async (route) => {
    forecasts++;
    const response = await route.fetch();
    const analysis = (await response.json()) as Analysis;
    analysis.fresh = false;
    analysis.dataset = 'xtracker';
    analysis.event!.fetched_at = '2026-01-01T00:00:00Z';
    for (const market of analysis.event!.markets)
      for (const book of Object.values(market.books)) book.fetched_at = '2026-01-01T00:00:00Z';
    for (const position of analysis.positions) position.signal = false;
    await route.fulfill({ json: analysis });
  });
  await page.goto('/');
  await page.locator('#demo-empty').click();
  await expect(page.locator('#result-content')).toBeVisible();
  for (const budget of [100, 200]) {
    await page.locator('#budget').fill(String(budget));
    await expect(page.locator('#allocation')).toContainText('Оставить весь бюджет в деньгах');
    await expect(page.locator('#bank-plan')).toBeVisible();
    await expect(page.locator('#bank-warnings')).toContainText('120 секунд');
    await expect(page.locator('#bank-warnings')).toContainText('свежести');
    const costs = await page.locator('#bank-rows td:nth-child(2)').allTextContents();
    expect(costs.length).toBeGreaterThan(0);
    const total = costs.reduce(
      (sum, text) => sum + Number(text.replace(/\s|\$/g, '').replace(',', '.')),
      0,
    );
    expect(total).toBeCloseTo(budget, 2);
    await expect(page.locator('#bank-risk')).toContainText('Вероятность убытка');
  }
  expect(forecasts).toBe(1);
  await page.locator('#bank-plan').screenshot({ path: '/tmp/tweetscope-bank-plan.png' });
  await page.locator('#budget').fill('');
  await expect(page.locator('#bank-plan')).toBeHidden();
  await expect(page.locator('#result-content')).toBeVisible();
});

test('Position columns sort numerically both ways and explain headers on hover or focus', async ({
  page,
}) => {
  await page.route('**/api/analyze', async (route) => {
    const response = await route.fetch();
    const analysis = (await response.json()) as Analysis;
    // An unavailable quote must stay at the bottom in either sort direction.
    Object.assign(analysis.positions[0], { vwap: null, expected_profit: null, roi: null });
    await route.fulfill({ json: analysis });
  });
  await page.goto('/');
  await page.locator('#demo-empty').click();
  await expect(page.locator('#positions-body tr')).toHaveCount(14);
  const columns = ['probability', 'vwap', 'edge', 'expected_profit', 'roi'];
  for (const [index, column] of columns.entries()) {
    const button = page.locator(`[data-sort="${column}"]`);
    await button.hover();
    await expect(page.getByRole('tooltip')).toBeVisible();
    expect((await page.getByRole('tooltip').textContent())!.length).toBeGreaterThan(30);
    for (let click = 0; click < 2; click++) {
      await button.click();
      const ascending = column === 'vwap' ? click === 0 : click === 1;
      await expect(button.locator('..')).toHaveAttribute(
        'aria-sort',
        ascending ? 'ascending' : 'descending',
      );
      const cells = await page
        .locator(`#positions-body tr td:nth-child(${index + 2})`)
        .allTextContents();
      const values = cells
        .filter((s) => s !== '—')
        .map((s) =>
          Number(
            s
              .replace(/\s/g, '')
              .replace(',', '.')
              .replace(/[^\d.+-]/g, ''),
          ),
        );
      expect(values).toEqual([...values].sort((a, b) => (ascending ? a - b : b - a)));
      if (column === 'vwap' || column === 'expected_profit' || column === 'roi') {
        expect(cells.at(-1)).toBe('—');
      }
    }
  }
  const probability = page.locator('[data-sort="probability"]');
  await probability.click();
  await page.locator('#position-filter').selectOption('YES');
  await expect(page.locator('#positions-body tr')).toHaveCount(7);
  await expect(probability.locator('..')).toHaveAttribute('aria-sort', 'descending');
  const label = page.locator('[data-sort="label"]');
  await label.click();
  await expect(page.locator('#positions-body tr').first()).toContainText('0-199');
  await expect(page.locator('#positions-body tr').last()).toContainText('600+');
  await label.press('Enter');
  await expect(page.locator('#positions-body tr').first()).toContainText('600+');
  await label.focus();
  await expect(page.getByRole('tooltip')).toContainText('YES');
  await label.press('Escape');
  await expect(page.getByRole('tooltip')).toBeHidden();
});

test('Many market brackets stay exact and readable within a horizontally scrolling chart', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.route('**/api/analyze', async (route) => {
    const response = await route.fetch();
    const analysis = (await response.json()) as Analysis;
    const market = analysis.event!.markets[0];
    const position = analysis.positions.find((p) => p.side === 'YES')!;
    analysis.event!.markets = Array.from({ length: 26 }, (_, i) => ({
      ...market,
      id: `bracket-${i}`,
      lower: i * 20,
      upper: i === 25 ? null : i * 20 + 19,
      label: i === 25 ? '500+' : `${i * 20}-${i * 20 + 19}`,
    })).reverse();
    analysis.positions = analysis.event!.markets.map((m) => ({
      ...position,
      market_id: m.id,
      label: m.label,
      probability: m.lower / 20 / 325,
    }));
    await route.fulfill({ json: analysis });
  });
  await page.goto('/');
  await page.locator('#demo-empty').click();
  await expect(page.locator('#distribution rect')).toHaveCount(26);
  await expect(page.locator('#distribution rect title').first()).toHaveText('0-19: 0,00%');
  await expect(page.locator('#distribution rect').first()).toHaveAttribute('height', '0');
  await expect(page.locator('#distribution rect title').last()).toContainText('500+');
  await expect(page.locator('#outcomes .outcome-label').first()).toHaveText('0-19');
  await expect(page.locator('#outcomes .outcome-label').last()).toHaveText('500+');
  expect(
    await page.locator('#distribution').evaluate((el) => el.scrollWidth > el.clientWidth),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#distribution').evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });
  await page
    .locator('#distribution')
    .screenshot({ path: '/tmp/tweetscope-layout-market-mobile.png' });
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
  await expect(page.locator('#distribution-description')).toContainText('без выбранного рынка');
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
    const spacing = await page.evaluate(() => {
      const outcomes = document.querySelector('.outcomes-panel')!.getBoundingClientRect();
      const budget = document.querySelector('.budget-panel')!.getBoundingClientRect();
      const positions = document.querySelector('.positions-panel')!.getBoundingClientRect();
      const heading = document.querySelector('.outcomes-panel h2')!.getBoundingClientRect();
      return [
        budget.top - outcomes.bottom,
        positions.top - budget.bottom,
        heading.left - outcomes.left,
      ];
    });
    expect(spacing.every((gap) => gap >= 12)).toBe(true);
  }
  await page.locator('#result-content').screenshot({ path: '/tmp/tweetscope-layout-desktop.png' });
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
