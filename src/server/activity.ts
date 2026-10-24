import { DateTime } from 'luxon';
import type { ActivityProfile, ActivityOutlook, HourData } from '../shared/types.js';
import { fit, mean, quantile, simulate, type Fitted } from './model.js';
import { HOUR, hour, hoursBetween, iso, localParts } from './time.js';

/** Same smoothed 7 × 24 rates and Gamma–Poisson uncertainty as the market forecast. */
export function expectedActivity(
  fitted: Pick<Fitted, 'rates'>,
  start: number,
  end: number,
  zone: string,
): number {
  let expected = 0;
  for (const t of hoursBetween(hour(start), end)) {
    const local = localParts(t, zone);
    expected +=
      (fitted.rates[local.weekday][local.hour] * (Math.min(t + HOUR, end) - Math.max(t, start))) /
      HOUR;
  }
  return expected;
}
function typicalWindow(rates: number[], quiet: boolean) {
  const hours = 6;
  let start = 0,
    selected = quiet ? Infinity : -Infinity;
  for (let h = 0; h < 24; h++) {
    const value = mean(Array.from({ length: hours }, (_, offset) => rates[(h + offset) % 24]));
    if (quiet ? value < selected : value > selected) {
      start = h;
      selected = value;
    }
  }
  return { start_hour: start, end_hour: (start + hours) % 24, hours, mean_per_hour: selected };
}
export function activityProfile(data: HourData, zone: string, now = Date.now()): ActivityProfile {
  // Ignore future and incomplete hours. For a settled market use current history,
  // rather than freezing this independent orientation profile at the event's end.
  const available = [...data.keys()].filter((t) => t < hour(now));
  const cutoff = Math.min(
    hour(now),
    available.reduce((latest, t) => Math.max(latest, t + HOUR), -Infinity),
  );
  const fitted = fit(data, cutoff, zone);
  const weekdayDays = Array<number>(7).fill(0);
  const cells = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  for (const day of fitted.days) {
    weekdayDays[DateTime.fromISO(day.day, { zone }).weekday - 1]++;
    for (const [t] of day.rows) {
      const local = localParts(t, zone);
      cells[local.weekday][local.hour]++;
    }
  }
  const hourly = Array.from({ length: 24 }, (_, h) => mean(fitted.rates.map((day) => day[h])));
  const historyEnd = Math.max(...fitted.days.at(-1)!.rows.map(([t]) => t)) + HOUR;
  const warnings: string[] = [];
  if (fitted.days.length < 28)
    warnings.push('Менее 28 полных дней: почасовые и недельные закономерности пока нестабильны.');
  const fresh = now - cutoff <= 3 * HOUR && now - historyEnd <= 72 * HOUR;
  if (!fresh)
    warnings.push(
      'История профиля устарела. Ближайшая активность — условный ориентир по прежнему расписанию.',
    );
  function outlook(start: number, end: number, seed: number): ActivityOutlook {
    const draws = simulate(fitted, start, end, zone, 4000, seed);
    const sorted = draws.slice().sort();
    return {
      start: iso(start),
      end: iso(end),
      expected: expectedActivity(fitted, start, end, zone),
      probability_any: draws.reduce((n, value) => n + Number(value > 0), 0) / draws.length,
      low: Math.floor(quantile(sorted, 0.1)),
      high: Math.ceil(quantile(sorted, 0.9)),
    };
  }
  let trend: ActivityProfile['trend'] = null;
  const recent = fitted.days.slice(-14);
  if (
    recent.length === 14 &&
    recent.at(-1)!.day === DateTime.fromMillis(now, { zone }).minus({ days: 1 }).toISODate() &&
    recent.every(
      (day, i) =>
        i === 0 ||
        DateTime.fromISO(recent[i - 1].day, { zone })
          .plus({ days: 1 })
          .toISODate() === day.day,
    )
  ) {
    const totals = recent.map((day) => day.rows.reduce((n, [, c]) => n + c, 0));
    const previous = mean(totals.slice(0, 7)),
      current = mean(totals.slice(7));
    trend = {
      recent_mean: current,
      previous_mean: previous,
      change_ratio: previous > 0 ? current / previous - 1 : null,
      start: recent[0].day,
      midpoint: recent[7].day,
      end: recent[13].day,
    };
  }
  return {
    timezone: zone,
    current_weekday: localParts(now, zone).weekday,
    as_of: iso(now),
    history_end: iso(historyEnd),
    training_days: fitted.days.length,
    effective_days: fitted.effective_days,
    fresh,
    warnings,
    hourly,
    weekdays: fitted.rates.map((rates, weekday) => ({
      weekday,
      expected: rates.reduce((a, b) => a + b, 0),
      days: weekdayDays[weekday],
      quiet: typicalWindow(rates, true),
      peak: typicalWindow(rates, false),
      hours: rates.map((expected, h) => ({ hour: h, expected, observed_hours: cells[weekday][h] })),
    })),
    quiet: typicalWindow(hourly, true),
    peak: typicalWindow(hourly, false),
    trend,
    next_three_hours: outlook(now, now + 3 * HOUR, 2718),
    upcoming: Array.from({ length: 6 }, (_, i) =>
      outlook(now + i * 2 * HOUR, now + (i + 1) * 2 * HOUR, 3141 + i),
    ),
    samples: 4000,
  };
}
