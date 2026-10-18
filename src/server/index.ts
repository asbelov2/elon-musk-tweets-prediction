import { createApp } from './app.js';
import { closeRemoteTransport } from './http.js';

const app = await createApp({ logger: true });
const port = Number(process.env.PORT ?? 8000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT must be an integer from 1 to 65535');
await app.listen({ host: process.env.TWEETSCOPE_HOST ?? '127.0.0.1', port });
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void app
      .close()
      .then(() => closeRemoteTransport())
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
