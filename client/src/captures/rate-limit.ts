export interface CaptureRateLimitDefaults {
  operatorPerHour: number;
  operatorBurst: number;
  repoPerHour: number;
}

export const DEFAULT_CAPTURE_RATE_LIMITS: CaptureRateLimitDefaults = {
  operatorPerHour: 10,
  operatorBurst: 30,
  repoPerHour: 5,
};

export interface CaptureRateLimitInput {
  operator: string;
  repo?: string | null;
  now?: number;
}

export interface CaptureRateLimitResult {
  allowed: boolean;
  reason?: 'operator_rate_limit' | 'repo_rate_limit';
  retryAfterMs?: number;
}

interface BucketState {
  tokens: number;
  updatedAt: number;
}

interface BucketConfig {
  capacity: number;
  refillPerMs: number;
}

export interface CaptureRateLimiterOptions {
  limits?: Partial<CaptureRateLimitDefaults>;
  now?: () => number;
}

/**
 * Publish-time limiter for capture envelopes.
 *
 * Operator limits use a token bucket so short bursts can drain up to the
 * configured burst size while still refilling at the hourly rate. Repo limits
 * use the same model with capacity equal to the hourly repo allowance.
 */
export class CaptureRateLimiter {
  private readonly limits: CaptureRateLimitDefaults;
  private readonly now: () => number;
  private readonly operatorBuckets = new Map<string, BucketState>();
  private readonly repoBuckets = new Map<string, BucketState>();

  constructor(options: CaptureRateLimiterOptions = {}) {
    this.limits = { ...DEFAULT_CAPTURE_RATE_LIMITS, ...options.limits };
    this.now = options.now ?? (() => Date.now());
  }

  check(input: CaptureRateLimitInput): CaptureRateLimitResult {
    const at = input.now ?? this.now();
    const operatorResult = this.peek(this.operatorBuckets, input.operator, {
      capacity: this.limits.operatorBurst,
      refillPerMs: this.limits.operatorPerHour / 3_600_000,
    }, at);
    if (!operatorResult.allowed) {
      return { allowed: false, reason: 'operator_rate_limit', retryAfterMs: operatorResult.retryAfterMs };
    }

    if (input.repo) {
      const repoResult = this.peek(this.repoBuckets, input.repo, {
        capacity: this.limits.repoPerHour,
        refillPerMs: this.limits.repoPerHour / 3_600_000,
      }, at);
      if (!repoResult.allowed) {
        return { allowed: false, reason: 'repo_rate_limit', retryAfterMs: repoResult.retryAfterMs };
      }
    }

    return { allowed: true };
  }

  tryAcquire(input: CaptureRateLimitInput): CaptureRateLimitResult {
    const result = this.check(input);
    if (!result.allowed) return result;
    const at = input.now ?? this.now();
    this.consume(this.operatorBuckets, input.operator, {
      capacity: this.limits.operatorBurst,
      refillPerMs: this.limits.operatorPerHour / 3_600_000,
    }, at);
    if (input.repo) {
      this.consume(this.repoBuckets, input.repo, {
        capacity: this.limits.repoPerHour,
        refillPerMs: this.limits.repoPerHour / 3_600_000,
      }, at);
    }
    return result;
  }

  private peek(
    buckets: Map<string, BucketState>,
    key: string,
    config: BucketConfig,
    now: number,
  ): CaptureRateLimitResult {
    const bucket = this.refilled(buckets.get(key), config, now);
    if (bucket.tokens >= 1) return { allowed: true };
    const missing = 1 - bucket.tokens;
    const retryAfterMs = Math.ceil(missing / config.refillPerMs);
    return { allowed: false, retryAfterMs };
  }

  private consume(
    buckets: Map<string, BucketState>,
    key: string,
    config: BucketConfig,
    now: number,
  ): void {
    const bucket = this.refilled(buckets.get(key), config, now);
    buckets.set(key, { tokens: Math.max(0, bucket.tokens - 1), updatedAt: now });
  }

  private refilled(
    state: BucketState | undefined,
    config: BucketConfig,
    now: number,
  ): BucketState {
    if (!state) return { tokens: config.capacity, updatedAt: now };
    const elapsed = Math.max(0, now - state.updatedAt);
    const tokens = Math.min(config.capacity, state.tokens + elapsed * config.refillPerMs);
    return { tokens, updatedAt: now };
  }
}
