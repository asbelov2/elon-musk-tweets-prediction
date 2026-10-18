import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import type { Dataset, HourData, HourRow, MarketEvent } from '../shared/types.js';
import { AppError } from './errors.js';
import { hour, iso, parseTime } from './time.js';

/** Keep legacy UTC keys identical so existing databases need no destructive migration. */
const databaseTime = (time: number) => iso(time).replace('.000Z', '+00:00');
const csvRows = z.array(z.record(z.string(), z.string()));

export class Store {
  readonly db: DatabaseSync;
  constructor(path = process.env.TWEET_DB ?? 'data/tweets.sqlite3') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=20000;
      CREATE TABLE IF NOT EXISTS hours (dataset TEXT,ts TEXT,count INTEGER NOT NULL CHECK(count>=0),source TEXT NOT NULL,PRIMARY KEY(dataset,ts));
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots (slug TEXT PRIMARY KEY,payload TEXT NOT NULL,fetched_at TEXT NOT NULL);`);
  }
  close(): void {
    this.db.close();
  }
  saveHours(
    rows: HourRow[],
    dataset: Dataset = 'live',
    source = 'csv',
    now = Date.now(),
    metadata?: { key: string; value: unknown },
  ): number {
    const seen = new Set<number>(),
      cutoff = hour(now);
    for (const [time, count] of rows) {
      if (!Number.isFinite(time) || time !== hour(time) || time >= cutoff)
        throw new AppError('Допустимы только завершённые часы с началом HH:00:00 UTC');
      if (!Number.isInteger(count) || count < 0 || count > 10_000)
        throw new AppError('count должен быть целым числом от 0 до 10000');
      if (seen.has(time)) throw new AppError('В файле повторяется час: ' + iso(time));
      seen.add(time);
    }
    if (!rows.length) throw new AppError('Нет завершённых часов для импорта');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const insert = this.db.prepare(
        'INSERT INTO hours VALUES (?,?,?,?) ON CONFLICT(dataset,ts) DO UPDATE SET count=excluded.count,source=excluded.source',
      );
      for (const [time, count] of rows) insert.run(dataset, databaseTime(time), count, source);
      this.db
        .prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)')
        .run(dataset + ':updated', iso(now));
      if (metadata)
        this.db
          .prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)')
          .run(metadata.key, JSON.stringify(metadata.value));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return rows.length;
  }
  load(dataset: Dataset = 'live'): { data: HourData; sources: string[] } {
    const data: HourData = new Map(),
      sources = new Set<string>();
    for (const row of this.db
      .prepare('SELECT ts,count,source FROM hours WHERE dataset=? ORDER BY ts')
      .all(dataset)) {
      if (
        typeof row.ts !== 'string' ||
        typeof row.count !== 'number' ||
        typeof row.source !== 'string'
      )
        throw new AppError('Повреждена запись базы данных', 500);
      const time = parseTime(row.ts);
      if (data.has(time))
        throw new AppError(
          'В базе повторяется час с разными форматами времени. Требуется проверка данных.',
          500,
        );
      data.set(time, row.count);
      sources.add(row.source);
    }
    return { data: new Map([...data].sort(([a], [b]) => a - b)), sources: [...sources] };
  }
  snapshot(slug: string, event: MarketEvent): void {
    this.db
      .prepare('INSERT OR REPLACE INTO snapshots VALUES (?,?,?)')
      .run(slug, JSON.stringify(event), iso(Date.now()));
  }
  getSnapshot(slug: string): unknown {
    const row = this.db.prepare('SELECT payload FROM snapshots WHERE slug=?').get(slug);
    return row && typeof row.payload === 'string' ? (JSON.parse(row.payload) as unknown) : null;
  }
  getMetadata(key: string): unknown {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key);
    return row && typeof row.value === 'string' ? (JSON.parse(row.value) as unknown) : null;
  }
}

export function readCsv(content: string): HourRow[] {
  let rows: Record<string, string>[];
  try {
    rows = csvRows.parse(
      parse(content, { columns: true, bom: true, skip_empty_lines: true, trim: true }) as unknown,
    );
  } catch {
    throw new AppError(
      'Некорректный CSV: нужны столбцы timestamp,count и одинаковое число полей в строках.',
    );
  }
  if (!rows.length || !('timestamp' in rows[0]) || !('count' in rows[0]))
    throw new AppError(
      'Нужны столбцы timestamp,count. Каждая строка — полный час, включая нулевые часы.',
    );
  return rows.map((row, i) => {
    try {
      if (!/^\d+$/.test(row.count))
        throw new AppError('count должен быть целым неотрицательным числом');
      return [parseTime(row.timestamp), Number(row.count)];
    } catch (error) {
      throw new AppError(
        `Некорректная строка CSV ${i + 2}: ${error instanceof Error ? error.message : 'ошибка данных'}`,
      );
    }
  });
}
