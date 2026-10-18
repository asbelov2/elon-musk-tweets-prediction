import { demoHours } from '../../src/server/demo.js';
import { runForecast } from '../../src/server/forecast-runner.js';
import { DAY, hour } from '../../src/server/time.js';

const now = Date.now(),
  cutoff = hour(now);
const { draws, result } = await runForecast({
  rows: demoHours(now),
  start: cutoff - 3 * DAY,
  end: cutoff + DAY,
  timezone: 'UTC',
  now,
});
if (draws.length !== 20_000 || result.mean < result.current_count)
  throw new Error('Invalid worker result in watch mode');
console.log('FORECAST_WATCH_OK');
