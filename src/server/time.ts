import { DateTime, IANAZone } from 'luxon';
import { AppError } from './errors.js';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const hour = (time: number): number => Math.floor(time / HOUR) * HOUR;
export const iso = (time: number): string => new Date(time).toISOString();

export function parseTime(value: string): number {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value))
    throw new AppError('Время должно содержать часовой пояс: Z или +03:00');
  const date = DateTime.fromISO(value, { setZone: true });
  if (!date.isValid) throw new AppError('Некорректная временная метка ISO 8601');
  return date.toMillis();
}

export function localTime(value: string, zone: string): number {
  if (zone !== 'UTC' && !IANAZone.isValidZone(zone))
    throw new AppError('Неизвестный часовой пояс IANA');
  if (/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return parseTime(value);
  const wall = DateTime.fromISO(value, { zone: 'UTC' });
  if (!wall.isValid) throw new AppError('Некорректное локальное время');
  const local = DateTime.fromObject(wall.toObject(), { zone });
  if (
    !local.isValid ||
    local.toFormat("yyyy-MM-dd'T'HH:mm:ss.SSS") !== wall.toFormat("yyyy-MM-dd'T'HH:mm:ss.SSS")
  ) {
    throw new AppError('Такого локального времени нет из-за перевода часов');
  }
  if (local.getPossibleOffsets().length > 1)
    throw new AppError(
      'Неоднозначное время при переводе часов: задайте ISO-время с UTC-смещением через API',
    );
  return local.toMillis();
}

export interface LocalParts {
  day: string;
  hour: number;
  weekday: number;
}
const cached = new Map<string, LocalParts>();
export function localParts(time: number, zone: string): LocalParts {
  const key = `${zone}:${time}`;
  const found = cached.get(key);
  if (found) return found;
  const dt = DateTime.fromMillis(time, { zone });
  if (!dt.isValid) throw new AppError('Неизвестный часовой пояс IANA');
  const result = { day: dt.toISODate()!, hour: dt.hour, weekday: dt.weekday - 1 };
  if (cached.size >= 20_000) cached.clear();
  cached.set(key, result);
  return result;
}

export function* hoursBetween(start: number, end: number): Generator<number> {
  for (let time = start; time < end; time += HOUR) yield time;
}
