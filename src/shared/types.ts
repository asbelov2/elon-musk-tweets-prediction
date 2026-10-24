export type Dataset = 'live' | 'demo' | 'xtracker';
export interface MarketConfig {
  id: string;
  label: string;
  handle: string;
  event_url: string;
}
export type Side = 'yes' | 'no';
/** UTC epoch milliseconds, count. Missing hours are unknown, never zero. */
export type HourRow = [number, number];
export type HourData = Map<number, number>;
export interface Level {
  price: number;
  size: number;
}
export interface Book {
  asks: Level[];
  fetched_at?: string;
  error?: string;
}
export interface Market {
  id: string;
  label: string;
  lower: number;
  upper: number | null;
  tokens: Partial<Record<Side, string>>;
  active: boolean;
  fees_enabled: boolean;
  books: Partial<Record<Side, Book>>;
  question?: string;
}
export interface MarketEvent {
  handle?: string;
  slug: string;
  title: string;
  description: string;
  resolution_source: string;
  markets: Market[];
  excluded: string[];
  fetched_at: string;
  demo: boolean;
  start?: string;
  end?: string;
  timezone?: string;
}
export interface DemoEvent extends MarketEvent {
  start: string;
  end: string;
  timezone: string;
}
export interface Fill {
  shares: number;
  cost: number;
  expenses: number;
  total: number;
  vwap: number | null;
  filled_fraction: number;
}
export interface Position extends Fill {
  market_id: string;
  label: string;
  side: 'YES' | 'NO';
  probability: number;
  book_fetched_at: string | null;
  mc_standard_error: number;
  token_id: string | null;
  expected_profit: number | null;
  roi: number | null;
  conservative_profit: number | null;
  edge: number | null;
  signal: boolean;
  reasons: string[];
  fees_enabled: boolean;
}
export interface Backtest {
  days: number;
  mae: number | null;
  coverage80: number | null;
  results: { date: string; actual: number; prediction: number; low: number; high: number }[];
}
export interface ActivityOutlook {
  start: string;
  end: string;
  expected: number;
  probability_any: number;
  low: number;
  high: number;
}
export interface ActivityProfile {
  timezone: string;
  current_weekday: number;
  as_of: string;
  history_end: string;
  training_days: number;
  effective_days: number;
  fresh: boolean;
  warnings: string[];
  hourly: number[];
  weekdays: {
    weekday: number;
    expected: number;
    days: number;
    quiet: ActivityProfile['quiet'];
    peak: ActivityProfile['peak'];
    hours: { hour: number; expected: number; observed_hours: number }[];
  }[];
  quiet: { start_hour: number; end_hour: number; hours: number; mean_per_hour: number };
  peak: ActivityProfile['quiet'];
  trend: {
    recent_mean: number;
    previous_mean: number;
    change_ratio: number | null;
    start: string;
    midpoint: string;
    end: string;
  } | null;
  next_three_hours: ActivityOutlook;
  upcoming: ActivityOutlook[];
  samples: number;
}
export interface ForecastSummary {
  activity?: ActivityProfile;
  current_count: number;
  cutoff: string;
  mean: number;
  median: number;
  low: number;
  high: number;
  training_days: number;
  daily_mean: number;
  dispersion: number;
  daily: { date: string; count: number }[];
  hourly_pattern: number[];
  histogram: { from: number; to: number; probability: number }[];
  warnings: string[];
  fresh: boolean;
  timezone: string;
  samples: number;
  backtest: Backtest;
}
export interface ForecastOutput {
  draws: Float64Array;
  result: ForecastSummary;
}
export interface Analysis extends ForecastSummary {
  handle?: string;
  dataset: Dataset;
  sources: string[];
  start: string;
  end: string;
  generated_at: string;
  positions: Position[];
  event: MarketEvent | null;
  tracker?: TrackerReport;
}
export interface AnalyzeRequest {
  handle?: string;
  dataset: Dataset;
  event_url: string;
  start: string;
  end: string;
  timezone: string;
  budget: number;
  expense_bps: number;
  safety_pp: number;
  rules_confirmed: boolean;
}
export interface CollectRequest {
  handle?: string;
  source: 'x' | 'xtracker';
  mode: 'archive' | 'timeline';
  days: number;
  include_replies: boolean;
  include_reposts: boolean;
  event_url?: string;
}
export interface Collection {
  rows: HourRow[];
  posts: number;
  start: string;
  end: string;
  notice: string;
  tracker?: TrackerReport;
}
export type CollectionPreview = Omit<Collection, 'rows'> & { preview_id: string; hours: number };
export interface DataStatus {
  hours: number;
  posts: number;
  sources: string[];
  start: string | null;
  end: string | null;
}
export interface Status {
  handle?: string;
  live: DataStatus;
  demo: DataStatus;
  xtracker: DataStatus;
  x_api: { credentials_present: boolean };
}
export interface CounterAnchor {
  count: number;
  as_of: number;
}
export interface TrackerReport {
  handle?: string;
  tracking_id: string;
  slug: string;
  title: string;
  start: string;
  end: string;
  local_start: string;
  local_end: string;
  as_of: string;
  count: number;
  completed_count: number;
  last_sync: string | null;
  last_sync_error: string | null;
  sync_ok: boolean;
  verified: boolean;
  warnings: string[];
  export_records?: number;
  history_hours?: number;
}
