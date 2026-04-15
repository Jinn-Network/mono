/**
 * Rate Limiting for Credential Bridge
 *
 * Implements sliding window rate limiting per (address, provider) pair.
 * Uses Redis sorted sets for accurate window tracking.
 *
 * Default: 10 requests per minute per (address, provider)
 */

import { getRedis } from './redis.js';
import { normalizeAddress } from './types.js';

const RATE_LIMIT = 10;           // requests per window
const WINDOW_SECONDS = 60;       // 1 minute window
const KEY_PREFIX = 'cred-ratelimit:';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;  // Unix timestamp
}

/**
 * Check if request is within rate limits.
 * Uses sliding window algorithm with Redis sorted sets.
 *
 * @returns RateLimitResult with allowed status and headers info
 */
export async function checkRateLimit(
  address: string,
  provider: string
): Promise<RateLimitResult> {
  const redis = getRedis();
  if (!redis) {
    // Dev mode: no rate limiting
    return { allowed: true, remaining: RATE_LIMIT, resetAt: 0 };
  }

  const key = `${KEY_PREFIX}${normalizeAddress(address)}:${provider.toLowerCase()}`;
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - WINDOW_SECONDS;

  try {
    // Sliding window using sorted set:
    // 1. Remove entries older than window
    // 2. Add current request timestamp
    // 3. Count requests in window
    // 4. Set TTL for cleanup
    const multi = redis.multi();
    multi.zremrangebyscore(key, 0, windowStart);
    multi.zadd(key, now, `${now}:${Math.random()}`);
    multi.zcard(key);
    multi.expire(key, WINDOW_SECONDS);

    const results = await multi.exec();
    const count = (results?.[2]?.[1] as number) || 0;

    const remaining = Math.max(0, RATE_LIMIT - count);
    const resetAt = now + WINDOW_SECONDS;

    return {
      allowed: count <= RATE_LIMIT,
      remaining,
      resetAt,
    };
  } catch (err) {
    console.error('[credential-bridge] Rate limit check failed — denying request (fail-closed):', err);
    return { allowed: false, remaining: 0, resetAt: 0 };
  }
}

/**
 * Generate rate limit response headers.
 */
export function getRateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'X-RateLimit-Limit': String(RATE_LIMIT),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(result.resetAt),
  };
}
