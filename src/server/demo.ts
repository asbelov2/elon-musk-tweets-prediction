import { DateTime } from 'luxon';
import type { DemoEvent, HourRow, Market, Side } from '../shared/types.js';
import { Random } from './random.js';
import { DAY, HOUR, hour, iso, localParts } from './time.js';

export function demoHours(now = Date.now()): HourRow[] {
  const end = hour(now),
    start = end - 120 * DAY,
    rng = new Random(731),
    factors = new Map<string, number>();
  const rows: HourRow[] = [];
  for (let i = 0; i < 120 * 24; i++) {
    const time = start + i * HOUR,
      local = localParts(time, 'America/New_York');
    if (!factors.has(local.day)) factors.set(local.day, rng.gamma(4, 0.25));
    const pattern =
      0.35 +
      1.3 * Math.exp(-(((local.hour - 14) / 5) ** 2)) +
      0.65 * Math.exp(-(((local.hour - 23) / 3) ** 2));
    rows.push([
      time,
      rng.poisson(3.2 * pattern * factors.get(local.day)! * (local.weekday < 5 ? 1.12 : 0.8)),
    ]);
  }
  return rows;
}

export function demoEvent(now = Date.now()): DemoEvent {
  const zone = 'America/New_York';
  const start = DateTime.fromMillis(now, { zone })
      .minus({ days: 5 })
      .set({ hour: 12, minute: 0, second: 0, millisecond: 0 }),
    end = start.plus({ days: 7 });
  const limits: [number, number | null][] = [
    [0, 199],
    [200, 279],
    [280, 359],
    [360, 439],
    [440, 519],
    [520, 599],
    [600, null],
  ];
  const prices = [0.035, 0.1, 0.21, 0.27, 0.21, 0.11, 0.065];
  const markets: Market[] = limits.map(([lower, upper], i) => {
    const books: Market['books'] = {};
    for (const side of ['yes', 'no'] as Side[]) {
      const price = side === 'yes' ? prices[i] : 1 - prices[i];
      books[side] = {
        asks: [
          { price: Math.min(0.999, price + 0.008), size: 250 },
          { price: Math.min(0.999, price + 0.02), size: 2500 },
        ],
        fetched_at: iso(now),
      };
    }
    return {
      id: `demo-${i}`,
      label: upper === null ? `${lower}+` : `${lower}-${upper}`,
      lower,
      upper,
      active: true,
      fees_enabled: false,
      tokens: {},
      books,
    };
  });
  return {
    slug: 'demo',
    title: 'Демонстрация • публикации за 7 дней',
    description:
      'Искусственная история и искусственные стаканы. Эти данные не относятся к реальному рынку и не подходят для ставок.',
    resolution_source: 'Синтетический генератор',
    markets,
    excluded: [],
    fetched_at: iso(now),
    demo: true,
    start: start.toFormat("yyyy-MM-dd'T'HH:mm"),
    end: end.toFormat("yyyy-MM-dd'T'HH:mm"),
    timezone: zone,
  };
}
