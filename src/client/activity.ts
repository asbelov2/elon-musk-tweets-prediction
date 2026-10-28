import type { Analysis, ActivityProfile } from '../shared/types.js';
const $ = (id: string) => document.getElementById(id)!;
const n = (value: number, digits = 1) =>
  value.toLocaleString('ru-RU', { maximumFractionDigits: digits });
const pct = (value: number) => `${n(value * 100)}%`;
const days = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const hh = (hour: number) => String(hour).padStart(2, '0') + ':00';
const clock = (value: string, zone: string, date = false) =>
  new Date(value).toLocaleString('ru-RU', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    ...(date ? ({ weekday: 'short', day: 'numeric', month: 'short' } as const) : {}),
  });
function node(tag: string, text: string, className = '') {
  const el = document.createElement(tag);
  el.textContent = text;
  el.className = className;
  return el;
}
function svg(tag: string, attrs: Record<string, string | number> = {}, text?: string) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  if (text !== undefined) el.textContent = text;
  return el;
}
function bars(id: string, values: number[], labels: string[], unit: string) {
  const root = svg('svg', { viewBox: '0 0 480 160', role: 'presentation', 'aria-hidden': 'true' });
  const max = Math.max(...values, 0.01) * 1.1,
    left = 38,
    width = 430,
    baseline = 125,
    height = 110;
  for (let i = 0; i <= 2; i++) {
    const y = baseline - (height * i) / 2;
    root.append(
      svg('line', { x1: left, y1: y, x2: left + width, y2: y, class: 'activity-gridline' }),
    );
    root.append(svg('text', { x: left - 7, y: y + 3, 'text-anchor': 'end' }, n((max * i) / 2)));
  }
  values.forEach((value, i) => {
    const step = width / values.length,
      barHeight = (value / max) * height;
    const bar = svg('rect', {
      x: left + i * step + 2,
      y: baseline - barHeight,
      width: Math.max(1, step - 4),
      height: barHeight,
      rx: 2,
      class: 'activity-bar',
    });
    bar.append(svg('title', {}, `${labels[i]}: ${n(value, 2)} ${unit}`));
    root.append(bar);
    if (values.length <= 7 || i % 3 === 0)
      root.append(
        svg(
          'text',
          { x: left + (i + 0.5) * step, y: baseline + 20, 'text-anchor': 'middle' },
          labels[i],
        ),
      );
  });
  $(id).replaceChildren(root);
}
export function updateActivityStatus(analysis: Analysis) {
  const profile = analysis.activity;
  if (!profile) return;
  const warnings = [...profile.warnings];
  if (!analysis.fresh)
    warnings.push(
      'Свежесть истории или источника не подтверждена. Оценки ближайшей активности условные.',
    );
  if (Date.now() - Date.parse(profile.as_of) > 15 * 60_000)
    warnings.push('Расчёт старше 15 минут. Обновите прогноз для нового ориентира ближайших часов.');
  $('activity-warnings').replaceChildren(...warnings.map((text) => node('div', text, 'warning')));
}
let activeProfile: ActivityProfile | null = null;
let activeAccount: string | null = null;
let daySelectedManually = false;
function renderSelectedDay() {
  const profile = activeProfile;
  if (!profile) return;
  const selected = Number(($('activity-day') as HTMLSelectElement).value);
  const day = profile.weekdays.find((day) => day.weekday === selected);
  const quiet = day?.quiet ?? profile.quiet,
    peak = day?.peak ?? profile.peak;
  const windowText = (window: ActivityProfile['quiet']) =>
    `${hh(window.start_hour)}–${hh(window.end_hour)}`;
  const distinct = peak.mean_per_hour > quiet.mean_per_hour * 1.15;
  $('activity-quiet').textContent = distinct ? windowText(quiet) : 'Нет выраженного окна';
  $('activity-peak').textContent = distinct ? windowText(peak) : 'Нет выраженного окна';
  $('activity-quiet-rate').textContent = `≈ ${n(quiet.mean_per_hour, 2)} публикаций/ч`;
  $('activity-peak-rate').textContent = `≈ ${n(peak.mean_per_hour, 2)} публикаций/ч`;
  bars(
    'activity-hourly',
    day ? day.hours.map((cell) => cell.expected) : profile.hourly,
    Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0')),
    'публикаций/ч',
  );
}
$('activity-day').addEventListener('change', () => {
  daySelectedManually = true;
  renderSelectedDay();
});
export function renderActivity(analysis: Analysis) {
  const profile = analysis.activity;
  $('activity-panel').hidden = !profile;
  activeProfile = profile ?? null;
  if (!profile) return;
  const account = analysis.handle ?? 'elonmusk';
  if (activeAccount !== account) daySelectedManually = false;
  activeAccount = account;
  if (!daySelectedManually)
    ($('activity-day') as HTMLSelectElement).value = String(profile.current_weekday);
  const zone = profile.timezone;
  $('activity-title').textContent = `Ритм публикаций @${analysis.handle ?? 'elonmusk'}`;
  $('activity-meta').textContent =
    `Время графиков и окон активности: ${zone === 'America/New_York' ? 'Нью-Йорк (ET) · ' : ''}${zone} · ${profile.training_days} полных дней истории · данные до ${clock(profile.history_end, zone, true)} · расчёт ${clock(profile.as_of, zone, true)}. Свежая история весит больше; вес уменьшается вдвое за 21 день.`;
  renderSelectedDay();
  $('activity-next').textContent = `≈ ${n(profile.next_three_hours.expected)} публикаций`;
  $('activity-next-chance').textContent =
    `Хотя бы одна: ${pct(profile.next_three_hours.probability_any)} · 80%: ${profile.next_three_hours.low}–${profile.next_three_hours.high}`;
  bars(
    'activity-weekdays',
    profile.weekdays.map((day) => day.expected),
    days,
    'публикаций за 24 ч',
  );
  const trend = profile.trend;
  $('activity-trend').textContent = trend
    ? `Последние 7 полных дней: ${n(trend.recent_mean)} публикаций/день; предыдущие 7: ${n(trend.previous_mean)}${trend.change_ratio === null ? ' (сравнение с нулевой базой)' : ` (${trend.change_ratio >= 0 ? '+' : ''}${pct(trend.change_ratio)})`}. За завершённые дни без пропусков.`
    : 'Для сравнения последних двух недель нужны 14 последовательных полных дней без пропусков.';
  if (trend)
    $('activity-trend').title =
      `${trend.start}–${trend.end}; новая неделя начинается ${trend.midpoint}`;
  const heatmap = $('activity-heatmap');
  heatmap.replaceChildren();
  const header = node('div', '', 'activity-heat-row');
  header.append(node('span', ''));
  for (let h = 0; h < 24; h++)
    header.append(
      node('span', h % 3 === 0 ? String(h).padStart(2, '0') : '', 'activity-hour-label'),
    );
  heatmap.append(header);
  const max = Math.max(
    ...profile.weekdays.flatMap((day) => day.hours.map((h) => h.expected)),
    0.01,
  );
  for (const day of profile.weekdays) {
    const row = node('div', '', 'activity-heat-row');
    const label = node('span', days[day.weekday], 'activity-day-label');
    label.title = `${day.days} полных дней наблюдений`;
    row.append(label);
    for (const cell of day.hours) {
      const el = node('span', '', 'activity-heat-cell');
      el.tabIndex = 0;
      el.style.backgroundColor = `hsl(145 38% ${12 + (48 * cell.expected) / max}%)`;
      el.title = `${days[day.weekday]} ${hh(cell.hour)}–${hh((cell.hour + 1) % 24)}: ≈ ${n(cell.expected, 2)} публикаций/ч; ${cell.observed_hours} часов наблюдений. Оценка сглажена.`;
      el.setAttribute('aria-label', el.title);
      row.append(el);
    }
    heatmap.append(row);
  }
  $('activity-upcoming').replaceChildren(
    ...profile.upcoming.map((item) => {
      const card = node('div', '', 'activity-slot');
      const sameDay =
        new Date(item.start).toLocaleDateString('ru-RU', { timeZone: zone }) ===
        new Date(item.end).toLocaleDateString('ru-RU', { timeZone: zone });
      card.append(
        node('span', `${clock(item.start, zone, true)}–${clock(item.end, zone, !sameDay)}`),
        node('strong', `≈ ${n(item.expected)} публикаций`),
        node('small', `Хотя бы одна: ${pct(item.probability_any)} · 80%: ${item.low}–${item.high}`),
      );
      const sameMoscowDay =
        new Date(item.start).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' }) ===
        new Date(item.end).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });
      if (zone !== 'Europe/Moscow')
        card.append(
          node(
            'small',
            `МСК: ${clock(item.start, 'Europe/Moscow', true)}–${clock(item.end, 'Europe/Moscow', !sameMoscowDay)}`,
          ),
        );
      card.title = `Москва: ${clock(item.start, 'Europe/Moscow', true)}–${clock(item.end, 'Europe/Moscow', true)} МСК`;
      return card;
    }),
  );
  updateActivityStatus(analysis);
}
