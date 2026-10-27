import { createHash, timingSafeEqual } from 'node:crypto';
import type { Credentials } from './x-api.js';

export function webConfig(env: Credentials) {
  const production = env.NODE_ENV === 'production';
  const writeAccess = env.WRITE_ACCESS ?? 'public';
  if (writeAccess !== 'admin' && writeAccess !== 'public')
    throw new Error('WRITE_ACCESS must be admin or public');
  let publicOrigin: string | undefined;
  if (env.PUBLIC_URL) {
    let url: URL;
    try {
      url = new URL(env.PUBLIC_URL);
    } catch {
      throw new Error('PUBLIC_URL must be an absolute HTTP(S) origin');
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error(
        'PUBLIC_URL must contain only the HTTP(S) scheme and hostname, without a path or credentials',
      );
    publicOrigin = url.origin;
  }
  if (production && !publicOrigin)
    throw new Error('Set PUBLIC_URL to the exact public address, including https://');
  const username = env.ADMIN_USERNAME ?? 'admin';
  const password = env.ADMIN_PASSWORD;
  if (username.includes(':') || !username)
    throw new Error('ADMIN_USERNAME must be nonempty and cannot contain a colon');
  if (writeAccess === 'admin' && (!password || password.length < 16))
    throw new Error('Set ADMIN_PASSWORD to a password of at least 16 characters');
  const digest = password ? createHash('sha256').update(`${username}:${password}`).digest() : null;
  const hops = Number(env.TRUST_PROXY_HOPS ?? 0);
  if (!Number.isInteger(hops) || hops < 0 || hops > 5)
    throw new Error('TRUST_PROXY_HOPS must be an integer from 0 to 5');
  const rateLimit = Number(env.HTTP_RATE_LIMIT ?? 120);
  if (!Number.isInteger(rateLimit) || rateLimit < 1 || rateLimit > 10000)
    throw new Error('HTTP_RATE_LIMIT must be from 1 to 10000');
  return {
    production,
    writeAccess,
    publicOrigin,
    trustProxy: hops > 0 ? (_address: string, hop: number) => hop < hops : false,
    rateLimit,
    rateLimitEnabled: production || env.HTTP_RATE_LIMIT !== undefined,
    isAdmin(authorization?: string): boolean {
      if (!digest || !authorization || !/^Basic [a-zA-Z0-9+/]+={0,2}$/i.test(authorization))
        return false;
      const candidate = createHash('sha256')
        .update(Buffer.from(authorization.slice(6), 'base64'))
        .digest();
      return timingSafeEqual(digest, candidate);
    },
  };
}
