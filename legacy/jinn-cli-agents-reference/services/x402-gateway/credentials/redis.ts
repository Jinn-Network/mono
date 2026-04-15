/**
 * Redis Nonce Store for ERC-8128 replay protection
 *
 * Connects via REDIS_URL env var. If not set, replay checks are skipped
 * (local dev mode) and a warning is logged at startup.
 */

import Redis from 'ioredis';

const DEFAULT_NONCE_TTL_SECONDS = 300;
const KEY_PREFIX = 'cred:erc8128:nonce:';

let redis: Redis | null = null;

/**
 * Get the Redis client instance.
 * Returns null if Redis is not configured (dev mode).
 */
export function getRedis(): Redis | null {
  return redis;
}

function initRedis(): void {
  const url = process.env.REDIS_URL;
  if (!url) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[credential-bridge] CRITICAL: REDIS_URL not set in production — nonce replay protection DISABLED');
    } else {
      console.warn('[credential-bridge] REDIS_URL not set — nonce replay protection disabled (dev mode)');
    }
    return;
  }

  redis = new Redis(url, { maxRetriesPerRequest: 3 });
  redis.on('error', (err) => console.error('[credential-bridge] Redis error:', err.message));
  redis.on('connect', () => console.log('[credential-bridge] Redis connected — nonce protection ENABLED'));
}

initRedis();

/**
 * Atomic consume for ERC-8128 NonceStore.
 * Returns true when key is first seen, false on replay.
 */
export async function consumeNonceKey(key: string, ttlSeconds: number = DEFAULT_NONCE_TTL_SECONDS): Promise<boolean> {
  if (!redis) return true; // dev mode — skip replay checks
  try {
    const redisKey = `${KEY_PREFIX}${key}`;
    const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? Math.ceil(ttlSeconds) : DEFAULT_NONCE_TTL_SECONDS;
    const result = await redis.set(redisKey, '1', 'EX', ttl, 'NX');
    return result === 'OK';
  } catch (err) {
    console.error('[credential-bridge] Redis nonce consume failed:', err);
    return false; // fail closed
  }
}

export function getCredentialNonceStore(): { consume: (key: string, ttlSeconds: number) => Promise<boolean> } {
  return {
    consume: consumeNonceKey,
  };
}

/**
 * Gracefully close Redis connection.
 */
export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}
