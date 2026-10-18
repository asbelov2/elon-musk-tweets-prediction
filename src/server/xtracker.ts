import { DateTime } from 'luxon';
import { z } from 'zod';
import type { Collection, CollectRequest, HourRow, TrackerReport } from '../shared/types.js';
import { ProviderError } from './errors.js';
import { getJson, remoteTransport, type Transport } from './http.js';
import { slugFrom } from './providers.js';
import { DAY, HOUR, hour, hoursBetween, iso, parseTime } from './time.js';

const BASE = 'https://xtracker.polymarket.com/api';
export const TRACKER_SOURCE = 'xtracker:post-counter:v1';
const uuid = z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
const userSchema = z.object({
  id: uuid,
  handle: z.literal('elonmusk'),
  platform: z.literal('X'),
  lastSync: z.string().nullable(),
  lastSyncError: z.string().nullable(),
  _count: z.object({ posts: z.number().int().nonnegative() }).optional(),
});
const trackingSchema = z.object({
  id: uuid,
  userId: uuid,
  title: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  marketLink: z.string().nullable(),
});
const detailSchema = trackingSchema.extend({
  user: userSchema,
  stats: z.object({
    total: z.number().int().nonnegative(),
    daily: z.array(
      z.object({
        date: z.string(),
        count: z.number().int().nonnegative(),
        cumulative: z.number().int().nonnegative(),
      }),
    ),
  }),
});
const postSchema = z.object({
  id: z.string().min(1),
  platformId: z.string().min(1),
  userId: uuid,
  createdAt: z.string(),
});
export const trackerReportSchema = z.object({
  tracking_id: uuid,
  slug: z.string(),
  title: z.string(),
  start: z.string(),
  end: z.string(),
  local_start: z.string(),
  local_end: z.string(),
  as_of: z.string(),
  count: z.number().int().nonnegative(),
  completed_count: z.number().int().nonnegative(),
  last_sync: z.string().nullable(),
  last_sync_error: z.string().nullable(),
  sync_ok: z.boolean(),
  verified: z.boolean(),
  warnings: z.array(z.string()),
  export_records: z.number().int().optional(),
  history_hours: z.number().int().optional(),
}) satisfies z.ZodType<TrackerReport>;

async function data<T>(path: string, schema: z.ZodType<T>, transport: Transport): Promise<T> {
  const raw = await getJson(new URL(BASE + path), transport);
  const parsed = z.object({ success: z.literal(true), data: schema }).safeParse(raw);
  if (!parsed.success)
    throw new ProviderError(
      'XTracker вернул ошибку или несовместимую структуру ' + path.split('?')[0],
    );
  return parsed.data.data;
}
function exclusiveEnd(value: string): number {
  const end = parseTime(value),
    remainder = end - hour(end);
  return remainder >= HOUR - 1000 ? hour(end) + HOUR : end;
}
function trackingSlug(value: string | null): string | null {
  try {
    return value ? slugFrom(value) : null;
  } catch {
    return null;
  }
}
export function assertTrackerPeriod(report: TrackerReport, start: number, end: number): void {
  if (parseTime(report.start) !== start || parseTime(report.end) !== end)
    throw new ProviderError(
      'Период не совпадает с окном XTracker. Загрузите границы трекинга или очистите ссылку для отдельного прогноза.',
    );
}

export async function fetchTrackerCounter(
  slug: string,
  transport: Transport = remoteTransport,
  now = Date.now(),
  trackingId?: string,
): Promise<{ report: TrackerReport; rows: HourRow[] }> {
  let id = trackingId;
  if (!id) {
    const profile = await data('/users/elonmusk?platform=X', userSchema, transport);
    const windows = await data(
      '/users/elonmusk/trackings?platform=X&activeOnly=false',
      z.array(trackingSchema),
      transport,
    );
    const matches = windows.filter(
      (w) => w.userId === profile.id && trackingSlug(w.marketLink) === slug,
    );
    if (matches.length !== 1)
      throw new ProviderError(
        'Не найдено однозначное окно XTracker для этого события. Проверьте ссылку рынка.',
      );
    id = matches[0].id;
  }
  if (!uuid.safeParse(id).success) throw new ProviderError('Некорректный ID трекинга XTracker');
  const detail = await data(`/trackings/${id}?includeStats=true`, detailSchema, transport);
  if (detail.userId !== detail.user.id || trackingSlug(detail.marketLink) !== slug)
    throw new ProviderError('XTracker вернул трекинг другого события или пользователя');
  const start = parseTime(detail.startDate),
    end = exclusiveEnd(detail.endDate),
    cutoff = Math.min(end, hour(now));
  if (start !== hour(start) || end !== hour(end) || end <= start)
    throw new ProviderError('XTracker вернул неподдерживаемые границы периода');
  const buckets = new Map<number, number>();
  let cumulative = 0;
  for (const bucket of detail.stats.daily) {
    const t = parseTime(bucket.date);
    if (t !== hour(t) || t < start || t >= end || buckets.has(t))
      throw new ProviderError(
        'В почасовой статистике XTracker нарушены границы или повторяются часы',
      );
    if (t > hour(now) && bucket.count > 0)
      throw new ProviderError('XTracker вернул будущие публикации');
    // stats.daily is hourly in the observed API. Require dense chronological buckets.
    if (t !== start + buckets.size * HOUR)
      throw new ProviderError(
        'В почасовой статистике XTracker есть пропуск или иной шаг группировки',
      );
    cumulative += bucket.count;
    if (cumulative !== bucket.cumulative)
      throw new ProviderError('Накопительный счётчик XTracker не согласуется с часами');
    buckets.set(t, bucket.count);
  }
  if (cumulative !== detail.stats.total)
    throw new ProviderError('Post Counter XTracker не совпадает с суммой почасовых значений');
  const rows: HourRow[] = [];
  for (const t of hoursBetween(start, cutoff)) {
    if (!buckets.has(t)) throw new ProviderError('XTracker не вернул все завершённые часы периода');
    rows.push([t, buckets.get(t)!]);
  }
  if (now >= start && now < end && !buckets.has(hour(now)))
    throw new ProviderError('XTracker не вернул текущий час: свежесть счётчика не подтверждена');
  const lastSync = detail.user.lastSync ? parseTime(detail.user.lastSync) : null,
    lastError = detail.user.lastSyncError ? parseTime(detail.user.lastSyncError) : null;
  const syncOk =
    lastSync !== null &&
    now - lastSync <= 3 * HOUR &&
    lastSync <= now + 60_000 &&
    (lastError === null || lastError < lastSync);
  const warnings: string[] = [];
  if (!syncOk)
    warnings.push(
      'XTracker сообщает об ошибке синхронизации или последняя успешная синхронизация старше 3 часов. Счётчик показан, сигналы покупки отключены.',
    );
  const local = (time: number) =>
    DateTime.fromMillis(time, { zone: 'America/New_York' }).toFormat("yyyy-MM-dd'T'HH:mm");
  return {
    rows,
    report: {
      tracking_id: detail.id,
      slug,
      title: detail.title,
      start: iso(start),
      end: iso(end),
      local_start: local(start),
      local_end: local(end),
      as_of: iso(now),
      count: detail.stats.total,
      completed_count: rows.reduce((sum, [, c]) => sum + c, 0),
      last_sync: detail.user.lastSync,
      last_sync_error: detail.user.lastSyncError,
      sync_ok: syncOk,
      verified: true,
      warnings,
    },
  };
}

/** This is exactly the source used by XTracker's Export Data button, not raw X.
 * Verify full export against _count.posts; never invent publication types.
 */
export async function collectTracker(
  options: Pick<CollectRequest, 'days' | 'event_url'>,
  transport: Transport = remoteTransport,
  now = Date.now(),
): Promise<Collection> {
  if (!options.event_url)
    throw new ProviderError('Для сбора XTracker укажите ссылку на событие Polymarket');
  const slug = slugFrom(options.event_url);
  const profile = await data('/users/elonmusk?platform=X', userSchema, transport);
  if (!profile._count || profile._count.posts > 100_000)
    throw new ProviderError(
      'XTracker не подтвердил размер полного экспорта или он превышает 100000 публикаций',
    );
  const windows = await data(
    '/users/elonmusk/trackings?platform=X&activeOnly=false',
    z.array(trackingSchema),
    transport,
  );
  const own = windows.filter((w) => w.userId === profile.id),
    matches = own.filter((w) => trackingSlug(w.marketLink) === slug);
  if (matches.length !== 1)
    throw new ProviderError('Не найдено однозначное окно XTracker для события');
  const posts = await data('/users/elonmusk/posts?platform=X', z.array(postSchema), transport);
  const unique = new Map<string, number>();
  for (const post of posts) {
    if (post.userId !== profile.id)
      throw new ProviderError('Экспорт XTracker содержит публикации другого пользователя');
    const t = parseTime(post.createdAt);
    if (unique.has(post.platformId) && unique.get(post.platformId) !== t)
      throw new ProviderError('Один ID XTracker имеет разные даты публикации');
    unique.set(post.platformId, t);
  }
  if (unique.size !== profile._count.posts) {
    const after = await data('/users/elonmusk?platform=X', userSchema, transport);
    if (unique.size !== after._count?.posts)
      throw new ProviderError(
        'Экспорт XTracker усечён или изменился во время загрузки: число уникальных ID не совпадает с _count.posts. Повторите сбор.',
      );
  }
  const { report, rows: counterRows } = await fetchTrackerCounter(
    slug,
    transport,
    now,
    matches[0].id,
  );
  const covered = own.map((w) => [parseTime(w.startDate), exclusiveEnd(w.endDate)] as const);
  const end = hour(now),
    start = end - options.days * DAY;
  const counts = new Map<number, number>();
  for (const t of hoursBetween(start, end))
    if (covered.some(([a, b]) => a <= t && t + HOUR <= b)) counts.set(t, 0);
  const periodStart = parseTime(report.start),
    periodEnd = parseTime(report.end),
    periodCounts = new Map<number, number>();
  let marketTotal = 0,
    retained = 0;
  for (const t of unique.values()) {
    if (t >= periodStart && t < periodEnd && t <= now) {
      marketTotal++;
      periodCounts.set(hour(t), (periodCounts.get(hour(t)) ?? 0) + 1);
    }
    if (t >= start && t < end && counts.has(hour(t))) {
      counts.set(hour(t), counts.get(hour(t))! + 1);
      retained++;
    }
  }
  if (
    marketTotal !== report.count ||
    counterRows.some(([t, c]) => (periodCounts.get(t) ?? 0) !== c)
  )
    throw new ProviderError(
      'Экспорт публикаций расходится с Post Counter или его почасовой статистикой. История не сохранена; повторите сбор после обновления трекера.',
    );
  if (counts.size < 14 * 24 || !retained)
    throw new ProviderError(
      'В XTracker недостаточно покрытой истории для обучения (нужно минимум 14 полных дней)',
    );
  report.export_records = unique.size;
  report.history_hours = counts.size;
  const gaps = options.days * 24 - counts.size;
  return {
    rows: [...counts],
    posts: retained,
    start: iso(start),
    end: iso(end),
    tracker: report,
    notice: `Источник — Export Data XTracker: ${unique.size} уникальных публикаций сверено с _count.posts; Post Counter = ${report.count}. Ответы основной ленты, репосты и сохранённые трекером удаления не фильтруются повторно.${gaps ? ` ${gaps} часов без покрытия трекингами не импортированы и не считаются нулями.` : ''} ${report.warnings.join(' ')}`,
  };
}
