/**
 * KV-backed sliding-window rate limiter for public endpoints.
 *
 * Keyed on CF-Connecting-IP (set by Cloudflare's edge; absent in dev, where
 * every request is treated as a distinct IP via a fallback key).
 *
 * Usage: call checkRateLimit() at the top of a handler. Returns a 429 Response
 * on breach or null to continue.
 */

import type { Context } from 'hono';
import type { Env } from '../types';

interface RateLimitOptions {
  /** KV key prefix, e.g. "rl:reserve" */
  prefix: string;
  /** Maximum requests allowed in the window */
  limit: number;
  /** Window length in seconds */
  windowSeconds: number;
}

/**
 * Returns a 429 Response if the IP has exceeded the rate limit, or null to
 * allow the request through. Increments the counter regardless.
 */
export async function checkRateLimit(
  c: Context<{ Bindings: Env }>,
  opts: RateLimitOptions,
): Promise<Response | null> {
  const ip = c.req.raw.headers.get('CF-Connecting-IP') ?? 'dev';
  const window = Math.floor(Date.now() / (opts.windowSeconds * 1000));
  const key = `${opts.prefix}:${ip}:${window}`;

  const raw = await c.env.KV.get(key);
  const count = raw ? parseInt(raw, 10) : 0;

  if (count >= opts.limit) {
    return c.json(
      { status: 'rate_limited', message: 'Too many requests — please try again shortly' },
      429,
    );
  }

  // Increment counter; TTL = 2× window so the key outlasts the window it covers.
  await c.env.KV.put(key, String(count + 1), { expirationTtl: opts.windowSeconds * 2 });
  return null;
}
