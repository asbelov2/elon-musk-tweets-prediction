import { EnvHttpProxyAgent, fetch } from 'undici';
import { ProviderError } from './errors.js';

export interface RemoteResponse {
  status: number;
  json(): Promise<unknown>;
}
export type Transport = (url: URL, headers?: Record<string, string>) => Promise<RemoteResponse>;
const agent = new EnvHttpProxyAgent();
const hosts = new Set([
  'gamma-api.polymarket.com',
  'clob.polymarket.com',
  'xtracker.polymarket.com',
  'api.x.com',
]);
export const remoteTransport: Transport = async (url, headers) => {
  if (url.protocol !== 'https:' || !hosts.has(url.hostname))
    throw new ProviderError('Недопустимый адрес источника');
  if (headers?.Authorization && url.hostname !== 'api.x.com')
    throw new ProviderError('Неверный адрес назначения авторизации');
  return fetch(url, {
    dispatcher: agent,
    headers: { 'User-Agent': 'TweetScope/1.0', ...headers },
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
};
export async function closeRemoteTransport(): Promise<void> {
  await agent.close();
}
export const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
export const text = (v: unknown): string => (typeof v === 'string' ? v : '');
export function endpoint(base: string, params: Record<string, string | number> = {}): URL {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url;
}
export async function getJson(url: URL, transport: Transport = remoteTransport): Promise<unknown> {
  let response: RemoteResponse;
  try {
    response = await transport(url);
  } catch {
    throw new ProviderError(
      `Источник ${url.hostname} недоступен. Проверьте сетевой доступ к домену.`,
    );
  }
  if (response.status < 200 || response.status >= 300)
    throw new ProviderError(
      `Источник ${url.hostname} вернул HTTP ${response.status}. Запрошенный ресурс может отсутствовать или быть недоступен.`,
    );
  try {
    return await response.json();
  } catch {
    throw new ProviderError(`Источник ${url.hostname} вернул неверный JSON.`);
  }
}
