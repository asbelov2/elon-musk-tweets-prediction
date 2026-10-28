import { createApp } from '../../src/server/app.js';
import { demoEvent } from '../../src/server/demo.js';
import { Store } from '../../src/server/storage.js';
import { collectTracker, TRACKER_SOURCE } from '../../src/server/xtracker.js';
import type { Transport } from '../../src/server/http.js';
import { trackerFixture, whiteHouseFixture, SLUG, WHITE_HOUSE_SLUG } from './xtracker.js';

// Browser tests exercise the normal XTracker UI and forecast worker without external calls.
const now = Date.parse('2026-10-18T12:20:00Z');
const elon = trackerFixture(now),
  whiteHouse = whiteHouseFixture(now);
const event = demoEvent(now);
const transport: Transport = async (url) => {
  if (url.hostname === 'gamma-api.polymarket.com') {
    const slug = url.searchParams.get('slug');
    return {
      status: 200,
      json: async () => [
        {
          slug,
          title: 'Account post count',
          description: 'Resolution source: XTracker Post Counter',
          markets: event.markets.map((market, index) => ({
            id: market.id,
            groupItemTitle: market.label,
            outcomes: ['Yes', 'No'],
            clobTokenIds: [`fixture-${index}-yes`, `fixture-${index}-no`],
            active: true,
            acceptingOrders: true,
          })),
        },
      ],
    };
  }
  if (url.hostname === 'clob.polymarket.com') {
    const match = /^fixture-(\d+)-(yes|no)$/.exec(url.searchParams.get('token_id') ?? '');
    if (!match) throw new Error('Unknown fixture book');
    const book = event.markets[Number(match[1])].books[match[2] as 'yes' | 'no'];
    if (!book) throw new Error('Missing fixture book');
    return { status: 200, json: async () => ({ asks: book.asks }) };
  }
  if (url.hostname !== 'xtracker.polymarket.com')
    throw new Error('Unexpected provider in browser test');
  const white = url.pathname.includes('WhiteHouse') || url.pathname.includes(whiteHouse.detail.id);
  return (white ? whiteHouse : elon).transport(url);
};
const store = new Store(':memory:');
for (const [handle, slug] of [
  ['elonmusk', SLUG],
  ['WhiteHouse', WHITE_HOUSE_SLUG],
]) {
  const collection = await collectTracker({ days: 30, handle, event_url: slug }, transport, now);
  store.saveHours(collection.rows, 'xtracker', TRACKER_SOURCE, now, undefined, handle);
}
const app = await createApp({ store, transport, now: () => now, env: {} });
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 8011) });
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, async () => {
    await app.close();
    store.close();
  });
