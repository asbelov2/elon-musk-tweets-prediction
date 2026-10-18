import { z } from 'zod';
import type { Market, MarketEvent, Side } from '../shared/types.js';
import { AppError, errorMessage, ProviderError } from './errors.js';
import { endpoint, getJson, record, remoteTransport, text, type Transport } from './http.js';
import { iso } from './time.js';

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
