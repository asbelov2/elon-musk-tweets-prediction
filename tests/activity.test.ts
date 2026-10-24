import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DateTime } from 'luxon';
import { activityProfile, expectedActivity } from '../src/server/activity.js';
import { runForecast } from '../src/server/forecast-runner.js';
import { fit, forecast } from '../src/server/model.js';
import { DAY, HOUR, hour, localParts } from '../src/server/time.js';
import type { HourData } from '../src/shared/types.js';
const now = Date.parse('2026-10-24T12:30:00Z');
function history(
  time = now,
  zone = 'UTC',
  days = 70,
  count?: (h: number, weekday: number) => number,
): HourData {
  const end = hour(time);
  return new Map(
    Array.from({ length: days * 24 }, (_, i) => {
      const t = end - (days * 24 - i) * HOUR,
        local = localParts(t, zone);
      const value = count
        ? count(local.hour, local.weekday)
        : local.hour < 6
          ? 0
          : local.weekday < 5
            ? local.hour >= 10 && local.hour < 16
              ? 20
              : 1
            : local.hour >= 18
              ? 12
              : 1;
      return [t, value];
    }),
  );
}
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('Activity exposes the same 168 smoothed rates used by forecasts, with observation counts', () => {
  const data = history(),
    fitted = fit(data, hour(now), 'UTC'),
    profile = activityProfile(data, 'UTC', now);
  assert.equal(profile.weekdays.length, 7);
  assert.equal(profile.training_days, fitted.days.length);
  assert.ok(profile.effective_days > 0 && profile.effective_days <= profile.training_days);
  profile.weekdays.forEach((day, w) => {
    assert.equal(day.hours.length, 24);
    day.hours.forEach((cell, h) => {
      close(cell.expected, fitted.rates[w][h]);
      assert.equal(cell.observed_hours, day.days);
    });
    close(
      day.expected,
      fitted.rates[w].reduce((a, b) => a + b, 0),
    );
  });
  profile.hourly.forEach((rate, h) =>
    close(rate, fitted.rates.reduce((sum, d) => sum + d[h], 0) / 7),
  );
  assert.equal(profile.quiet.start_hour, 0);
  assert.equal(profile.quiet.end_hour, 6);
  assert.ok(profile.peak.mean_per_hour > profile.quiet.mean_per_hour * 10);
  assert.ok(profile.weekdays[0].hours[12].expected > profile.weekdays[6].hours[12].expected);
  assert.ok(profile.weekdays[6].hours[20].expected > profile.weekdays[0].hours[20].expected);
});

test('Hourly and weekly effects materially change market forecasts for equal future exposure', () => {
  const data = history();
  const predict = (start: string) => {
    const t = Date.parse(start);
    return forecast(data, t, t + 6 * HOUR, 'UTC', now, 4000).result.mean;
  };
  const monday = predict('2026-10-26T10:00:00Z');
  const sunday = predict('2026-10-25T10:00:00Z');
  const night = predict('2026-10-26T00:00:00Z');
  assert.ok(monday > sunday * 1.5, `${monday} vs ${sunday}`);
  assert.ok(monday > night * 10, `${monday} vs ${night}`);
});

test('Upcoming outlook uses only future exposure, same model means, and valid predictive probabilities', () => {
  const data = history(),
    profile = activityProfile(data, 'UTC', now),
    fitted = fit(data, hour(now), 'UTC');
  assert.equal(profile.upcoming.length, 6);
  assert.equal(profile.upcoming[0].start, new Date(now).toISOString());
  for (const item of [...profile.upcoming, profile.next_three_hours]) {
    assert.equal(
      item.expected,
      expectedActivity(fitted, Date.parse(item.start), Date.parse(item.end), 'UTC'),
    );
    assert.ok(item.probability_any >= 0 && item.probability_any <= 1);
    assert.ok(item.low >= 0 && item.high >= item.low);
  }
  profile.upcoming.forEach((item, i) => {
    assert.equal(Date.parse(item.end) - Date.parse(item.start), 2 * HOUR);
    assert.equal(Date.parse(item.start), now + i * 2 * HOUR);
  });
  const constant = { rates: Array.from({ length: 7 }, () => Array<number>(24).fill(2)) };
  close(expectedActivity(constant, now, now + HOUR / 4, 'UTC'), 0.5);
  assert.deepEqual(activityProfile(data, 'UTC', now), profile);
});

test('Current/future hours cannot leak; missing hours remove whole days and break weekly comparison', () => {
  const data = history(),
    baseline = activityProfile(data, 'UTC', now),
    changed = new Map(data);
  for (let i = 0; i < 48; i++) changed.set(hour(now) + i * HOUR, 9999);
  assert.deepEqual(activityProfile(changed, 'UTC', now), baseline);
  changed.delete(hour(now) - DAY);
  const incomplete = activityProfile(changed, 'UTC', now);
  assert.equal(incomplete.training_days, baseline.training_days - 1);
  assert.equal(incomplete.trend, null);
  const stale = new Map([...data].filter(([t]) => t < hour(now) - 5 * HOUR));
  assert.equal(activityProfile(stale, 'UTC', now).fresh, false);
  const isolated = new Map([...data].filter(([t]) => t < hour(now) - 5 * DAY));
  isolated.set(hour(now) - HOUR, 1);
  assert.equal(activityProfile(isolated, 'UTC', now).fresh, false);
});

test('DST missing and repeated hours retain real exposure in weekly cells and projections', () => {
  for (const [stamp, h, delta] of [
    ['2026-03-09T12:00:00Z', 2, -1],
    ['2026-11-02T12:00:00Z', 1, 1],
  ] as const) {
    const time = Date.parse(stamp),
      profile = activityProfile(
        history(time, 'America/New_York', 60, () => 2),
        'America/New_York',
        time,
      );
    const sunday = profile.weekdays[6];
    assert.equal(sunday.hours[h].observed_hours, sunday.days + delta);
  }
  const constant = { rates: Array.from({ length: 7 }, () => Array<number>(24).fill(2)) };
  for (const [day, length] of [
    ['2026-03-08', 23],
    ['2026-11-01', 25],
  ] as const) {
    const start = DateTime.fromISO(day, { zone: 'America/New_York' });
    close(
      expectedActivity(
        constant,
        start.toMillis(),
        start.plus({ days: 1 }).toMillis(),
        'America/New_York',
      ),
      length * 2,
    );
  }
});

test('Quiet windows wrap midnight; weekly trend handles a zero previous week without infinity', () => {
  const wrapped = activityProfile(
    history(now, 'UTC', 60, (h) => (h >= 22 || h < 4 ? 0 : 10)),
    'UTC',
    now,
  );
  assert.equal(wrapped.quiet.start_hour, 22);
  assert.equal(wrapped.quiet.end_hour, 4);
  const end = DateTime.fromMillis(now, { zone: 'UTC' }).startOf('day').toMillis();
  const data = new Map(
    Array.from(
      { length: 14 * 24 },
      (_, i) => [end - 14 * DAY + i * HOUR, i < 7 * 24 ? 0 : 1] as [number, number],
    ),
  );
  const profile = activityProfile(data, 'UTC', now);
  assert.equal(profile.trend!.previous_mean, 0);
  assert.equal(profile.trend!.recent_mean, 24);
  assert.equal(profile.trend!.change_ratio, null);
  assert.match(profile.warnings.join(' '), /28/);
});

test('A settled market keeps its deterministic total while the activity profile uses current history', async () => {
  const data = history();
  const result = await runForecast({
    rows: [...data],
    start: hour(now) - 7 * DAY,
    end: hour(now) - 5 * DAY,
    timezone: 'UTC',
    now,
  });
  assert.equal(result.result.low, result.result.high);
  assert.ok(Date.parse(result.result.activity!.history_end) > hour(now) - 5 * DAY);
  assert.equal(result.result.activity!.as_of, new Date(now).toISOString());
});
