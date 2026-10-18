export type Dataset = 'live' | 'demo';
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
export interface ForecastSummary {
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
  dataset: Dataset;
  sources: string[];
  start: string;
  end: string;
  generated_at: string;
  positions: Position[];
  event: MarketEvent | null;
}
export interface AnalyzeRequest {
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
  source: 'x' | 'xtracker';
  mode: 'archive' | 'timeline';
  days: number;
  include_replies: boolean;
  include_reposts: boolean;
}
export interface Collection {
  rows: HourRow[];
  posts: number;
  start: string;
  end: string;
  notice: string;
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
  live: DataStatus;
  demo: DataStatus;
  x_api: { credentials_present: boolean };
}
