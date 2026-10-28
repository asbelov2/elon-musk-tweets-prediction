import { test, expect } from '@playwright/test';
import { trackerFixture, whiteHouseFixture, SLUG, WHITE_HOUSE_SLUG } from '../fixtures/xtracker.js';
import { collectTracker } from '../../src/server/xtracker.js';
import type { Analysis } from '../../src/shared/types.js';

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-18T12:20:00Z') });
});

test('XTracker forecast, outcome probabilities and interactive budget without recalculation', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  const analysisResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/analyze'),
  );
  await page.locator('#analyze').click();
  const analysis = (await (await analysisResponse).json()) as Analysis;
  await expect(page.locator('#result-content')).toBeVisible();
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
  await page.locator('#market-select').selectOption(WHITE_HOUSE_SLUG);
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
  await page.locator('#analyze').click();
  await expect(page.locator('#result-content')).toBeVisible();
  for (const budget of [100, 200]) {
    await page.locator('#budget').fill(String(budget));
    await expect(page.locator('#allocation')).toContainText('Оставить весь бюджет в деньгах');
    await expect(page.locator('#bank-plan')).toBeVisible();
    await expect(page.locator('#activity-warnings')).toContainText('условные');
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
  await page.locator('#analyze').click();
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
  await page.locator('#analyze').click();
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

test('Streamlined XTracker interface, CSV export and offline API documentation', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#history-management')).toBeVisible();
  for (const id of [
    'demo',
    'demo-empty',
    'demo-banner',
    'history-source',
    'collector-source',
    'csv-panel',
    'csv-confirm',
    'tracker-confirm',
    'rules-confirm',
    'one-day',
    'target-date',
  ])
    await expect(page.locator('#' + id)).toHaveCount(0);
  await expect(page.locator('#period-timezone')).toContainText('America/New_York');
  await expect(page.locator('#start')).toHaveAttribute('readonly', '');
  await expect(page.locator('#end')).toHaveAttribute('readonly', '');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByText('Экспорт реальной истории в CSV').click(),
  ]);
  expect(download.suggestedFilename()).toBe('tweets-hourly.csv');
  await page.goto('/api/docs');
  await expect(
    page.locator('#api-paths summary').filter({ hasText: 'GET /api/markets' }),
  ).toHaveCount(1);
  await expect(
    page.locator('#api-paths summary').filter({ hasText: 'POST /api/markets' }),
  ).toHaveCount(1);
  await expect(
    page.locator('#api-paths summary').filter({ hasText: 'POST /api/analyze' }),
  ).toHaveCount(1);
  expect(await page.locator('#api-schemas summary').count()).toBeGreaterThanOrEqual(2);
  expect(errors).toEqual([]);
});

test('Dashboard fits mobile and desktop viewports', async ({ page }) => {
  await page.goto('/');
  await page.locator('#analyze').click();
  await expect(page.locator('#result-content')).toBeVisible();
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const spacing = await page.evaluate(() => {
      const activity = document.querySelector('#activity-panel')!.getBoundingClientRect();
      const budget = document.querySelector('.budget-panel')!.getBoundingClientRect();
      const positions = document.querySelector('.positions-panel')!.getBoundingClientRect();
      const heading = document.querySelector('.outcomes-panel h2')!.getBoundingClientRect();
      return [
        budget.top - activity.bottom,
        positions.top - budget.bottom,
        heading.left - document.querySelector('.outcomes-panel')!.getBoundingClientRect().left,
      ];
    });
    expect(spacing.every((gap) => gap >= 12)).toBe(true);
  }
  await page.locator('#result-content').screenshot({ path: '/tmp/tweetscope-layout-desktop.png' });
});

test('One-click XTracker collection saves verified history and applies the authoritative period', async ({
  page,
}) => {
  const fixture = trackerFixture(),
    collection = await collectTracker(
      { days: 30, event_url: SLUG },
      fixture.transport,
      fixture.now,
    ),
    report = collection.tracker!;
  let saved = false;
  let legacyRequests = 0;
  await page.route(/\/api\/collect(?:\/.*)?$/, (route) => {
    legacyRequests++;
    return route.abort('blockedbyclient');
  });
  const empty = { hours: 0, posts: 0, sources: [], start: null, end: null };
  await page.route('**/api/status*', (route) =>
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
  await page.route('**/api/history/preview', (route) =>
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
  await page.route('**/api/history/confirm', (route) => {
    saved = true;
    return route.fulfill({ json: { imported_hours: collection.rows.length, dataset: 'xtracker' } });
  });
  await page.route('**/api/xtracker?*', (route) => route.fulfill({ json: report }));
  await page.goto('/');
  await page.locator('#collect').click();
  await expect(page.locator('#history-result')).toBeVisible();
  await expect(page.locator('#history-result')).toContainText('Post Counter');
  await expect(page.locator('#tracker-summary')).toContainText(String(report.count));
  await expect(page.locator('#start')).toHaveValue(report.local_start);
  await expect(page.locator('#end')).toHaveValue(report.local_end);
  await expect(page.locator('#message')).toContainText('проверена и сохранена');
  await expect(page.locator('#data-summary')).toContainText('xtracker:post-counter:v1');
  await page.locator('#sync-tracker').click();
  await expect(page.locator('#start')).toHaveValue(report.local_start);
  expect(legacyRequests).toBe(0);
});

test('Collection validates depth locally and displays server and network errors beside the button', async ({
  page,
}) => {
  let requests = 0;
  let failNetwork = false;
  await page.route('**/api/history/preview', (route) => {
    requests++;
    if (failNetwork) return route.abort('blockedbyclient');
    return route.fulfill({ status: 422, json: { detail: 'body/days must be integer' } });
  });
  await page.goto('/');
  await expect(page.locator('#history-management')).toBeVisible();
  for (const value of ['', '14', '15.5', '121']) {
    await page.locator('#history-days').fill(value);
    await page.locator('#collect').click();
    await expect(page.locator('#history-message')).toContainText('целое число от 15 до 120');
  }
  expect(requests).toBe(0);
  await page.locator('#history-days').fill('30');
  await page.locator('#collect').click();
  await expect(page.locator('#history-message')).toContainText('HTTP 422');
  await expect(page.locator('#history-message')).toContainText('body/days must be integer');
  expect(requests).toBe(1);
  failNetwork = true;
  await page.locator('#collect').click();
  await expect(page.locator('#history-message')).toContainText('ERR_BLOCKED_BY_CLIENT');
  await expect(page.locator('#history-result')).toBeHidden();
  await expect(page.locator('#collect')).toBeEnabled();
  expect(requests).toBe(2);
  await page.locator('#market-select').selectOption(WHITE_HOUSE_SLUG);
  await expect(page.locator('#history-message')).toBeHidden();
});

test('Market switching resets results and ignores a late counter from the previous account', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('#market-select option')).toHaveCount(2);
  await page.locator('#analyze').click();
  await expect(page.locator('#result-content')).toBeVisible();
  await page.locator('#market-select').selectOption(WHITE_HOUSE_SLUG);
  await expect(page.locator('#result-content')).toBeHidden();
  await expect(page.locator('#selected-account')).toContainText('@WhiteHouse');
  await expect(page.locator('#event-url')).toHaveValue(
    'https://polymarket.com/event/' + WHITE_HOUSE_SLUG,
  );
  await expect(page.locator('#export-history')).toHaveAttribute('href', /handle=WhiteHouse/);
  const f = whiteHouseFixture();
  const report = (
    await collectTracker(
      { days: 30, event_url: WHITE_HOUSE_SLUG, handle: 'WhiteHouse' },
      f.transport,
      f.now,
    )
  ).tracker!;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route('**/api/xtracker?*', async (route) => {
    expect(new URL(route.request().url()).searchParams.get('handle')).toBe('WhiteHouse');
    started();
    await gate;
    await route.fulfill({ json: report });
  });
  await page.locator('#sync-tracker').click();
  await requested;
  await page.locator('#market-select').selectOption(SLUG);
  release();
  await expect(page.locator('#sync-tracker')).toBeEnabled();
  await expect(page.locator('#tracker-counter')).toBeHidden();
  await expect(page.locator('#event-url')).toHaveValue('https://polymarket.com/event/' + SLUG);
  await expect(page.locator('#selected-account')).toContainText('@elonmusk');
  await expect(page.locator('#start')).toHaveValue('');
  await expect(page.locator('#event-title')).toHaveText('Рынок ещё не загружен');
});

test('Adding a verified market makes it selectable and visible after reloading the catalog', async ({
  page,
}) => {
  let added = false;
  const item = {
    id: 'nasa-posts-next-week',
    label: 'NASA posts',
    handle: 'NASA',
    event_url: 'https://polymarket.com/event/nasa-posts-next-week',
  };
  await page.route('**/api/markets', async (route) => {
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON()).toEqual({
        handle: 'NASA',
        event_url: item.event_url,
        label: item.label,
      });
      added = true;
      await route.fulfill({ json: item });
    } else {
      const response = await route.fetch();
      const markets = (await response.json()) as unknown[];
      await route.fulfill({ json: added ? [...markets, item] : markets });
    }
  });
  await page.goto('/');
  await expect(page.locator('#market-select option')).toHaveCount(2);
  await page.locator('#add-market-form summary').click();
  await expect(page.locator('#new-market-handle')).toHaveAttribute('placeholder', '@elonmusk');
  await expect(page.locator('#account-suggestions option').first()).toHaveAttribute(
    'value',
    '@elonmusk',
  );
  await page.locator('#new-market-url').fill(item.event_url);
  await page.locator('#new-market-handle').fill(item.handle);
  await page.locator('#new-market-label').fill(item.label);
  await page.locator('#add-market').click();
  await expect(page.locator('#market-select')).toHaveValue(item.id);
  await expect(page.locator('#selected-account')).toContainText('@NASA');
  await expect(page.locator('#message')).toContainText('Рынок проверен и сохранён');
  await page.reload();
  await expect(page.locator('#market-select option')).toHaveCount(3);
  await page.locator('#market-select').selectOption(item.id);
  await expect(page.locator('#event-url')).toHaveValue(item.event_url);
});

test('Activity profile shows hourly and weekly rhythms, near-term outlook and an accessible mobile heatmap', async ({
  page,
}) => {
  await page.goto('/');
  const response = page.waitForResponse((r) => r.url().endsWith('/api/analyze'));
  await page.locator('#analyze').click();
  const analysis = (await (await response).json()) as Analysis;
  await expect(page.locator('#activity-panel')).toBeVisible();
  await expect(page.locator('#activity-title')).toContainText('@elonmusk');
  await expect(page.locator('#activity-meta')).toContainText(analysis.activity!.timezone);
  await expect(page.locator('#activity-meta')).toContainText(
    `${analysis.activity!.training_days} полных дней`,
  );
  await expect(page.locator('#activity-hourly rect')).toHaveCount(24);
  await expect(page.locator('#activity-day')).toHaveValue(
    String(analysis.activity!.current_weekday),
  );
  await page.locator('#activity-day').selectOption('0');
  const mondayPeak = analysis.activity!.weekdays[0].peak;
  if (mondayPeak.mean_per_hour > analysis.activity!.weekdays[0].quiet.mean_per_hour * 1.15)
    await expect(page.locator('#activity-peak')).toHaveText(
      `${String(mondayPeak.start_hour).padStart(2, '0')}:00–${String(mondayPeak.end_hour).padStart(2, '0')}:00`,
    );
  await page.locator('#activity-day').selectOption('all');
  await expect(page.locator('#activity-day')).toHaveValue('all');
  await expect(page.locator('#activity-weekdays rect')).toHaveCount(7);
  await expect(page.locator('#activity-upcoming .activity-slot')).toHaveCount(6);
  for (const [index, item] of analysis.activity!.upcoming.entries()) {
    const date = new Date(item.start).toLocaleString('ru-RU', {
      timeZone: 'Europe/Moscow',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
    await expect(
      page.locator('#activity-upcoming .activity-slot').nth(index).locator('small').last(),
    ).toContainText(`МСК: ${date}`);
  }
  await expect(page.locator('#activity-next-chance')).toContainText('Хотя бы одна');
  await expect(page.locator('#activity-trend')).toContainText('Последние 7 полных дней');
  await page.locator('.activity-details summary').click();
  await expect(page.locator('.activity-heat-cell')).toHaveCount(168);
  const cell = page.locator('.activity-heat-cell').first();
  await cell.focus();
  await expect(cell).toBeFocused();
  await expect(cell).toHaveAttribute('aria-label', /Пн 00:00–01:00.*часов наблюдений/);
  await page
    .locator('#activity-panel')
    .screenshot({ path: '/tmp/tweetscope-activity-desktop.png' });
  await page.setViewportSize({ width: 390, height: 900 });
  const headingFits = await page.locator('.activity-heading').evaluate((heading) => {
    const title = heading.querySelector('h2')!.getBoundingClientRect();
    const control = heading.querySelector('label')!.getBoundingClientRect();
    return title.bottom <= control.top || title.right + 8 <= control.left;
  });
  expect(headingFits).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    await page.locator('#activity-heatmap').evaluate((el) => el.scrollWidth > el.clientWidth),
  ).toBe(true);
  await page.locator('#activity-panel').screenshot({ path: '/tmp/tweetscope-activity-mobile.png' });
  await page.locator('#market-select').selectOption(WHITE_HOUSE_SLUG);
  await expect(page.locator('#result-content')).toBeHidden();
});

test('Panels collapse with the keyboard, preserve preferences and keep activity above outcomes', async ({
  page,
}) => {
  await page.goto('/');
  const dataToggle = page.locator('[data-panel="data"] .panel-toggle');
  await expect(dataToggle).toHaveAttribute('aria-expanded', 'true');
  await dataToggle.click();
  await expect(page.locator('#history-management')).toBeHidden();
  await expect(dataToggle).toHaveAttribute('aria-expanded', 'false');
  await dataToggle.press('Enter');
  await expect(page.locator('#history-management')).toBeVisible();
  await page.locator('#analyze').click();
  await expect(page.locator('#activity-panel')).toBeVisible();
  expect(
    await page
      .locator('#activity-panel')
      .evaluate((panel) =>
        Boolean(
          panel.compareDocumentPosition(document.querySelector('.outcomes-panel')!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      ),
  ).toBe(true);
  const toggle = page.locator('#activity-panel .panel-toggle');
  await toggle.click();
  await expect(page.locator('#activity-title')).toBeVisible();
  await expect(page.locator('#activity-upcoming')).toBeHidden();
  await page.reload();
  await page.locator('#analyze').click();
  await expect(page.locator('#activity-panel')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#activity-hourly')).toBeHidden();
  await toggle.press('Space');
  await expect(page.locator('#activity-hourly')).toBeVisible();
  await expect(page.locator('#positions-body tr')).toHaveCount(14);
});

test('Reference clocks label market time, update every second and adjust Texas daylight saving time', async ({
  page,
}) => {
  await page.clock.pauseAt(new Date('2026-10-18T12:21:00Z'));
  await page.goto('/');
  await expect(page.locator('#display-timezone-note')).toContainText('Нью-Йорк (ET)');
  await expect(page.locator('#display-timezone-note')).toContainText('Москва (МСК)');
  await expect(page.locator('#texas-clock')).toHaveText('07:21:00');
  await expect(page.locator('#market-clock')).toHaveText('08:21:00');
  await expect(page.locator('#moscow-clock')).toHaveText('15:21:00');
  await expect(page.locator('#texas-zone')).toHaveText('America/Chicago · UTC-5');
  await page.clock.runFor(1000);
  await expect(page.locator('#texas-clock')).toHaveText('07:21:01');
  await page.clock.setSystemTime(new Date('2026-12-18T12:21:00Z'));
  await page.clock.runFor(1000);
  await expect(page.locator('#texas-clock')).toHaveText('06:21:01');
  await expect(page.locator('#market-clock')).toHaveText('07:21:01');
  await expect(page.locator('#texas-zone')).toHaveText('America/Chicago · UTC-6');
  await page.locator('#add-market-form summary').click();
  await expect(page.locator('#new-market-handle')).toHaveAttribute('list', 'account-suggestions');
});
