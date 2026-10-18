import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bounds,
  collectPosts,
  fetchEvent,
  normalizeEvent,
  slugFrom,
} from '../src/server/providers.js';
import { collectX, credentialsPresent } from '../src/server/x-api.js';
import type { RemoteResponse, Transport } from '../src/server/http.js';
import { DAY, HOUR, hour, iso } from '../src/server/time.js';

const now = Date.parse('2026-10-18T12:20:00Z'),
  end = hour(now),
  t = end - 2 * HOUR;
const response = (payload: unknown, status = 200): RemoteResponse => ({
  status,
  json: async () => payload,
});
const env = { X_BEARER_TOKEN: 'fixture-token' };
const options = {
  days: 30,
  include_replies: false,
  include_reposts: true,
  mode: 'archive' as const,
};
const gammaEvent = () => ({
  slug: 'test',
  title: 'Test',
  markets: [
    {
      id: '1',
      groupItemTitle: '200-219',
      outcomes: '["No","Yes"]',
      clobTokenIds: '["n","y"]',
      active: true,
      acceptingOrders: true,
      description: 'Counting rules',
      resolutionSource: 'Post Counter',
    },
  ],
});

test('Inclusive ranges, open tails and unsupported labels', () => {
  for (const [label, expected] of [
    ['200–219', [200, 219]],
    ['<200', [0, 199]],
    ['600+', [600, null]],
    ['600 or more', [600, null]],
    ['>600', [601, null]],
    ['under 20', [0, 19]],
  ] as const)
    assert.deepEqual(bounds(label), expected);
  for (const label of ['Will Elon tweet 300 times?', '40-20', '<0'])
    assert.throws(() => bounds(label));
});
test('Only sanitized Polymarket slugs and event URLs are accepted', () => {
  assert.equal(slugFrom('https://polymarket.com/ru/event/example?x=y'), 'example');
  for (const value of [
    'https://127.0.0.1/event/example',
    'http://polymarket.com/event/example',
    'https://polymarket.com',
    '../etc/passwd',
  ])
    assert.throws(() => slugFrom(value));
});
test('Overlapping or unrecognizable markets are rejected', () => {
  const event = gammaEvent();
  event.markets.push({ ...event.markets[0], id: '2', groupItemTitle: '210-229' });
  assert.throws(() => normalizeEvent(event), /пересекаются/);
  assert.throws(
    () => normalizeEvent({ slug: 'test', markets: [{ groupItemTitle: 'Unknown' }] }),
    /не найдены/,
  );
});
test('Gamma outcome/token mapping, rules fallback and unordered CLOB asks', async () => {
  const calls: URL[] = [];
  const transport: Transport = async (url) => {
    calls.push(url);
    return url.hostname === 'gamma-api.polymarket.com'
      ? response([gammaEvent()])
      : response({
          asks: [
            { price: '0.5', size: '100' },
            { price: '0.2', size: '20' },
          ],
        });
  };
  const event = await fetchEvent('test', transport),
    market = event.markets[0];
  assert.equal(market.tokens.yes, 'y');
  assert.equal(market.books.yes?.asks[0].price, 0.2);
  assert.equal(event.description, 'Counting rules');
  assert.equal(event.resolution_source, 'Post Counter');
  assert.equal(calls.length, 3);
});
test('Closed markets do not request nonexistent books', async () => {
  let calls = 0;
  const event = gammaEvent();
  event.markets[0].active = false;
  const result = await fetchEvent('test', async () => {
    calls++;
    return response([event]);
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.markets[0].books.yes?.asks, []);
});
test('Partial CLOB failures never become fake prices', async () => {
  const event = await fetchEvent('test', async (url) =>
    url.hostname === 'gamma-api.polymarket.com' ? response([gammaEvent()]) : response({}, 503),
  );
  assert.deepEqual(event.markets[0].books.yes?.asks, []);
  assert.match(event.markets[0].books.yes?.error ?? '', /503/);
});
test('Missing events, network failures and malformed remote JSON fail explicitly', async () => {
  await assert.rejects(
    fetchEvent('test', async () => response([])),
    /не найдено/,
  );
  await assert.rejects(
    fetchEvent('test', async () => {
      throw new Error('network');
    }),
    /недоступен/,
  );
  await assert.rejects(
    fetchEvent('test', async () => ({
      status: 200,
      json: async () => {
        throw new Error('json');
      },
    })),
    /JSON/,
  );
});
test('X archive paginates, deduplicates IDs, filters references and sends scoped auth', async () => {
  const transport: Transport = async (url, headers) => {
    assert.equal(url.hostname, 'api.x.com');
    assert.equal(url.pathname, '/2/tweets/search/all');
    assert.equal(headers?.Authorization, 'Bearer fixture-token');
    if (url.searchParams.has('next_token'))
      return response({
        data: [
          { id: '1', created_at: iso(t) },
          { id: '3', created_at: iso(t), referenced_tweets: [{ type: 'retweeted', id: '8' }] },
        ],
        meta: {},
      });
    return response({
      data: [
        { id: '1', created_at: iso(t) },
        { id: '2', created_at: iso(t), referenced_tweets: [{ type: 'replied_to', id: '7' }] },
      ],
      meta: { next_token: 'page2' },
    });
  };
  const result = await collectX(options, transport, now, env);
  assert.equal(result.posts, 2);
  assert.equal(result.rows.length, 720);
  assert.equal(new Map(result.rows).get(t), 2);
});
test('X timeline stops only after reaching an older boundary record', async () => {
  const transport: Transport = async (url) =>
    url.pathname.includes('/by/username/')
      ? response({ data: { id: '44196397' } })
      : response({
          data: [
            { id: '1', created_at: iso(t) },
            { id: '0', created_at: iso(end - 31 * DAY) },
          ],
          meta: {},
        });
  assert.equal((await collectX({ ...options, mode: 'timeline' }, transport, now, env)).posts, 1);
});
test('Truncated X timeline is rejected instead of filling unknown hours with zero', async () => {
  const transport: Transport = async (url) =>
    url.pathname.includes('/by/username/')
      ? response({ data: { id: '44196397' } })
      : response({ data: [{ id: '1', created_at: iso(t) }], meta: {} });
  await assert.rejects(
    collectX({ ...options, mode: 'timeline' }, transport, now, env),
    /Лента X закончилась/,
  );
});
test('Missing bearer token does not make a request', async () => {
  let calls = 0;
  await assert.rejects(
    collectX(
      options,
      async () => {
        calls++;
        return response({});
      },
      now,
      {},
    ),
    /X_BEARER_TOKEN/,
  );
  assert.equal(calls, 0);
  assert.equal(credentialsPresent({}), false);
  assert.equal(credentialsPresent({ TWITTER_BEARER_TOKEN: 'fixture' }), true);
});
test('X auth, billing, scope, rate limits and partial errors are distinguished', async () => {
  for (const [code, message] of [
    [401, /авторизацию/],
    [402, /Тариф/],
    [403, /Тариф/],
    [429, /Лимит/],
  ] as const)
    await assert.rejects(
      collectX(options, async () => response({}, code), now, env),
      message,
    );
  await assert.rejects(
    collectX(
      options,
      async () => response({ data: [], errors: [{ message: 'partial failure' }] }),
      now,
      env,
    ),
    /частичном/,
  );
  await assert.rejects(
    collectX(options, async () => response({ data: [], meta: {} }), now, env),
    /пустую историю/,
  );
});
test('Repeated X cursors and malformed pages are rejected', async () => {
  await assert.rejects(
    collectX(
      options,
      async () =>
        response({ data: [{ id: '1', created_at: iso(t) }], meta: { next_token: 'same' } }),
      now,
      env,
    ),
    /повторяет/,
  );
  await assert.rejects(
    collectX(options, async () => response({ data: [{ id: '1' }] }), now, env),
    /структура/,
  );
});
test('XTracker contract pages deduplicate and filter before staging zeros', async () => {
  const transport: Transport = async (url) => {
    const page = Number(url.searchParams.get('page'));
    const posts =
      page === 1
        ? [
            { id: '1', createdAt: iso(t), type: 'tweet' },
            { id: '2', createdAt: iso(t), type: 'reply' },
          ]
        : [
            { id: '1', createdAt: iso(t), type: 'tweet' },
            { id: '3', createdAt: iso(t), type: 'retweet' },
          ];
    return response({ data: { posts, pagination: { totalPages: 2 } } });
  };
  const result = await collectPosts({ ...options, days: 15 }, transport, now);
  assert.equal(result.posts, 2);
  assert.equal(result.rows.length, 360);
  assert.equal(new Map(result.rows).get(t), 2);
});
test('Observed XTracker response without types is not guessed', async () => {
  await assert.rejects(
    collectPosts(
      options,
      async () =>
        response({
          success: true,
          data: [{ id: 'tracker', platformId: '123', createdAt: iso(t), content: 'post' }],
        }),
      now,
    ),
    /не передаёт типы/,
  );
});
test('XTracker repeated pages and unknown publication types are rejected', async () => {
  await assert.rejects(
    collectPosts(
      options,
      async () => response({ data: [{ id: '1', createdAt: iso(t), type: 'tweet' }] }),
      now,
    ),
    /повторяет/,
  );
  await assert.rejects(
    collectPosts(
      options,
      async () =>
        response({
          data: {
            posts: [{ id: '1', createdAt: iso(t), type: 'unknown' }],
            pagination: { hasMore: false },
          },
        }),
      now,
    ),
    /тип публикации/,
  );
});
