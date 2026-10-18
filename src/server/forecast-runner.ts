import { Worker } from 'node:worker_threads';
import type { ForecastOutput } from '../shared/types.js';
import type { ForecastJob, WorkerResponse } from './forecast-worker.js';
import { AppError } from './errors.js';

let active = 0;
export async function runForecast(job: ForecastJob): Promise<ForecastOutput> {
  if (active >= 2)
    throw new AppError('Уже выполняются два расчёта. Повторите запрос после их завершения.', 429);
  active++;
  try {
    return await new Promise<ForecastOutput>((resolve, reject) => {
      const worker = new Worker(new URL('./forecast-worker.js', import.meta.url), {
        workerData: job,
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      });
      let settled = false;
      const timer = setTimeout(() => {
        fail(new AppError('Превышено время расчёта. Повторите запрос.', 503));
        void worker.terminate();
      }, 30_000);
      function fail(error: Error): void {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      }
      worker.on('message', (value: unknown) => {
        // Node --watch also sends module-tracking messages through this port.
        if (
          typeof value !== 'object' ||
          value === null ||
          !('kind' in value) ||
          value.kind !== 'tweetscope:forecast-result'
        )
          return;
        const message = value as WorkerResponse;
        if (settled) return;
        if (!message.ok) {
          fail(new AppError(message.message, message.statusCode));
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(message.output);
      });
      worker.once('error', () =>
        fail(new AppError('Не удалось выполнить расчёт в рабочем потоке', 500)),
      );
      worker.once('exit', () => {
        if (!settled) fail(new AppError('Рабочий поток завершился без результата', 500));
      });
    });
  } finally {
    active--;
  }
}
