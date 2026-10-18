import { z } from 'zod';
import type { Collection, CollectRequest } from '../shared/types.js';
import { ProviderError } from './errors.js';
import { endpoint, record, remoteTransport, type RemoteResponse, type Transport } from './http.js';
import { DAY, HOUR, hour, iso, parseTime } from './time.js';

export type Credentials = Readonly<Record<string, string | undefined>>;
export const credentialsPresent = (env: Credentials = process.env): boolean =>
  Boolean(env.X_BEARER_TOKEN || env.TWITTER_BEARER_TOKEN);

async function xGet(
  path: string,
  params: Record<string, string | number>,
  transport: Transport,
  token: string,
): Promise<Record<string, unknown>> {
  let response: RemoteResponse;
  try {
    response = await transport(endpoint('https://api.x.com' + path, params), {
      Authorization: 'Bearer ' + token,
    });
  } catch {
    throw new ProviderError('API X недоступен. Проверьте сетевой доступ к api.x.com.');
  }
  if (response.status === 401)
    throw new ProviderError(
      'API X отклонил авторизацию. Проверьте Bearer Token в защищённых настройках среды.',
    );
  if ([402, 403].includes(response.status))
    throw new ProviderError(
      'Тариф или разрешения API X не позволяют этот запрос. Проверьте доступ к архиву; для ограниченного тарифа выберите ленту пользователя.',
    );
  if (response.status === 429)
    throw new ProviderError(
      'Лимит API X исчерпан. Дождитесь сброса лимита и повторите сбор; неполная история не импортирована.',
    );
  if (response.status < 200 || response.status >= 300)
    throw new ProviderError(
      `API X вернул HTTP ${response.status}. Проверьте параметры и разрешения.`,
    );
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ProviderError('API X вернул неверный JSON');
  }
  if (
    !record(payload) ||
    (payload.errors !== undefined && (!Array.isArray(payload.errors) || payload.errors.length > 0))
  )
    throw new ProviderError(
      'API X сообщил об ошибке или частичном результате; история не импортирована.',
    );
  return payload;
}

const pageSchema = z.object({
  data: z
    .array(
      z.object({
        id: z.string().min(1),
        created_at: z.string(),
        referenced_tweets: z
          .array(z.object({ type: z.string(), id: z.string().optional() }))
          .default([]),
      }),
    )
    .default([]),
  meta: z.object({ next_token: z.string().optional() }).default({}),
});
export async function collectX(
  options: Pick<CollectRequest, 'days' | 'include_replies' | 'include_reposts' | 'mode'>,
  transport: Transport = remoteTransport,
  now = Date.now(),
  env: Credentials = process.env,
): Promise<Collection> {
  const token = env.X_BEARER_TOKEN || env.TWITTER_BEARER_TOKEN;
  if (!token)
    throw new ProviderError(
      'Не настроен X_BEARER_TOKEN. Добавьте Bearer Token в секреты среды, затем повторите сбор. Не отправляйте ключ в чат.',
    );
  const end = hour(now),
    start = end - options.days * DAY;
  let path: string, params: Record<string, string | number>;
  const apiTime = (t: number) => iso(t).replace('.000Z', 'Z');
  if (options.mode === 'timeline') {
    const user = await xGet('/2/users/by/username/elonmusk', {}, transport, token);
    const uid = record(user.data) ? user.data.id : undefined;
    if (typeof uid !== 'string' || !/^\d+$/.test(uid))
      throw new ProviderError('API X не вернул ID пользователя elonmusk');
    path = `/2/users/${uid}/tweets`;
    // No start_time: require an older boundary post to detect the timeline cap.
    params = {
      end_time: apiTime(end),
      max_results: 100,
      'tweet.fields': 'created_at,referenced_tweets',
    };
  } else {
    path = '/2/tweets/search/all';
    params = {
      query: 'from:elonmusk',
      start_time: apiTime(start),
      end_time: apiTime(end),
      max_results: 500,
      'tweet.fields': 'created_at,referenced_tweets',
    };
  }
  const counts = new Map<number, number>(
    Array.from({ length: options.days * 24 }, (_, i) => [start + i * HOUR, 0]),
  );
  const seen = new Set<string>(),
    cursors = new Set<string>();
  let retained = 0,
    reachedStart = false,
    finished = false;
  for (let page = 0; page < 100; page++) {
    const payload = await xGet(path, params, transport, token),
      parsed = pageSchema.safeParse(payload);
    if (!parsed.success) throw new ProviderError('Неподдерживаемая структура ответа API X');
    let added = 0;
    for (const post of parsed.data.data) {
      if (seen.has(post.id)) continue;
      seen.add(post.id);
      added++;
      const dt = parseTime(post.created_at),
        kinds = new Set(post.referenced_tweets.map((r) => r.type));
      reachedStart ||= dt <= start;
      if (
        (kinds.has('replied_to') && !options.include_replies) ||
        (kinds.has('retweeted') && !options.include_reposts)
      )
        continue;
      if (dt >= start && dt < end) {
        const t = hour(dt);
        counts.set(t, counts.get(t)! + 1);
        retained++;
      }
    }
    const cursor = parsed.data.meta.next_token;
    if (options.mode === 'timeline' && reachedStart) {
      finished = true;
      break;
    }
    if (!cursor) {
      if (options.mode === 'timeline')
        throw new ProviderError(
          'Лента X закончилась до начала запрошенного периода (лимит последних публикаций). Нужен полный архив, более короткий период или подтверждённая история CSV. Нулевые часы не сохранены.',
        );
      finished = true;
      break;
    }
    if (cursors.has(cursor) || !added)
      throw new ProviderError('API X повторяет страницы или вернул неверную пагинацию');
    cursors.add(cursor);
    params[options.mode === 'timeline' ? 'pagination_token' : 'next_token'] = cursor;
  }
  if (!finished)
    throw new ProviderError('Превышен предел 100 страниц API X. История не импортирована.');
  if (!retained)
    throw new ProviderError(
      'API X вернул пустую историю. Проверьте доступ и период; нулевые часы не сохранены.',
    );
  return {
    rows: [...counts],
    posts: retained,
    start: iso(start),
    end: iso(end),
    notice: `Источник: официальный API X (${options.mode}). Проверьте типы публикаций по правилам рынка. Удалённые публикации могут отсутствовать в API и учитываться источником разрешения иначе.`,
  };
}
