import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import rateLimit from '@fastify/rate-limit';
import { webConfig } from './web-config.js';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type {
  Analysis,
  Collection,
  CollectRequest,
  Dataset,
  MarketEvent,
  Status,
  TrackerReport,
} from '../shared/types.js';
import { accountKey, DEFAULT_HANDLE } from './accounts.js';
import { archiveMarket, listMarkets, resolveHandle, saveMarket } from './markets.js';
import { demoEvent, demoHours } from './demo.js';
import { AppError } from './errors.js';
import { runForecast } from './forecast-runner.js';
import type { Transport } from './http.js';
import { eventSchema, fetchEvent, slugFrom } from './providers.js';
import { Store, readCsv } from './storage.js';
import { HOUR, iso, localTime, parseTime } from './time.js';
import { evaluate } from './trading.js';
import { collectX, credentialsPresent, type Credentials } from './x-api.js';
import {
  collectTracker,
  fetchTrackerCounter,
  TRACKER_SOURCE,
  trackerReportSchema,
} from './xtracker.js';

const Handle = Type.Optional(
  Type.String({ minLength: 1, maxLength: 16, pattern: '^@?[a-zA-Z0-9_]{1,15}$' }),
);
const AnalyzeBody = Type.Object(
  {
    handle: Handle,
    dataset: Type.Union([Type.Literal('live'), Type.Literal('demo'), Type.Literal('xtracker')], {
      default: 'xtracker',
    }),
    event_url: Type.String({ default: '', maxLength: 500 }),
    start: Type.String({ maxLength: 40 }),
    end: Type.String({ maxLength: 40 }),
    timezone: Type.String({ default: 'America/New_York', maxLength: 80 }),
    budget: Type.Number({ default: 100, minimum: 1, maximum: 1_000_000 }),
    expense_bps: Type.Number({ default: 100, minimum: 0, maximum: 5000 }),
    safety_pp: Type.Number({ default: 5, minimum: 0, maximum: 50 }),
    rules_confirmed: Type.Boolean({ default: false }),
  },
  { additionalProperties: false },
);
const CollectBody = Type.Object(
  {
    handle: Handle,
    source: Type.Union([Type.Literal('x'), Type.Literal('xtracker')], { default: 'xtracker' }),
    event_url: Type.String({ default: '', maxLength: 500 }),
    mode: Type.Union([Type.Literal('archive'), Type.Literal('timeline')], { default: 'archive' }),
    days: Type.Integer({ default: 90, minimum: 15, maximum: 120 }),
    include_replies: Type.Boolean({ default: false }),
    include_reposts: Type.Boolean({ default: true }),
  },
  { additionalProperties: false },
);
const Confirmed = Type.Boolean({ default: false });

interface AppOptions {
  store?: Store;
  transport?: Transport;
  env?: Credentials;
  logger?: boolean;
  publicDir?: string;
  now?: () => number;
}
interface Staged {
  created: number;
  rows: Collection['rows'];
  config: CollectRequest;
  tracker?: TrackerReport;
}

export async function createApp(options: AppOptions = {}) {
  const env = options.env ?? process.env;
  const web = webConfig(env);
  const app = Fastify({
    logger: options.logger
      ? { redact: ['req.headers.authorization', 'req.headers.cookie'] }
      : false,
    trustProxy: web.trustProxy,
    bodyLimit: 6_000_000,
  }).withTypeProvider<TypeBoxTypeProvider>();
  const store = options.store ?? new Store(),
    now = options.now ?? Date.now;
  const staged = new Map<string, Staged>();
  if (web.rateLimitEnabled)
    await app.register(rateLimit, {
      max: web.rateLimit,
      timeWindow: '1 minute',
      allowList: (request) =>
        ['GET', 'HEAD'].includes(request.method) && request.url.split('?')[0] === '/api/health',
    });
  const adminPaths = new Set([
    '/api/import',
    '/api/history/preview',
    '/api/history/confirm',
    '/api/collect',
    '/api/collect/confirm',
    '/api/markets',
    '/api/markets/archive',
  ]);
  await app.register(swagger, { openapi: { info: { title: 'TweetScope', version: '1.0.0' } } });
  app.addSchema({ $id: 'AnalyzeRequest', ...AnalyzeBody });
  app.addSchema({ $id: 'CollectRequest', ...CollectBody });
  app.addHook('onRequest', async (request, reply) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.origin;
      const expected = web.publicOrigin ?? `${request.protocol}://${request.headers.host}`;
      if (
        request.headers['sec-fetch-site'] === 'cross-site' ||
        (origin && origin.replace(/\/$/, '') !== expected)
      )
        return reply.code(403).send({ detail: 'Cross-origin requests are not allowed' });
    }
    const path = request.routeOptions.url ?? request.url.split('?')[0];
    const managed = (request.method === 'POST' && adminPaths.has(path)) || path === '/api/admin';
    if (web.writeAccess === 'admin' && managed && !web.isAdmin(request.headers.authorization))
      return reply
        .code(401)
        .header('WWW-Authenticate', 'Basic realm="TweetScope admin", charset="UTF-8"')
        .send({ detail: 'Для изменения общей истории и каталога войдите как администратор.' });
  });
  app.addHook('onSend', async (_request, reply) => {
    reply.headers({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'Cache-Control': 'no-store',
    });
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError)
      return reply.code(error.statusCode).send({ detail: error.message });
    if (error instanceof Error && 'validation' in error && error.validation)
      return reply.code(422).send({ detail: error.message });
    if (
      error instanceof Error &&
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    )
      return reply.code(error.statusCode).send({ detail: error.message });
    request.log.error(error, 'Request failed');
    return reply
      .code(500)
      .send({ detail: 'Внутренняя ошибка сервера. Проверьте журнал приложения.' });
  });
  await app.register(fastifyStatic, {
    root: resolve(options.publicDir ?? 'dist/public'),
    prefix: '/static/',
    index: false,
  });
  app.get('/', { schema: { hide: true } }, async (_r, reply) => reply.sendFile('index.html'));
  app.get('/api/docs', { schema: { hide: true } }, async (_r, reply) => reply.sendFile('api.html'));
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());
  app.get('/api/admin', { schema: { hide: true } }, async (_request, reply) => reply.redirect('/'));
  app.get('/api/health', { schema: { summary: 'Проверка процесса' } }, async () => ({
    status: 'ok',
  }));
  app.get('/api/markets', { schema: { summary: 'Каталог рынков публикаций' } }, async () =>
    listMarkets(store),
  );
  app.post(
    '/api/markets',
    {
      schema: {
        summary: 'Добавить рынок публикаций в каталог',
        body: Type.Object(
          {
            event_url: Type.String({ minLength: 1, maxLength: 500 }),
            handle: Type.String({ minLength: 1, maxLength: 16, pattern: '^@?[a-zA-Z0-9_]{1,15}$' }),
            label: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request) => {
      const handle = resolveHandle(store, request.body.event_url, request.body.handle);
      const slug = slugFrom(request.body.event_url);
      const event = await fetchEvent(slug, options.transport);
      const { report } = await fetchTrackerCounter(
        slug,
        options.transport,
        now(),
        undefined,
        handle,
      );
      const config = {
        id: slug,
        label: request.body.label?.trim() || event.title,
        handle: report.handle ?? handle,
        event_url: 'https://polymarket.com/event/' + slug,
      };
      saveMarket(store, config);
      store.snapshot(slug, { ...event, handle: config.handle });
      return listMarkets(store).find((market) => market.id === slug)!;
    },
  );
  app.post(
    '/api/markets/archive',
    {
      schema: {
        summary: 'Убрать событие из каталога, сохранив историю аккаунта',
        body: Type.Object(
          { id: Type.String({ minLength: 1, maxLength: 200 }) },
          { additionalProperties: false },
        ),
      },
    },
    async (request) => {
      archiveMarket(store, request.body.id);
      return { archived: request.body.id, markets: listMarkets(store) };
    },
  );
  app.get(
    '/api/status',
    {
      schema: {
        summary: 'Покрытие истории выбранного аккаунта и наличие ключа X',
        querystring: Type.Object({ handle: Handle }),
      },
    },
    async (request) => {
      const handle = resolveHandle(store, undefined, request.query.handle);
      const result = {
        handle,
        access: {
          can_manage_data:
            web.writeAccess === 'public' || web.isAdmin(request.headers.authorization),
          write_access: web.writeAccess,
        },
      } as Status;
      for (const dataset of ['live', 'demo', 'xtracker'] as Dataset[]) {
        const { data, sources } = store.load(dataset, handle),
          times = [...data.keys()];
        result[dataset] = {
          hours: data.size,
          posts: [...data.values()].reduce((a, b) => a + b, 0),
          sources,
          start: times.length ? iso(times[0]) : null,
          end: times.length ? iso(times.at(-1)! + HOUR) : null,
        };
      }
      result.x_api = { credentials_present: credentialsPresent(env) };
      return result;
    },
  );
  app.post(
    '/api/import',
    {
      schema: {
        summary: 'Импорт полного почасового CSV',
        body: Type.Object(
          {
            handle: Handle,
            content: Type.String({ maxLength: 5_000_000 }),
            coverage_confirmed: Confirmed,
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request) => {
      if (!request.body.coverage_confirmed)
        throw new AppError('Подтвердите полноту часов и соответствие правилам подсчёта');
      return {
        imported_hours: store.saveHours(
          readCsv(request.body.content),
          'live',
          'csv',
          now(),
          undefined,
          resolveHandle(store, undefined, request.body.handle),
        ),
      };
    },
  );
  app.get(
    '/api/export',
    {
      schema: {
        summary: 'Экспорт реальной почасовой истории',
        querystring: Type.Object({
          handle: Handle,
          dataset: Type.Union([Type.Literal('live'), Type.Literal('xtracker')], {
            default: 'live',
          }),
        }),
      },
    },
    async (request, reply) => {
      const { data } = store.load(
        request.query.dataset,
        resolveHandle(store, undefined, request.query.handle),
      );
      return reply
        .header('Content-Disposition', 'attachment; filename=tweets-hourly.csv')
        .type('text/csv; charset=utf-8')
        .send('timestamp,count\r\n' + [...data].map(([t, c]) => `${iso(t)},${c}\r\n`).join(''));
    },
  );
  app.post(
    '/api/demo',
    {
      schema: {
        summary: 'Создать изолированную синтетическую историю',
        body: Type.Object({ handle: Handle }),
      },
    },
    async (request) => {
      const handle = resolveHandle(store, undefined, request.body.handle);
      store.saveHours(demoHours(now()), 'demo', 'synthetic', now(), undefined, handle);
      return { ...demoEvent(now()), handle };
    },
  );
  app.get(
    '/api/event',
    {
      schema: {
        summary: 'Загрузить событие и стаканы',
        querystring: Type.Object({ url: Type.String({ maxLength: 500 }), handle: Handle }),
      },
    },
    async (request) => {
      const handle = resolveHandle(store, request.query.url, request.query.handle);
      const event = {
        ...(await fetchEvent(slugFrom(request.query.url), options.transport)),
        handle,
      };
      store.snapshot(event.slug, event);
      return event;
    },
  );
  for (const url of ['/api/history/preview', '/api/collect'])
    app.post(
      url,
      {
        schema: {
          summary: 'Предпросмотр сбора API X / XTracker',
          body: CollectBody,
          hide: url === '/api/collect',
        },
      },
      async (request) => {
        const config = {
          ...request.body,
          handle: resolveHandle(store, request.body.event_url, request.body.handle),
        };
        const collected =
          config.source === 'x'
            ? await collectX(config, options.transport, now(), env)
            : await collectTracker(config, options.transport, now());
        for (const [key, value] of staged)
          if (performance.now() - value.created > 1_800_000) staged.delete(key);
        if (staged.size >= 10) staged.delete(staged.keys().next().value!);
        const preview_id = randomUUID();
        staged.set(preview_id, {
          created: performance.now(),
          rows: collected.rows,
          config,
          tracker: collected.tracker,
        });
        const { rows, ...summary } = collected;
        return { ...summary, preview_id, hours: rows.length };
      },
    );
  for (const url of ['/api/history/confirm', '/api/collect/confirm'])
    app.post(
      url,
      {
        schema: {
          summary: 'Подтвердить полноту и сохранить сбор',
          hide: url === '/api/collect/confirm',
          body: Type.Object(
            { preview_id: Type.String({ maxLength: 40 }), coverage_confirmed: Confirmed },
            { additionalProperties: false },
          ),
        },
      },
      async (request) => {
        const item = staged.get(request.body.preview_id);
        if (!item || performance.now() - item.created > 1_800_000)
          throw new AppError('Предпросмотр истёк. Повторите сбор.');
        if (!request.body.coverage_confirmed)
          throw new AppError('Подтвердите полноту источника и правила');
        const config = item.config,
          source =
            config.source === 'xtracker'
              ? TRACKER_SOURCE
              : `x:${config.mode}:replies=${Number(config.include_replies)}:reposts=${Number(config.include_reposts)}`;
        const dataset = config.source === 'xtracker' ? 'xtracker' : 'live';
        const imported_hours = store.saveHours(
          item.rows,
          dataset,
          source,
          now(),
          item.tracker
            ? { key: 'tracker:import:' + item.tracker.slug, value: item.tracker }
            : undefined,
          config.handle,
        );
        staged.delete(request.body.preview_id);
        return { imported_hours, dataset, handle: config.handle };
      },
    );
  app.get(
    '/api/xtracker',
    {
      schema: {
        summary: 'Post Counter и границы трекинга XTracker',
        querystring: Type.Object({ url: Type.String({ maxLength: 500 }), handle: Handle }),
      },
    },
    async (request) => {
      const handle = resolveHandle(store, request.query.url, request.query.handle);
      const slug = slugFrom(request.query.url),
        cached = trackerReportSchema.safeParse(
          store.getMetadata('tracker:' + slug) ?? store.getMetadata('tracker:import:' + slug),
        );
      const { report } = await fetchTrackerCounter(
        slug,
        options.transport,
        now(),
        cached.success && accountKey(cached.data.handle ?? DEFAULT_HANDLE) === accountKey(handle)
          ? cached.data.tracking_id
          : undefined,
        handle,
      );
      report.as_of = iso(now());
      return report;
    },
  );
  app.post(
    '/api/analyze',
    {
      config: { rateLimit: { max: 6, timeWindow: '1 minute' } },
      schema: { summary: 'Прогноз и оценка загруженного снимка', body: AnalyzeBody },
    },
    async (request): Promise<Analysis> => {
      const body = request.body;
      const handle = resolveHandle(
        store,
        body.dataset === 'demo' ? undefined : body.event_url,
        body.handle,
      );
      const marketWindow = body.dataset === 'xtracker' && Boolean(body.event_url);
      let start = marketWindow ? 0 : localTime(body.start, body.timezone),
        end = marketWindow ? 0 : localTime(body.end, body.timezone);
      let tracker: TrackerReport | undefined;
      if (body.dataset === 'xtracker' && body.event_url) {
        const slug = slugFrom(body.event_url),
          cached = trackerReportSchema.safeParse(
            store.getMetadata('tracker:' + slug) ?? store.getMetadata('tracker:import:' + slug),
          );
        const fresh = await fetchTrackerCounter(
          slug,
          options.transport,
          now(),
          cached.success && accountKey(cached.data.handle ?? DEFAULT_HANDLE) === accountKey(handle)
            ? cached.data.tracking_id
            : undefined,
          handle,
        );
        tracker = fresh.report;
        tracker.as_of = iso(now());
        start = parseTime(tracker.start);
        end = parseTime(tracker.end);
        // Refresh explicitly supplied complete buckets, including late tracker corrections.
        if (fresh.rows.length)
          store.saveHours(
            fresh.rows,
            'xtracker',
            TRACKER_SOURCE,
            now(),
            {
              key: 'tracker:' + slug,
              value: tracker,
            },
            handle,
          );
      }
      const { data, sources } = store.load(body.dataset, handle);
      const { draws, result } = await runForecast({
        rows: [...data],
        start,
        end,
        timezone: marketWindow ? 'America/New_York' : body.timezone,
        now: now(),
        anchor: tracker ? { count: tracker.count, as_of: parseTime(tracker.as_of) } : undefined,
      });
      const analysis: Analysis = {
        ...result,
        handle,
        dataset: body.dataset,
        sources,
        start: iso(start),
        end: iso(end),
        generated_at: iso(now()),
        positions: [],
        event: null,
        ...(tracker ? { tracker } : {}),
      };
      if (tracker) {
        result.warnings.push(...tracker.warnings);
        if (!tracker.sync_ok) {
          result.fresh = false;
          analysis.fresh = false;
        }
      }
      let market: MarketEvent;
      if (body.dataset === 'demo') {
        const demo = demoEvent(now());
        if (
          start !== localTime(demo.start, demo.timezone) ||
          end !== localTime(demo.end, demo.timezone)
        ) {
          result.warnings.push(
            'Период отличается от демонстрационного рынка: показан только прогноз, без оценки позиций.',
          );
          return analysis;
        }
        market = demo;
      } else if (body.event_url) {
        const raw = store.getSnapshot(slugFrom(body.event_url));
        if (!raw) throw new AppError('Сначала загрузите рынок кнопкой «Загрузить рынок»');
        const parsed = eventSchema.safeParse(raw);
        if (!parsed.success)
          throw new AppError('Сохранённый снимок несовместим. Загрузите рынок заново.');
        market = parsed.data;
      } else return analysis;
      analysis.event = market;
      if (sources.some((s) => s.startsWith('x:')))
        result.warnings.push(
          'История API X может расходиться с Post Counter: удалённые публикации и ответы в основной ленте требуют отдельной сверки по правилам рынка.',
        );
      const trackerRequired = /xtracker|post counter/i.test(market.description);
      const trustedHistory =
        body.dataset === 'xtracker' && sources.every((source) => source === TRACKER_SOURCE);
      const rulesVerified = marketWindow
        ? Boolean(trustedHistory && tracker?.verified && tracker.sync_ok)
        : body.rules_confirmed;
      if (trackerRequired && !trustedHistory)
        result.warnings.push(
          'Этот рынок разрешается по Post Counter. Для сигналов выберите отдельную историю XTracker; API X / CSV остаются дополнительными источниками.',
        );
      analysis.positions = evaluate(
        draws,
        market,
        body.budget,
        body.expense_bps,
        body.safety_pp,
        rulesVerified &&
          result.fresh &&
          (!trackerRequired || trustedHistory) &&
          (body.dataset !== 'xtracker' || Boolean(tracker?.verified && tracker.sync_ok)),
        now(),
      );
      let hits = 0;
      for (const m of market.markets)
        for (const d of draws) if (d >= m.lower && (m.upper === null || d <= m.upper)) hits++;
      const mass = hits / draws.length;
      if (mass < 0.999)
        result.warnings.push(
          `Диапазоны рынка покрывают ${(mass * 100).toFixed(1)}% модельной вероятности. Часть исходов не загружена.`,
        );
      if (!rulesVerified)
        result.warnings.push(
          marketWindow
            ? 'Не удалось автоматически сверить источник и правила рынка. Сигналы отключены.'
            : 'Подтвердите период и правила рынка, чтобы включить сигналы.',
        );
      if (market.markets.some((m) => m.fees_enabled))
        result.warnings.push(
          'На рынке включены комиссии. Указанный резерв расходов — ваша оценка; проверьте фактическую ставку перед сделкой.',
        );
      return analysis;
    },
  );
  app.addHook('onClose', async () => {
    if (!options.store) store.close();
  });
  await app.ready();
  return app;
}
