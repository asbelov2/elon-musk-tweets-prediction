import type { Transport } from '../../src/server/http.js';
import { DAY, HOUR, hour, iso } from '../../src/server/time.js';

export const TRACKING_ID = '11111111-1111-4111-8111-111111111111';
export const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const SLUG = 'elon-musk-of-tweets-october-13-october-20-2026';
export const WHITE_HOUSE_SLUG = 'white-house-of-tweets-october-13-october-20-2026';
export const WHITE_HOUSE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const WHITE_HOUSE_TRACKING = '33333333-3333-4333-8333-333333333333';
export function trackerFixture(
  now = Date.parse('2026-10-18T12:20:00Z'),
  config: {
    handle?: string;
    userId?: string;
    trackingId?: string;
    slug?: string;
    multiplier?: number;
  } = {},
) {
  const {
    handle = 'elonmusk',
    userId = USER_ID,
    trackingId = TRACKING_ID,
    slug = SLUG,
    multiplier = 1,
  } = config;
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
    for (let n = 0; n < multiplier * (i % 4 === 0 ? 2 : i % 4 === 1 ? 0 : 1); n++)
      posts.push({
        id: String(posts.length + 1),
        platformId: String(posts.length + 1),
        userId,
        createdAt: iso(t + (n + 1) * 60_000),
        content: '@user main-feed reply retained by tracker',
      });
  if (now - cutoff > 5 * 60_000)
    for (let n = 0; n < 2 * multiplier; n++)
      posts.push({
        id: String(posts.length + 1),
        platformId: String(posts.length + 1),
        userId,
        createdAt: iso(cutoff + (n + 1) * 60_000),
        content: 'Partial hour counted',
      });
  const profile = {
    id: userId,
    handle,
    platform: 'X',
    lastSync: iso(now - 60_000),
    lastSyncError: null as string | null,
    _count: { posts: posts.length },
  };
  const target = {
    id: trackingId,
    userId,
    title: handle + ' posts',
    startDate: iso(start),
    endDate: iso(end - 1000),
    marketLink: 'https://polymarket.com/event/' + slug,
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
          slug,
          title: handle,
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
    else if (url.pathname === `/api/users/${handle}`) value = profile;
    else if (url.pathname === `/api/users/${handle}/trackings`) value = windows;
    else if (url.pathname === `/api/users/${handle}/posts`) value = posts;
    else if (url.pathname === `/api/trackings/${trackingId}`) value = detail;
    else return { status: 404, json: async () => ({}) };
    return {
      status: 200,
      json: async () =>
        url.hostname === 'xtracker.polymarket.com' ? { success: true, data: value } : value,
    };
  };
  return { profile, windows, posts, detail, transport, start, end, now };
}

export function whiteHouseFixture(now?: number) {
  return trackerFixture(now, {
    handle: 'WhiteHouse',
    userId: WHITE_HOUSE_ID,
    trackingId: WHITE_HOUSE_TRACKING,
    slug: WHITE_HOUSE_SLUG,
    multiplier: 2,
  });
}
