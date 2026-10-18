import type { Transport } from '../../src/server/http.js';
import { DAY, HOUR, hour, iso } from '../../src/server/time.js';

export const TRACKING_ID = '11111111-1111-4111-8111-111111111111';
export const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const SLUG = 'elon-musk-of-tweets-october-13-october-20-2026';
export function trackerFixture(now = Date.parse('2026-10-18T12:20:00Z')) {
  const cutoff = hour(now),
    start = Date.parse('2026-10-13T16:00:00Z'),
    end = Date.parse('2026-10-20T16:00:00Z'),
    historyStart = cutoff - 45 * DAY;
  const posts: {
    id: string;
    platformId: string;
    userId: string;
    createdAt: string;
    content: string;
  }[] = [];
  for (let t = historyStart, i = 0; t < cutoff; t += HOUR, i++)
    for (let n = 0; n < (i % 4 === 0 ? 2 : i % 4 === 1 ? 0 : 1); n++)
      posts.push({
        id: String(posts.length + 1),
        platformId: String(posts.length + 1),
        userId: USER_ID,
        createdAt: iso(t + (n + 1) * 60_000),
        content: '@user main-feed reply retained by tracker',
      });
  if (now - cutoff > 5 * 60_000)
    for (let n = 0; n < 2; n++)
      posts.push({
        id: String(posts.length + 1),
        platformId: String(posts.length + 1),
        userId: USER_ID,
        createdAt: iso(cutoff + (n + 1) * 60_000),
        content: 'Partial hour counted',
      });
  const profile = {
    id: USER_ID,
    handle: 'elonmusk',
    platform: 'X',
    lastSync: iso(now - 60_000),
    lastSyncError: null as string | null,
    _count: { posts: posts.length },
  };
  const target = {
    id: TRACKING_ID,
    userId: USER_ID,
    title: 'Elon Musk tweets',
    startDate: iso(start),
    endDate: iso(end - 1000),
    marketLink: 'https://polymarket.com/event/' + SLUG,
  };
  const windows = [
    target,
    {
      ...target,
      id: '22222222-2222-4222-8222-222222222222',
      startDate: iso(historyStart),
      endDate: iso(cutoff + 3 * DAY - 1000),
      marketLink: null,
    },
  ];
  let cumulative = 0;
  const daily = [];
  for (let t = start; t <= hour(now) && t < end; t += HOUR) {
    const count = posts.filter((p) => {
      const ts = Date.parse(p.createdAt);
      return ts >= t && ts < t + HOUR;
    }).length;
    cumulative += count;
    daily.push({ date: iso(t), count, cumulative });
  }
  const detail = { ...target, user: profile, stats: { total: cumulative, daily } };
  const transport: Transport = async (url) => {
    let value: unknown;
    if (url.hostname === 'gamma-api.polymarket.com')
      value = [
        {
          slug: SLUG,
          title: 'Elon Musk',
          description: 'Resolution source: XTracker Post Counter',
          markets: [
            {
              id: 'm1',
              groupItemTitle: '0+',
              outcomes: ['Yes', 'No'],
              clobTokenIds: ['yes', 'no'],
              active: true,
              acceptingOrders: true,
            },
          ],
        },
      ];
    else if (url.hostname === 'clob.polymarket.com')
      value = { asks: [{ price: '.4', size: '10000' }] };
    else if (url.pathname === '/api/users/elonmusk') value = profile;
    else if (url.pathname === '/api/users/elonmusk/trackings') value = windows;
    else if (url.pathname === '/api/users/elonmusk/posts') value = posts;
    else if (url.pathname === `/api/trackings/${TRACKING_ID}`) value = detail;
    else return { status: 404, json: async () => ({}) };
    return {
      status: 200,
      json: async () =>
        url.hostname === 'xtracker.polymarket.com' ? { success: true, data: value } : value,
    };
  };
  return { profile, windows, posts, detail, transport, start, end, now };
}
