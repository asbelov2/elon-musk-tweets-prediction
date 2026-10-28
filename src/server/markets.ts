import type { MarketConfig } from '../shared/types.js';
import { accountKey, cleanHandle, DEFAULT_HANDLE } from './accounts.js';
import { AppError } from './errors.js';
import { slugFrom } from './providers.js';
import type { Store } from './storage.js';
const CATALOG_KEY = 'markets:catalog:v1';
const ARCHIVED_KEY = 'markets:archived:v1';
export const BUILTIN_MARKETS: MarketConfig[] = [
  {
    id: 'elon-musk-of-tweets-october-13-october-20-2026',
    label: 'Илон Маск · 13–20 октября',
    handle: 'elonmusk',
    event_url: 'https://polymarket.com/event/elon-musk-of-tweets-october-13-october-20-2026',
  },
  {
    id: 'white-house-of-tweets-october-13-october-20-2026',
    label: 'Белый дом · 13–20 октября',
    handle: 'WhiteHouse',
    event_url: 'https://polymarket.com/event/white-house-of-tweets-october-13-october-20-2026',
  },
];
function catalogMarkets(store: Store): MarketConfig[] {
  const saved = store.getMetadata(CATALOG_KEY);
  if (!Array.isArray(saved)) return [...BUILTIN_MARKETS];
  const entries = [...BUILTIN_MARKETS];
  for (const item of saved as MarketConfig[]) {
    if (
      !item ||
      typeof item.event_url !== 'string' ||
      typeof item.handle !== 'string' ||
      typeof item.label !== 'string'
    )
      throw new AppError('Повреждён каталог рынков', 500);
    const id = slugFrom(item.event_url);
    if (!entries.some((entry) => entry.id === id))
      entries.push({ ...item, id, handle: cleanHandle(item.handle) });
  }
  return entries;
}
function archivedIds(store: Store): Set<string> {
  const saved = store.getMetadata(ARCHIVED_KEY);
  if (saved == null) return new Set();
  if (!Array.isArray(saved) || saved.some((id) => typeof id !== 'string'))
    throw new AppError('Повреждён список убранных событий', 500);
  return new Set(saved as string[]);
}
export function listMarkets(store: Store): MarketConfig[] {
  const archived = archivedIds(store);
  return catalogMarkets(store).filter((market) => !archived.has(market.id));
}
export function archiveMarket(store: Store, id: string): void {
  if (!catalogMarkets(store).some((market) => market.id === id))
    throw new AppError('Событие не найдено в каталоге.', 404);
  const archived = archivedIds(store);
  archived.add(id);
  store.setMetadata(ARCHIVED_KEY, [...archived]);
}
export function resolveHandle(store: Store, eventUrl?: string, requested?: string): string {
  const entries = catalogMarkets(store);
  const market = eventUrl ? entries.find((entry) => entry.id === slugFrom(eventUrl)) : undefined;
  if (market) {
    if (requested && accountKey(requested) !== accountKey(market.handle))
      throw new AppError('Аккаунт не соответствует выбранному рынку. Выберите рынок из каталога.');
    return market.handle;
  }
  if (eventUrl && !requested)
    throw new AppError('Добавьте этот рынок в каталог и укажите его аккаунт X.');
  const handle = cleanHandle(requested ?? DEFAULT_HANDLE);
  return entries.find((entry) => accountKey(entry.handle) === accountKey(handle))?.handle ?? handle;
}
export function saveMarket(store: Store, config: MarketConfig): void {
  const entries = catalogMarkets(store);
  const existing = entries.find((entry) => entry.id === config.id);
  if (existing && accountKey(existing.handle) !== accountKey(config.handle))
    throw new AppError('Это событие уже связано с другим аккаунтом.');
  const archived = archivedIds(store);
  if ((!existing || archived.has(config.id)) && listMarkets(store).length >= 100)
    throw new AppError('В каталоге уже 100 рынков.');
  if (!existing) store.setMetadata(CATALOG_KEY, [...entries, config]);
  if (archived.delete(config.id)) {
    store.setMetadata(ARCHIVED_KEY, [...archived]);
  }
}
