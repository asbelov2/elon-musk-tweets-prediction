import { parentPort, workerData } from 'node:worker_threads';
import type { CounterAnchor, ForecastOutput, HourRow } from '../shared/types.js';
import { AppError, errorMessage } from './errors.js';
import { forecast } from './model.js';

export interface ForecastJob {
  rows: HourRow[];
  start: number;
  end: number;
  timezone: string;
  now: number;
  anchor?: CounterAnchor;
}
export type WorkerResponse =
  | { kind: 'tweetscope:forecast-result'; ok: true; output: ForecastOutput }
  | { kind: 'tweetscope:forecast-result'; ok: false; message: string; statusCode: number };
const job = workerData as ForecastJob;
if (parentPort) {
  try {
    const output = forecast(
      new Map(job.rows),
      job.start,
      job.end,
      job.timezone,
      job.now,
      20_000,
      job.anchor,
    );
    parentPort.postMessage(
      { kind: 'tweetscope:forecast-result', ok: true, output } satisfies WorkerResponse,
      [output.draws.buffer as ArrayBuffer],
    );
  } catch (error) {
    parentPort.postMessage({
      kind: 'tweetscope:forecast-result',
      ok: false,
      message: error instanceof AppError ? errorMessage(error) : 'Ошибка статистического расчёта',
      statusCode: error instanceof AppError ? error.statusCode : 500,
    } satisfies WorkerResponse);
  } finally {
    parentPort.close();
  }
}
