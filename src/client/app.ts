import type {
  Analysis,
  AnalyzeRequest,
  CollectionPreview,
  Dataset,
  DemoEvent,
  MarketEvent,
  Position,
  Status,
  TrackerReport,
} from '../shared/types.js';
type InputId =
  | 'csv-file'
  | 'csv-confirm'
  | 'history-days'
  | 'include-reposts'
  | 'include-replies'
  | 'tracker-confirm'
  | 'start'
  | 'end'
  | 'target-date'
  | 'rules-confirm'
  | 'event-url'
  | 'budget'
  | 'expenses'
  | 'safety'
  | 'auto-refresh';
type SelectId = 'timezone' | 'position-filter' | 'collector-source' | 'x-mode' | 'history-source';
type ButtonId =
  | 'demo'
  | 'demo-empty'
  | 'go-live'
  | 'import'
  | 'collect'
  | 'confirm-collect'
  | 'load-market'
  | 'analyze'
  | 'one-day';
type TrackerButton = 'sync-tracker';
type ElementFor<Id extends string> = Id extends InputId
  ? HTMLInputElement
  : Id extends SelectId
    ? HTMLSelectElement
    : Id extends ButtonId | TrackerButton
      ? HTMLButtonElement
      : Id extends 'market-rules'
        ? HTMLDetailsElement
        : HTMLElement;
function $<Id extends string>(id: Id): ElementFor<Id> {
  const element = document.getElementById(id);
  if (!element) throw new Error('Missing UI element: ' + id);
  return element as ElementFor<Id>;
}
const state: {
  dataset: Dataset;
  result: Analysis | null;
  event: MarketEvent | null;
  preview: string | null;
  busy: boolean;
  version: number;
  realDataset: 'live' | 'xtracker';
  tracker: TrackerReport | null;
} = {
  dataset: 'xtracker',
  result: null,
  event: null,
  preview: null,
  busy: false,
  version: 0,
  realDataset: 'xtracker',
  tracker: null,
};
const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const number = (n: number | null | undefined, digits = 0) =>
  n == null
    ? '—'
    : Number(n).toLocaleString('ru-RU', {
        maximumFractionDigits: digits,
        minimumFractionDigits: digits,
      });
const pct = (n: number | null | undefined, digits = 1) =>
  n == null ? '—' : `${number(n * 100, digits)}%`;
const money = (n: number | null | undefined) =>
  n == null ? '—' : `${n > 0 ? '+' : ''}${number(n, 2)}`;
const stamp = (value: string | null | undefined) =>
  value
    ? new Date(value).toLocaleString('ru-RU', {
        timeZone: 'Europe/Moscow',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }) + ' МСК'
    : '—';
function message(text: string, kind = '') {
  $('message').textContent = text;
  $('message').className = `notice ${kind}`;
  $('message').hidden = !text;
}
async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(
    path,
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  let data: unknown;
  try {
    data = await r.json();
  } catch {
    throw new Error(`Сервер вернул HTTP ${r.status}. Проверьте журнал приложения.`);
  }
  if (!r.ok) {
    const detail =
      data !== null && typeof data === 'object' && 'detail' in data ? data.detail : undefined;
    throw new Error(typeof detail === 'string' ? detail : `Ошибка HTTP ${r.status}`);
  }
  return data as T;
}
async function action(button: HTMLButtonElement, work: () => Promise<void>) {
  if (state.busy) return;
  state.busy = true;
  const previous = button.textContent;
  button.disabled = true;
  button.textContent = 'Выполняется…';
  message('');
  try {
    await work();
  } catch (e) {
    message(errorText(e), 'error');
  } finally {
    state.busy = false;
    button.disabled = false;
    button.textContent = previous ?? '';
  }
}
function invalidate() {
  state.version++;
  state.result = null;
  $('result-content').hidden = true;
  $('empty-state').hidden = false;
}
function setMode(dataset: Dataset) {
  state.dataset = dataset;
  if (dataset !== 'demo') state.realDataset = dataset;
  $('history-source').value = state.realDataset;
  if (dataset !== 'xtracker') $('tracker-counter').hidden = true;
  invalidate();
  $('mode').textContent = dataset === 'demo' ? 'ДЕМОНСТРАЦИЯ' : 'РЕАЛЬНЫЕ ДАННЫЕ';
  $('mode').classList.toggle('is-demo', dataset === 'demo');
  $('demo-banner').hidden = dataset !== 'demo';
  $('auto-refresh').checked = false;
}
async function status() {
  const all = await api<Status>('/api/status');
  const data = all[state.dataset];
  $('export-history').setAttribute('href', '/api/export?dataset=' + state.realDataset);
  $('x-key-status').textContent = all.x_api?.credentials_present
    ? 'Bearer Token: настроен (доступ проверяется при сборе)'
    : 'Bearer Token: не настроен. Добавьте X_BEARER_TOKEN в секреты среды.';
  $('data-state').textContent = data.hours ? `${number(data.hours)} ЧАСОВ` : 'НЕТ ИСТОРИИ';
  $('data-summary').textContent = data.hours
    ? `${number(data.hours)} часов · ${number(data.posts)} публикаций\n${stamp(data.start)} → ${stamp(data.end)}\n${data.sources.join(', ')}`
    : 'Импортируйте историю или включите демо.';
}
function showTracker(report: TrackerReport, applyPeriod = false) {
  state.tracker = report;
  $('tracker-counter').hidden = false;
  $('tracker-summary').textContent =
    `${number(report.count)} публикаций · снимок ${stamp(report.as_of)}\nПериод: ${stamp(report.start)} → ${stamp(report.end)}\nПоследняя успешная синхронизация: ${stamp(report.last_sync)}${report.export_records ? `\nЭкспорт сверён: ${number(report.export_records)} уникальных записей` : ''}\n${report.warnings.join('\n')}`;
  if (applyPeriod) {
    $('start').value = report.local_start;
    $('end').value = report.local_end;
    $('timezone').value = 'America/New_York';
    $('rules-confirm').checked = false;
    invalidate();
  }
}
async function loadTrackerWindow() {
  invalidate();
  $('tracker-counter').hidden = true;
  const report = await api<TrackerReport>(
    '/api/xtracker?url=' + encodeURIComponent($('event-url').value),
  );
  showTracker(report, true);
}
function showEvent(event: MarketEvent) {
  state.event = event;
  $('event-title').textContent = event.title;
  $('event-description').textContent =
    event.description || 'Источник не передал текст правил. Сверьте их на странице события.';
  $('event-resolution').textContent =
    `Источник разрешения: ${event.resolution_source || 'не указан'}${event.excluded.length ? `\nНе распознаны: ${event.excluded.join('; ')}` : ''}`;
  $('market-rules').open = true;
}
function params(): AnalyzeRequest {
  for (const id of ['start', 'end', 'budget', 'expenses', 'safety'] as const) {
    if (!$(id).value || !$(id).checkValidity())
      throw new Error('Проверьте поле: ' + ($(id).parentElement?.textContent ?? id).trim());
  }
  return {
    dataset: state.dataset,
    event_url: $('event-url').value.trim(),
    start: $('start').value,
    end: $('end').value,
    timezone: $('timezone').value,
    budget: Number($('budget').value),
    expense_bps: Number($('expenses').value) * 100,
    safety_pp: Number($('safety').value),
    rules_confirmed: $('rules-confirm').checked,
  };
}
async function runAnalysis(refreshMarket = true) {
  const body = params(),
    version = state.version;
  if (state.dataset !== 'demo' && body.event_url && refreshMarket) {
    const e = await api<MarketEvent>('/api/event?url=' + encodeURIComponent(body.event_url));
    if (version !== state.version) return;
    showEvent(e);
  }
  const r = await api<Analysis>('/api/analyze', body);
  if (version !== state.version) return;
  state.result = r;
  render(r);
}
async function demo(button: HTMLButtonElement) {
  await action(button, async () => {
    const event = await api<DemoEvent>('/api/demo', {});
    setMode('demo');
    $('start').value = event.start;
    $('end').value = event.end;
    $('timezone').value = event.timezone;
    $('rules-confirm').checked = true;
    showEvent(event);
    await status();
    await runAnalysis(false);
    message('Демо загружено. Все числа и стаканы в этом режиме синтетические.', 'success');
  });
}
function svgNode(name: string, attrs: Record<string, string | number> = {}, text?: string) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text !== undefined) el.textContent = text;
  return el;
}
function chart(id: string, values: number[], labels: string[], isHistory = false) {
  const el = $(id);
  el.replaceChildren();
  const svg = svgNode('svg', {
    viewBox: '0 0 800 230',
    preserveAspectRatio: 'none',
    'aria-hidden': 'true',
  });
  const w = 738,
    h = 177,
    left = 48,
    top = 10,
    base = top + h;
  const max = Math.max(...values, 0.01) * 1.12;
  for (let i = 0; i <= 4; i++) {
    const v = (max * i) / 4,
      y = base - (h * i) / 4;
    svg.append(svgNode('line', { x1: left, y1: y, x2: left + w, y2: y, class: 'gridline' }));
    svg.append(
      svgNode(
        'text',
        { x: left - 9, y: y + 4, 'text-anchor': 'end' },
        isHistory ? number(v) : pct(v, 0),
      ),
    );
  }
  const step = w / Math.max(1, values.length);
  values.forEach((value, i) => {
    const bh = (value / max) * h;
    const rect = svgNode('rect', {
      x: left + i * step + 1,
      y: base - bh,
      width: Math.max(1, step - 2),
      height: Math.max(0.5, bh),
      rx: 2,
      class: isHistory ? 'history-bar' : 'bar',
    });
    rect.append(
      svgNode(
        'title',
        {},
        `${labels[i]}: ${isHistory ? number(value) + ' публикаций' : pct(value, 2)}`,
      ),
    );
    svg.append(rect);
    const stride = Math.max(1, Math.ceil(values.length / 7));
    if (i % stride === 0)
      svg.append(
        svgNode(
          'text',
          { x: left + (i + 0.5) * step, y: base + 25, 'text-anchor': 'middle' },
          isHistory ? labels[i].slice(5) : labels[i].split('–')[0],
        ),
      );
  });
  el.append(svg);
}
function appendCell(row: HTMLTableRowElement, text: string, className = '') {
  const td = document.createElement('td');
  td.textContent = text;
  td.className = className;
  row.append(td);
  return td;
}
function renderPositions() {
  const r = state.result;
  if (!r) return;
  const body = $('positions-body');
  body.replaceChildren();
  const filter = $('position-filter').value;
  const stale =
    r.dataset !== 'demo' && r.event && Date.now() - Date.parse(r.event.fetched_at) > 120000;
  const expired = (p: Position) =>
    r.dataset !== 'demo' &&
    (!p.book_fetched_at || Date.now() - Date.parse(p.book_fetched_at) > 120000);
  const rows = r.positions.filter(
    (p) => filter === 'all' || (filter === 'signals' ? p.signal && !expired(p) : p.side === filter),
  );
  for (const p of rows) {
    const row = document.createElement('tr');
    const label = appendCell(row, p.label);
    const side = document.createElement('span');
    side.className = `side ${p.side === 'NO' ? 'no' : ''}`;
    side.textContent = p.side;
    label.append(side);
    const prob = appendCell(row, pct(p.probability));
    prob.title = `Погрешность Монте-Карло ≈ ${number(p.mc_standard_error * 100, 2)} п.п. Она не учитывает ошибку модели.`;
    const price = appendCell(row, p.vwap == null ? '—' : `${number(p.vwap * 100, 2)} ¢`);
    price.title = `Акций: ${number(p.shares, 2)}; покупка $${number(p.cost, 2)} + резерв $${number(p.expenses, 2)}; исполнено ${pct(p.filled_fraction, 1)} бюджета. Выплата при выигрыше: $${number(p.shares, 2)}. Максимальная потеря: $${number(p.total, 2)}.`;
    appendCell(
      row,
      p.edge == null ? '—' : `${(p.edge ?? 0) > 0 ? '+' : ''}${number(p.edge * 100, 1)} п.п.`,
      (p.edge ?? 0) > 0 ? 'positive' : (p.edge ?? 0) < 0 ? 'negative' : '',
    );
    appendCell(
      row,
      money(p.expected_profit),
      (p.expected_profit ?? 0) > 0 ? 'positive' : (p.expected_profit ?? 0) < 0 ? 'negative' : '',
    );
    appendCell(row, pct(p.roi), (p.roi ?? 0) > 0 ? 'positive' : (p.roi ?? 0) < 0 ? 'negative' : '');
    const cell = appendCell(row, '');
    const badge = document.createElement('span');
    const isExpired = expired(p),
      signal = p.signal && !isExpired;
    badge.className = `signal ${signal ? '' : p.reasons.length || isExpired ? 'neutral' : 'negative'}`;
    badge.textContent = signal
      ? r.dataset === 'demo'
        ? 'ДЕМО +EV'
        : '+EV С ЗАПАСОМ'
      : p.reasons.length || isExpired
        ? 'НЕТ СИГНАЛА'
        : 'НЕТ ЗАПАСА';
    badge.title = [
      ...(isExpired ? ['Котировки устарели. Обновите рынок.'] : []),
      ...p.reasons,
      `EV после запаса: $${money(p.conservative_profit)}`,
    ].join('\n');
    cell.append(badge);
    body.append(row);
  }
  if (!rows.length) {
    const row = document.createElement('tr');
    const cell = appendCell(
      row,
      r.positions.length
        ? 'Нет позиций по выбранному фильтру.'
        : 'Рынок не выбран или период отличается от демонстрационного рынка. Доступен прогноз без оценки позиций.',
    );
    cell.colSpan = 7;
    cell.style.whiteSpace = 'normal';
    body.append(row);
  }
  $('stat-signals').textContent = stale
    ? '—'
    : number(r.positions.filter((p) => p.signal && !expired(p)).length);
  $('position-note').textContent = stale
    ? 'Котировки устарели: сигналы отключены. Нажмите «Рассчитать прогноз» для обновления. Значения EV ниже относятся к прошлому снимку.'
    : 'EV = вероятность × число акций − стоимость − резерв расходов. Цена покупки — средняя по доступным asks. Наведите на цену и оценку, чтобы увидеть расчёт и ограничения.';
}
function render(r: Analysis) {
  if (r.tracker) showTracker(r.tracker);
  $('current-count-label').textContent = r.tracker ? 'Post Counter · XTracker' : 'Уже учтено';
  $('empty-state').hidden = true;
  $('result-content').hidden = false;
  $('result-title').textContent =
    r.dataset === 'demo' ? 'Прогноз активности · демо' : 'Прогноз активности';
  $('asof').textContent =
    `Расчёт: ${stamp(r.generated_at)}${r.event ? '\nКотировки: ' + stamp(r.event.fetched_at) : ''}`;
  $('stat-current').textContent = number(r.current_count);
  $('stat-mean').textContent = number(r.mean, 1);
  $('stat-range').textContent = `${number(r.low)}–${number(r.high)}`;
  $('stat-cutoff').textContent = `${r.tracker ? 'Счётчик на' : 'История до'} ${stamp(r.cutoff)}`;
  $('warnings').replaceChildren();
  for (const text of r.warnings) {
    const p = document.createElement('div');
    p.className = 'warning';
    p.textContent = text;
    $('warnings').append(p);
  }
  if (r.dataset === 'demo') {
    const p = document.createElement('div');
    p.className = 'warning';
    p.textContent =
      'Искусственные данные: оценки позиций ниже не являются оценками реальных рынков.';
    $('warnings').prepend(p);
  }
  chart(
    'distribution',
    r.histogram.map((b) => b.probability),
    r.histogram.map((b) => `${Math.floor(b.from)}–${Math.ceil(b.to)}`),
  );
  $('model-label').textContent = `${r.training_days} дней истории · Gamma–Poisson`;
  const days = r.daily.slice(-42);
  chart(
    'history-chart',
    days.map((x) => x.count),
    days.map((x) => x.date),
    true,
  );
  $('backtest-mae').textContent = number(r.backtest.mae, 1);
  $('backtest-coverage').textContent = pct(r.backtest.coverage80, 0);
  $('backtest-info').textContent = r.backtest.days
    ? `Проверено ${r.backtest.days} завершённых дней. MAE — средняя абсолютная ошибка. Небольшая выборка: покрытие может заметно колебаться.`
    : 'Для проверки нужно больше истории: минимум 14 дней обучения и хотя бы 1 последующий полный день.';
  renderPositions();
}
$('demo').addEventListener('click', () => demo($('demo')));
$('demo-empty').addEventListener('click', () => demo($('demo-empty')));
$('go-live').addEventListener('click', () =>
  action($('go-live'), async () => {
    setMode(state.realDataset);
    $('rules-confirm').checked = false;
    state.event = null;
    $('event-title').textContent = 'Рынок ещё не загружен';
    $('event-description').textContent = 'Загрузите реальное событие и сверьте правила.';
    $('event-resolution').textContent = '';
    await status();
    message('Включены реальные данные. Загрузите рынок и проверьте даты.');
  }),
);
for (const [tab, panel] of [
  ['csv', 'csv-panel'],
  ['tracker', 'tracker-panel'],
])
  $('tab-' + tab).addEventListener('click', () => {
    for (const t of ['csv', 'tracker']) {
      $('tab-' + t).classList.toggle('selected', t === tab);
      $('tab-' + t).setAttribute('aria-selected', String(t === tab));
    }
    $('csv-panel').hidden = panel !== 'csv-panel';
    $('tracker-panel').hidden = panel !== 'tracker-panel';
  });
$('csv-file').addEventListener('change', () => {
  $('file-name').textContent = $('csv-file').files?.[0]?.name || '';
  $('csv-confirm').checked = false;
});
$('import').addEventListener('click', () =>
  action($('import'), async () => {
    const file = $('csv-file').files?.[0];
    if (!file) throw new Error('Выберите CSV-файл.');
    if (file.size > 5000000) throw new Error('Файл больше 5 МБ.');
    const r = await api<{ imported_hours: number }>('/api/import', {
      content: await file.text(),
      coverage_confirmed: $('csv-confirm').checked,
    });
    setMode('live');
    $('rules-confirm').checked = false;
    await status();
    message(
      `Импортировано ${number(r.imported_hours)} часов. Повторный импорт обновляет совпадающие часы.`,
      'success',
    );
  }),
);
$('collect').addEventListener('click', () =>
  action($('collect'), async () => {
    state.preview = null;
    $('collection-preview').hidden = true;
    const r = await api<CollectionPreview>('/api/collect', {
      source: $('collector-source').value,
      mode: $('x-mode').value,
      days: Number($('history-days').value),
      include_replies: $('include-replies').checked,
      include_reposts: $('include-reposts').checked,
      event_url: $('event-url').value,
    });
    state.preview = r.preview_id;
    if (r.tracker) showTracker(r.tracker, true);
    $('collection-preview').hidden = false;
    $('tracker-confirm').checked = false;
    $('preview-text').textContent =
      `Найдено ${number(r.posts)} публикаций, ${number(r.hours)} часов. ${stamp(r.start)} → ${stamp(r.end)}. ${r.notice}`;
  }),
);
$('confirm-collect').addEventListener('click', () =>
  action($('confirm-collect'), async () => {
    if (!state.preview) throw new Error('Сначала соберите историю.');
    const r = await api<{ imported_hours: number; dataset: Dataset }>('/api/collect/confirm', {
      preview_id: state.preview,
      coverage_confirmed: $('tracker-confirm').checked,
    });
    state.preview = null;
    $('collection-preview').hidden = true;
    setMode(r.dataset);
    $('rules-confirm').checked = false;
    await status();
    message(`Сохранено ${number(r.imported_hours)} часов.`, 'success');
  }),
);
$('load-market').addEventListener('click', () =>
  action($('load-market'), async () => {
    if (state.dataset === 'demo') setMode(state.realDataset);
    else invalidate();
    $('rules-confirm').checked = false;
    const r = await api<MarketEvent>('/api/event?url=' + encodeURIComponent($('event-url').value));
    showEvent(r);
    if (state.dataset === 'xtracker') await loadTrackerWindow();
    await status();
    message('Рынок загружен. Проверьте правила, период и типы публикаций.', 'success');
  }),
);
$('analyze').addEventListener('click', () =>
  action($('analyze'), async () => {
    try {
      await runAnalysis();
    } catch (error) {
      invalidate();
      throw error;
    }
  }),
);
$('position-filter').addEventListener('change', renderPositions);
for (const id of [
  'event-url',
  'start',
  'end',
  'timezone',
  'budget',
  'expenses',
  'safety',
  'rules-confirm',
])
  $(id).addEventListener('input', () => {
    invalidate();
    if (['event-url', 'start', 'end', 'timezone'].includes(id)) $('rules-confirm').checked = false;
  });
$('one-day').addEventListener('click', () => {
  const value = $('target-date').value;
  if (!value) {
    message('Выберите дату для суточного прогноза.', 'error');
    return;
  }
  const dt = new Date(value + 'T00:00:00Z');
  dt.setUTCDate(dt.getUTCDate() + 1);
  $('start').value = value + 'T00:00';
  $('end').value = dt.toISOString().slice(0, 10) + 'T00:00';
  $('rules-confirm').checked = false;
  invalidate();
  message('Выбраны сутки. Для прогноза без оценки рыночных позиций очистите ссылку на событие.');
});
setInterval(() => {
  if (state.result) renderPositions();
}, 10000);
setInterval(async () => {
  if (!$('auto-refresh').checked || !state.result || state.busy || document.hidden) return;
  await action($('analyze'), async () => {
    try {
      await runAnalysis();
    } catch (e) {
      invalidate();
      throw e;
    }
  });
}, 60000);
status().catch((e) => message(e.message, 'error'));

$('collector-source').addEventListener('change', () => {
  $('x-options').hidden = $('collector-source').value !== 'x';
  $('x-filters').hidden = $('collector-source').value !== 'x';
  state.preview = null;
  $('collection-preview').hidden = true;
});
for (const id of ['x-mode', 'history-days', 'include-replies', 'include-reposts'])
  $(id).addEventListener('change', () => {
    state.preview = null;
    $('collection-preview').hidden = true;
  });
$('sync-tracker').addEventListener('click', () => action($('sync-tracker'), loadTrackerWindow));
$('history-source').addEventListener('change', () => {
  setMode($('history-source').value === 'xtracker' ? 'xtracker' : 'live');
  $('rules-confirm').checked = false;
  void status().catch((error) => message(errorText(error), 'error'));
});
