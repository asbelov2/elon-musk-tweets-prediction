import { DateTime } from 'luxon';
import type { Backtest, ForecastOutput, HourData, HourRow } from '../shared/types.js';
import { AppError } from './errors.js';
import { Random } from './random.js';
import { DAY, HOUR, hour, hoursBetween, iso, localParts } from './time.js';

interface CompleteDay {
  day: string;
  rows: HourRow[];
}
export interface Fitted {
  rates: number[][];
  shape: number;
  mean: number;
  variance: number;
  effective_days: number;
  days: CompleteDay[];
  uncertainty_shape: number;
}
const sum = (a: readonly number[]) => a.reduce((acc, n) => acc + n, 0);
export const mean = (a: ArrayLike<number>): number => {
  let total = 0;
  for (let i = 0; i < a.length; i++) total += a[i];
  return total / a.length;
};
const round = (n: number, places = 1) => Math.round(n * 10 ** places) / 10 ** places;
export function quantile(sorted: ArrayLike<number>, p: number): number {
  const pos = (sorted.length - 1) * p,
    left = Math.floor(pos);
  return (
    sorted[left] + (sorted[Math.min(left + 1, sorted.length - 1)] - sorted[left]) * (pos - left)
  );
}

export function completeDays(data: HourData, cutoff: number, zone: string): CompleteDay[] {
  const groups = new Map<string, HourRow[]>();
  for (const [time, count] of data) {
    if (time + HOUR > cutoff) continue;
    const { day } = localParts(time, zone);
    const rows = groups.get(day) ?? [];
    rows.push([time, count]);
    groups.set(day, rows);
  }
  const result: CompleteDay[] = [];
  for (const [day, rows] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const start = DateTime.fromISO(day, { zone }).startOf('day'),
      end = start.plus({ days: 1 });
    if (end.toMillis() <= cutoff && rows.length === (end.toMillis() - start.toMillis()) / HOUR)
      result.push({ day, rows });
  }
  return result.slice(-120);
}

export function fit(data: HourData, cutoff: number, zone: string): Fitted {
  const days = completeDays(data, cutoff, zone);
  if (days.length < 14)
    throw new AppError(
      `Нужно не менее 14 полностью покрытых дней истории; найдено ${days.length}. Пропуски не считаются нулями.`,
    );
  const last = DateTime.fromISO(days.at(-1)!.day, { zone: 'UTC' }).toMillis();
  const weights = days.map(
    (d) => 2 ** (-(last - DateTime.fromISO(d.day, { zone: 'UTC' }).toMillis()) / DAY / 21),
  );
  const totals = days.map((d) => sum(d.rows.map(([, c]) => c)));
  const weightSum = sum(weights),
    mu = sum(totals.map((n, i) => n * weights[i])) / weightSum;
  if (mu <= 0)
    throw new AppError('История состоит из нулей: модель активности не может быть оценена');
  const effective = weightSum ** 2 / sum(weights.map((w) => w * w));
  const variance =
    ((sum(totals.map((n, i) => (n - mu) ** 2 * weights[i])) / weightSum) * effective) /
    Math.max(1, effective - 1);
  const shape = Math.max(0.5, Math.min(1e6, mu ** 2 / Math.max(variance - mu, 1e-6)));
  const globalCounts = Array<number>(24).fill(0),
    globalExposure = Array<number>(24).fill(0);
  const counts = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  const exposure = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  days.forEach((day, i) => {
    for (const [t, c] of day.rows) {
      const local = localParts(t, zone),
        w = weights[i];
      globalCounts[local.hour] += w * c;
      globalExposure[local.hour] += w;
      counts[local.weekday][local.hour] += w * c;
      exposure[local.weekday][local.hour] += w;
    }
  });
  const base = globalCounts.map((c, h) => (c + mu / 24) / (globalExposure[h] + 1));
  const rates = counts.map((day, wd) =>
    day.map((c, h) => (c + 7 * base[h]) / (exposure[wd][h] + 7)),
  );
  return {
    rates,
    shape,
    mean: mu,
    variance,
    effective_days: effective,
    days,
    uncertainty_shape: Math.max(2, effective * shape),
  };
}

export function simulate(
  fitted: Pick<Fitted, 'rates' | 'shape' | 'uncertainty_shape'>,
  start: number,
  end: number,
  zone: string,
  samples = 20_000,
  seed = 42,
): Float64Array {
  const rng = new Random(seed),
    intensities = new Map<string, number>();
  for (const t of hoursBetween(start, end)) {
    const local = localParts(t, zone);
    intensities.set(
      local.day,
      (intensities.get(local.day) ?? 0) + fitted.rates[local.weekday][local.hour],
    );
  }
  const common = Float64Array.from({ length: samples }, () =>
    rng.gamma(fitted.uncertainty_shape, 1 / fitted.uncertainty_shape),
  );
  const draws = new Float64Array(samples);
  for (const intensity of intensities.values())
    for (let i = 0; i < samples; i++) {
      draws[i] += rng.poisson(intensity * rng.gamma(fitted.shape, 1 / fitted.shape) * common[i]);
    }
  return draws;
}

export function backtest(data: HourData, cutoff: number, zone: string): Backtest {
  const checks: Backtest['results'] = [];
  for (const day of completeDays(data, cutoff, zone).slice(-14)) {
    const start = Math.min(...day.rows.map(([t]) => t));
    if (completeDays(data, start, zone).length < 14) continue;
    const fitted = fit(data, start, zone),
      end = Math.max(...day.rows.map(([t]) => t)) + HOUR;
    const draws = simulate(fitted, start, end, zone, 2500),
      sorted = draws.slice().sort();
    checks.push({
      date: day.day,
      actual: sum(day.rows.map(([, c]) => c)),
      prediction: round(mean(draws)),
      low: Math.floor(quantile(sorted, 0.1)),
      high: Math.floor(quantile(sorted, 0.9)),
    });
  }
  return {
    days: checks.length,
    mae: checks.length ? round(mean(checks.map((c) => Math.abs(c.actual - c.prediction)))) : null,
    coverage80: checks.length
      ? mean(checks.map((c) => Number(c.low <= c.actual && c.actual <= c.high)))
      : null,
    results: checks,
  };
}

export function forecast(
  data: HourData,
  start: number,
  end: number,
  zone: string,
  now = Date.now(),
  samples = 20_000,
): ForecastOutput {
  if (start !== hour(start) || end !== hour(end) || end <= start)
    throw new AppError('Границы периода должны совпадать с часами UTC; конец позже начала');
  if (end - start > 31 * DAY || end > now + 31 * DAY)
    throw new AppError('Горизонт прогноза ограничен 31 днём');
  const available = [...data.keys()].filter((t) => t < hour(now));
  if (!available.length) throw new AppError('Сначала импортируйте историю или включите демо');
  const cutoff = Math.min(hour(now), available.reduce((a, b) => Math.max(a, b)) + HOUR);
  const knownEnd = Math.min(end, cutoff),
    missing: number[] = [];
  let current = 0;
  for (const t of hoursBetween(start, knownEnd)) {
    if (!data.has(t)) missing.push(t);
    else current += data.get(t)!;
  }
  if (missing.length)
    throw new AppError(
      `В периоде рынка отсутствуют ${missing.length} часов истории; первый: ${iso(missing[0])}`,
    );
  const fitted = fit(data, Math.min(cutoff, end), zone),
    draws = simulate(fitted, Math.max(start, cutoff), end, zone, samples);
  for (let i = 0; i < draws.length; i++) draws[i] += current;
  const sorted = draws.slice().sort(),
    min = sorted[0],
    max = sorted.at(-1)!;
  const bins = Math.min(40, Math.max(1, max - min + 1)),
    left = min === max ? min - 0.5 : min,
    right = min === max ? max + 0.5 : max;
  const width = (right - left) / bins,
    hist = Array<number>(bins).fill(0);
  for (const d of draws) hist[Math.min(bins - 1, Math.floor((d - left) / width))]++;
  const warnings: string[] = [],
    staleHours = Math.max(0, (now - cutoff) / HOUR);
  if (staleHours > 3)
    warnings.push(`История отстаёт на ${staleHours.toFixed(1)} ч. Торговые сигналы отключены.`);
  if (fitted.days.length < 28)
    warnings.push('Менее 28 полных дней: оценка сезонности нестабильна.');
  const lastTrainingHour = Math.max(...fitted.days.at(-1)!.rows.map(([t]) => t)) + HOUR;
  const trainingFresh = Math.min(cutoff, end) - lastTrainingHour <= 72 * HOUR;
  if (!trainingFresh)
    warnings.push(
      'Последний полный день обучения старше 72 часов. Обновите историю; торговые сигналы отключены.',
    );
  return {
    draws,
    result: {
      current_count: current,
      cutoff: iso(cutoff),
      mean: round(mean(draws)),
      median: Math.floor(quantile(sorted, 0.5)),
      low: Math.floor(quantile(sorted, 0.1)),
      high: Math.floor(quantile(sorted, 0.9)),
      training_days: fitted.days.length,
      daily_mean: round(fitted.mean),
      dispersion: round(fitted.shape, 2),
      daily: fitted.days.map((d) => ({ date: d.day, count: sum(d.rows.map(([, c]) => c)) })),
      hourly_pattern: Array.from({ length: 24 }, (_, h) =>
        round(mean(fitted.rates.map((day) => day[h])), 2),
      ),
      histogram: hist.map((n, i) => ({
        from: left + i * width,
        to: left + (i + 1) * width,
        probability: n / samples,
      })),
      warnings,
      fresh: staleHours <= 3 && trainingFresh,
      timezone: zone,
      samples,
      backtest: backtest(data, Math.min(cutoff, end), zone),
    },
  };
}
