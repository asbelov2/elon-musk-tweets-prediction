import { z } from 'zod';
import type { Collection, CollectRequest, Market, MarketEvent, Side } from '../shared/types.js';
import { AppError, errorMessage, ProviderError } from './errors.js';
import { endpoint, getJson, record, remoteTransport, text, type Transport } from './http.js';
import { DAY, HOUR, hour, iso, parseTime } from './time.js';

const levelSchema = z.object({
  price: z.number().finite().gt(0).lt(1),
  size: z.number().finite().positive(),
});
const bookSchema = z.object({
  asks: z.array(levelSchema),
  fetched_at: z.string().optional(),
  error: z.string().optional(),
});
export const eventSchema = z.object({
  slug: z.string(),
  title: z.string(),
  description: z.string(),
  resolution_source: z.string(),
  markets: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      lower: z.number().int().nonnegative(),
      upper: z.number().int().nonnegative().nullable(),
      tokens: z.object({ yes: z.string().optional(), no: z.string().optional() }),
      active: z.boolean(),
      fees_enabled: z.boolean(),
      books: z.object({ yes: bookSchema.optional(), no: bookSchema.optional() }),
      question: z.string().optional(),
    }),
  ),
  excluded: z.array(z.string()),
  fetched_at: z.string(),
  demo: z.boolean(),
  start: z.string().optional(),
  end: z.string().optional(),
  timezone: z.string().optional(),
}) satisfies z.ZodType<MarketEvent>;

export function slugFrom(value: string): string {
  value = value.trim();
  if (value.startsWith('https://')) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new AppError('Некорректная ссылка события');
    }
    if (
      !['polymarket.com', 'www.polymarket.com'].includes(parsed.hostname) ||
      parsed.username ||
      parsed.password
    )
      throw new AppError('Ожидается ссылка polymarket.com/event/…');
    const parts = parsed.pathname.split('/').filter(Boolean),
      index = parts.indexOf('event');
    if (index < 0 || !parts[index + 1]) throw new AppError('В ссылке нет slug события');
    value = parts[index + 1];
  }
  if (!/^[a-z0-9][a-z0-9-]{0,220}$/.test(value)) throw new AppError('Некорректный slug события');
  return value;
}

export function bounds(label: string): [number, number | null] {
  const s = label
    .toLowerCase()
    .trim()
    .replaceAll(',', '')
    .replace(/[–—]/g, '-')
    .replace(/\s+(tweets|posts)$/, '');
  let match = s.match(/^(\d+)\s*-\s*(\d+)$/);
  if (match && Number(match[1]) <= Number(match[2])) return [Number(match[1]), Number(match[2])];
  match = s.match(/^(?:<\s*|less than\s+|under\s+|below\s+)(\d+)$/);
  if (match && Number(match[1]) > 0) return [0, Number(match[1]) - 1];
  match = s.match(/^(\d+)\s*(?:\+|or\s+(?:more|above))$/) ?? s.match(/^>=\s*(\d+)$/);
  if (match) return [Number(match[1]), null];
  match = s.match(/^>\s*(\d+)$/);
  if (match) return [Number(match[1]) + 1, null];
  throw new AppError('Не распознан диапазон количества: ' + label);
}
const asArray = (value: unknown): unknown =>
  typeof value === 'string' ? (JSON.parse(value) as unknown) : value;

export function normalizeEvent(raw: unknown, now = Date.now()): MarketEvent {
  if (!record(raw) || !Array.isArray(raw.markets) || typeof raw.slug !== 'string')
    throw new ProviderError('Gamma API вернул неизвестную структуру события');
  const markets: Market[] = [],
    excluded: string[] = [],
    descriptions = new Set<string>();
  let resolution = text(raw.resolutionSource);
  for (const item of raw.markets) {
    if (!record(item)) throw new ProviderError('Gamma API вернул неизвестную структуру рынка');
    if (typeof item.description === 'string' && item.description)
      descriptions.add(item.description);
    resolution ||= text(item.resolutionSource);
    const label = text(item.groupItemTitle);
    try {
      const [lower, upper] = bounds(label),
        outcomes = asArray(item.outcomes),
        tokens = asArray(item.clobTokenIds);
      if (
        !Array.isArray(outcomes) ||
        !Array.isArray(tokens) ||
        outcomes.length !== 2 ||
        tokens.length !== 2 ||
        new Set(outcomes.map((x) => String(x).toLowerCase())).size !== 2 ||
        !outcomes.every((x) => ['yes', 'no'].includes(String(x).toLowerCase()))
      )
        throw new AppError('Отсутствуют бинарные YES/NO токены');
      const tokenMap: Market['tokens'] = {};
      outcomes.forEach((outcome, i) => {
        if (!tokens[i]) throw new AppError('Пустой ID токена');
        tokenMap[String(outcome).toLowerCase() as Side] = String(tokens[i]);
      });
      markets.push({
        id: String(item.id ?? ''),
        label,
        lower,
        upper,
        tokens: tokenMap,
        active: item.active === true && item.closed !== true && item.acceptingOrders === true,
        fees_enabled: item.feesEnabled === true,
        books: {},
        question: text(item.question),
      });
    } catch (error) {
      excluded.push(`${label || text(item.question) || '?'}: ${errorMessage(error)}`);
    }
  }
  if (!markets.length)
    throw new ProviderError(
      'В событии не найдены распознаваемые диапазоны твитов с YES/NO токенами',
    );
  markets.sort((a, b) => a.lower - b.lower);
  for (let i = 1; i < markets.length; i++)
    if (markets[i - 1].upper === null || markets[i - 1].upper! >= markets[i].lower)
      throw new ProviderError('Диапазоны рынка пересекаются — проверьте структуру события');
  return {
    slug: raw.slug,
    title: text(raw.title),
    description: text(raw.description) || [...descriptions].join('\n\n'),
    resolution_source: resolution,
    markets,
    excluded,
    fetched_at: iso(now),
    demo: false,
  };
}

export async function fetchEvent(
  slug: string,
  transport: Transport = remoteTransport,
): Promise<MarketEvent> {
  const raw = await getJson(
    endpoint('https://gamma-api.polymarket.com/events', { slug }),
    transport,
  );
  if (!Array.isArray(raw) || !raw.length)
    throw new ProviderError(
      'Событие не найдено. Проверьте ссылку; рынок может ещё не существовать.',
    );
  const exact = raw.find((e) => record(e) && e.slug === slug);
  if (!exact) throw new ProviderError('API вернул другое событие');
  const event = normalizeEvent(exact);
  const tasks = event.markets.flatMap((m) =>
    (['yes', 'no'] as Side[]).map((side) => async () => {
      if (!m.active) {
        m.books[side] = { asks: [], error: 'Рынок не принимает заявки' };
        return;
      }
      try {
        const rawBook = await getJson(
          endpoint('https://clob.polymarket.com/book', { token_id: m.tokens[side]! }),
          transport,
        );
        if (!record(rawBook) || !Array.isArray(rawBook.asks))
          throw new ProviderError('Неизвестная структура стакана CLOB');
        const asks = rawBook.asks
          .flatMap((level) => {
            if (!record(level)) throw new ProviderError('Неизвестная структура уровня стакана');
            const price = Number(level.price),
              size = Number(level.size);
            return Number.isFinite(price) &&
              Number.isFinite(size) &&
              price > 0 &&
              price < 1 &&
              size > 0
              ? [{ price, size }]
              : [];
          })
          .sort((a, b) => a.price - b.price);
        m.books[side] = { asks, fetched_at: iso(Date.now()) };
      } catch (error) {
        m.books[side] = { asks: [], error: errorMessage(error) };
      }
    }),
  );
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(6, tasks.length) }, async () => {
      while (cursor < tasks.length) await tasks[cursor++]();
    }),
  );
  event.fetched_at = iso(Date.now());
  return event;
}

function postKind(post: Record<string, unknown>): string {
  let kind = text(post.type ?? post.postType).toLowerCase();
  const aliases: Record<string, string> = {
    tweet: 'post',
    original: 'post',
    retweet: 'repost',
    quote_tweet: 'quote',
    'quote-tweet': 'quote',
  };
  kind = aliases[kind] ?? kind;
  if (!['post', 'reply', 'repost', 'quote'].includes(kind))
    throw new ProviderError(
      'XTracker не указал распознаваемый тип публикации. Используйте сверенный CSV.',
    );
  return kind;
}

export async function collectPosts(
  options: Pick<CollectRequest, 'days' | 'include_replies' | 'include_reposts'>,
  transport: Transport = remoteTransport,
  now = Date.now(),
): Promise<Collection> {
  const end = hour(now),
    start = end - options.days * DAY,
    posts = new Map<string, Record<string, unknown>>();
  let cursor: string | undefined,
    finished = false;
  for (let page = 1; page <= 100; page++) {
    const params: Record<string, string | number> = {
      startDate: iso(start),
      endDate: iso(end),
      limit: 200,
      page,
    };
    if (cursor) params.cursor = cursor;
    const raw = await getJson(
      endpoint('https://xtracker.polymarket.com/api/users/elonmusk/posts', params),
      transport,
    );
    const body = record(raw) ? (raw.data ?? raw) : raw,
      rows = record(body) ? body.posts : body;
    if (!Array.isArray(rows))
      throw new ProviderError('Неизвестный формат XTracker. Используйте импорт CSV.');
    if (rows.length && rows.every((p) => record(p) && !p.type && !p.postType))
      throw new ProviderError(
        'Текущий API XTracker не передаёт типы публикаций. Используйте API X или CSV, сверенный с Post Counter.',
      );
    let added = 0;
    for (const row of rows) {
      if (!record(row)) throw new ProviderError('Неверная запись XTracker');
      const pid = text(row.id) || text(row.platformId);
      if (!pid) throw new ProviderError('Нет ID публикации: невозможно убрать дубликаты');
      if (!posts.has(pid)) {
        added++;
        posts.set(pid, row);
      }
    }
    const meta =
      (record(body) ? body.pagination : undefined) ??
      (record(raw) ? raw.pagination : undefined) ??
      {};
    if (!record(meta)) throw new ProviderError('Неизвестная структура пагинации XTracker');
    if (
      !rows.length ||
      meta.hasMore === false ||
      (typeof meta.totalPages === 'number' && page >= meta.totalPages)
    ) {
      finished = true;
      break;
    }
    if (!added)
      throw new ProviderError('Источник повторяет страницы: полнота истории не подтверждена');
    if (meta.nextCursor) {
      if (typeof meta.nextCursor !== 'string' || meta.nextCursor === cursor)
        throw new ProviderError('XTracker повторяет курсор или вернул неверную пагинацию');
      cursor = meta.nextCursor;
    }
  }
  if (!finished)
    throw new ProviderError('Достигнут предел страниц XTracker: результат не импортирован');
  const counts = new Map<number, number>(
    Array.from({ length: options.days * 24 }, (_, i) => [start + i * HOUR, 0]),
  );
  let retained = 0;
  for (const post of posts.values()) {
    const dt = parseTime(text(post.createdAt ?? post.created_at)),
      kind = postKind(post);
    if (
      (kind === 'reply' && !options.include_replies) ||
      (kind === 'repost' && !options.include_reposts)
    )
      continue;
    if (dt >= start && dt < end) {
      const t = hour(dt);
      counts.set(t, counts.get(t)! + 1);
      retained++;
    }
  }
  if (!retained)
    throw new ProviderError('Источник вернул пустую историю; нулевое покрытие не сохранено');
  return {
    rows: [...counts],
    posts: retained,
    start: iso(start),
    end: iso(end),
    notice:
      'Проверьте полноту всего интервала и соответствие типов публикаций правилам рынка. API XTracker не гарантирует полноту истории.',
  };
}
