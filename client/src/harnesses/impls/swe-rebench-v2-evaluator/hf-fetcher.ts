/**
 * HfFetcher implementation that resolves a single HF dataset row by
 * `(dataset, split, instance_id)` via the public HF datasets-server.
 *
 * The datasets-server `/rows` endpoint paginates with `offset` + `length`
 * (max length is 100 per request). Splits are typically <250 rows, so we
 * walk pages until either the `instance_id` is found or we hit a hard
 * cap (default 1000 rows = 10 pages). The harness fails loud rather than
 * silently grading against a missing instance.
 */

import { sleep as defaultSleep } from '../../../tx-retry.js';
import type { HfFetcher, HfRow } from './index.js';

export interface HttpHfFetcherOptions {
  /** Override the default datasets-server base URL. */
  baseUrl?: string;
  /** Page size (max 100 per HF API). Defaults to 100. */
  pageSize?: number;
  /** Hard cap on rows scanned per lookup. Defaults to 1000. */
  maxRows?: number;
  /** Fetch implementation. Defaults to global fetch (allows test injection). */
  fetchImpl?: typeof fetch;
  /**
   * Per-page retry backoff schedule (ms) for transient HTTP 408/429/5xx
   * responses. Default: {@link DEFAULT_RETRY_BACKOFF_MS}
   * (`[1000, 2000, 4000, 8000]` — see issue #578 for the rationale; HF's
   * 429 wave was longer-lived than the prior 200/800/3200 schedule could
   * clear). Each entry is the delay before the Nth retry; an empty array
   * disables retries. Non-retryable 4xx (e.g. 404) is not retried.
   */
  retryBackoffMs?: number[];
  /** Minimum spacing between HF HTTP requests. Defaults to {@link DEFAULT_MIN_REQUEST_INTERVAL_MS}. */
  minRequestIntervalMs?: number;
  /** Sleep implementation. Defaults to the shared tx-retry sleep (allows test injection). */
  sleep?: (ms: number) => Promise<void>;
  /** Shared request limiter. Defaults to the module-level HF limiter. */
  limiter?: HfRequestLimiter;
  /** Random source for jittered backoff. Defaults to `Math.random` (test injection). */
  random?: () => number;
}

const DEFAULT_BASE_URL = 'https://datasets-server.huggingface.co/rows';
/**
 * Per-attempt backoff schedule for HF datasets-server fetches. Four retries
 * (5 total attempts), jittered ±33%, max worst-case ≈15s extra latency per
 * failing instance. Tuned for HF's 429 envelope per issue #578.
 */
export const DEFAULT_RETRY_BACKOFF_MS: readonly number[] = [1000, 2000, 4000, 8000];
/**
 * Process-wide floor on the spacing between HF HTTP requests. Raised from
 * 250ms after issue #578 — 250ms × 4 retries was insufficient to clear the
 * 429 wave when validating ~700 instances in one pass. This is the AC3
 * concurrency-cap surface: the shared limiter serialises requests at this
 * granularity across the whole process. Tune via {@link HttpHfFetcherOptions.minRequestIntervalMs}
 * or {@link FetchHfWithRetryOptions.minRequestIntervalMs}; see the design note
 * at `docs/superpowers/specs/2026-05-26-issue-578-hf-429-retry-design.md`.
 */
export const DEFAULT_MIN_REQUEST_INTERVAL_MS = 500;
const JITTER_FACTOR = 0.33; // ±33% symmetric uniform jitter

export interface HfRequestLimiter {
  schedule<T>(fn: () => Promise<T>, opts: {
    minRequestIntervalMs: number;
    sleep: (ms: number) => Promise<void>;
  }): Promise<T>;
}

class SharedHfRequestLimiter implements HfRequestLimiter {
  private tail: Promise<void> = Promise.resolve();
  private lastStartedAt = 0;

  schedule<T>(fn: () => Promise<T>, opts: {
    minRequestIntervalMs: number;
    sleep: (ms: number) => Promise<void>;
  }): Promise<T> {
    const run = this.tail.catch(() => undefined).then(async () => {
      const elapsed = Date.now() - this.lastStartedAt;
      const waitMs = Math.max(0, opts.minRequestIntervalMs - elapsed);
      if (waitMs > 0) {
        await opts.sleep(waitMs);
      }
      this.lastStartedAt = Date.now();
      return fn();
    });
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}

/**
 * Module-level shared request limiter. Serialises HF requests across the
 * whole process (every callsite that uses {@link fetchHfWithRetry} routes
 * through this instance by default). AC3 from issue #578: this plus the
 * raised {@link DEFAULT_MIN_REQUEST_INTERVAL_MS} *is* the concurrency-cap
 * knob — no separate parallel-request cap is exposed.
 */
export const sharedHfRequestLimiter = new SharedHfRequestLimiter();

export interface FetchHfWithRetryOptions {
  /** Fetch implementation. Defaults to `globalThis.fetch` bound to `globalThis`. */
  fetchImpl?: typeof fetch;
  /** Per-attempt backoff schedule (ms). Defaults to {@link DEFAULT_RETRY_BACKOFF_MS}. */
  retryBackoffMs?: readonly number[];
  /** Minimum spacing between requests. Defaults to {@link DEFAULT_MIN_REQUEST_INTERVAL_MS}. */
  minRequestIntervalMs?: number;
  /** Sleep implementation. Defaults to the shared tx-retry sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Shared request limiter. Defaults to {@link sharedHfRequestLimiter}. */
  limiter?: HfRequestLimiter;
  /** Random source for jittered backoff. Defaults to `Math.random` (test injection). */
  random?: () => number;
}

/**
 * Shared retry helper for HF datasets-server requests.
 *
 * - Retries on `408 | 429 | 5xx` per {@link isRetryableStatus}.
 * - Sleeps the smaller of the `Retry-After` header (when present) or a
 *   jittered backoff drawn from `retryBackoffMs`.
 * - Routes every attempt through the shared {@link HfRequestLimiter} so the
 *   process-wide min-interval is honoured.
 * - On retry exhaustion against a non-OK response, throws
 *   `Object.assign(new Error('HF returned <status>'), { httpStatus })` so
 *   callers can branch on the status code (issue #578: the validated-pool
 *   pipeline keys off `httpStatus === 429` to classify transient failures).
 *
 * Non-retryable responses (e.g. 404) are returned to the caller untouched —
 * caller decides how to fail.
 */
export async function fetchHfWithRetry(
  url: string,
  opts: FetchHfWithRetryOptions = {},
): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  const retryBackoffMs = opts.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  const minRequestIntervalMs = opts.minRequestIntervalMs ?? DEFAULT_MIN_REQUEST_INTERVAL_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const limiter = opts.limiter ?? sharedHfRequestLimiter;
  const random = opts.random ?? Math.random;

  for (let attempt = 0; attempt <= retryBackoffMs.length; attempt += 1) {
    let retryAfterMs: number | undefined;
    try {
      const res = await limiter.schedule(
        () => fetchImpl(url),
        { minRequestIntervalMs, sleep },
      );
      if (res.ok || !isRetryableStatus(res.status)) return res;
      if (attempt >= retryBackoffMs.length) {
        throw Object.assign(new Error(`HF returned ${res.status}`), { httpStatus: res.status });
      }
      retryAfterMs = retryAfterHeaderMs(res.headers.get('Retry-After'));
    } catch (err) {
      // On the final attempt, surface the error (network failure or the
      // synthetic `httpStatus`-tagged throw above). Otherwise fall through
      // to the backoff sleep and retry.
      if (attempt >= retryBackoffMs.length) throw err;
    }
    const base = retryBackoffMs[attempt] ?? 0;
    const scheduledDelayMs = withJitter(base, random);
    await sleep(
      retryAfterMs === undefined
        ? scheduledDelayMs
        : Math.min(retryAfterMs, scheduledDelayMs),
    );
  }
  // Unreachable: the loop returns or throws on every iteration. Kept to
  // satisfy TS control-flow analysis.
  throw new Error('HF fetch failed after retries');
}

function withJitter(baseMs: number, random: () => number): number {
  const jitter = (random() * 2 - 1) * JITTER_FACTOR;
  return Math.round(baseMs * (1 + jitter));
}

export class HttpHfFetcher implements HfFetcher {
  private readonly baseUrl: string;
  private readonly pageSize: number;
  private readonly maxRows: number;
  private readonly fetchImpl: typeof fetch;
  private readonly retryBackoffMs: readonly number[];
  private readonly minRequestIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly limiter: HfRequestLimiter;
  private readonly random: () => number;

  constructor(opts: HttpHfFetcherOptions = {}) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.pageSize = Math.min(opts.pageSize ?? 100, 100);
    this.maxRows = opts.maxRows ?? 1000;
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
    this.retryBackoffMs = opts.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    this.minRequestIntervalMs = opts.minRequestIntervalMs ?? DEFAULT_MIN_REQUEST_INTERVAL_MS;
    this.sleep = opts.sleep ?? defaultSleep;
    this.limiter = opts.limiter ?? sharedHfRequestLimiter;
    this.random = opts.random ?? Math.random;
  }

  private async fetchWithRetry(url: string): Promise<Response> {
    return fetchHfWithRetry(url, {
      fetchImpl: this.fetchImpl,
      retryBackoffMs: this.retryBackoffMs,
      minRequestIntervalMs: this.minRequestIntervalMs,
      sleep: this.sleep,
      limiter: this.limiter,
      random: this.random,
    });
  }

  async fetchTaskRow(args: {
    hf_dataset: string;
    hf_split: string;
    instance_id: string;
  }): Promise<HfRow> {
    let offset = 0;
    while (offset < this.maxRows) {
      const url = new URL(this.baseUrl);
      url.searchParams.set('dataset', args.hf_dataset);
      url.searchParams.set('config', 'default');
      url.searchParams.set('split', args.hf_split);
      url.searchParams.set('offset', String(offset));
      url.searchParams.set('length', String(this.pageSize));

      let res: Response;
      try {
        res = await this.fetchWithRetry(url.toString());
      } catch (err) {
        // fetchHfWithRetry surfaces `httpStatus` on exhausted-retry errors.
        // Re-shape the message to the dataset/split form callers expect, but
        // preserve the `httpStatus` property so the validated-pool catch
        // block can branch on it (issue #578).
        const httpStatus = (err as { httpStatus?: number } | null)?.httpStatus;
        if (typeof httpStatus === 'number') {
          throw Object.assign(
            new Error(`HF datasets-server returned ${httpStatus} for ${args.hf_dataset}/${args.hf_split}`),
            { httpStatus },
          );
        }
        throw err;
      }
      if (!res.ok) {
        throw Object.assign(
          new Error(`HF datasets-server returned ${res.status} for ${args.hf_dataset}/${args.hf_split}`),
          { httpStatus: res.status },
        );
      }
      const body = (await res.json()) as { rows?: Array<{ row?: Record<string, unknown> }> };
      const rows = (body.rows ?? []).map((r) => r.row ?? {});
      if (rows.length === 0) break;

      for (const row of rows) {
        if (row['instance_id'] === args.instance_id) {
          return rowToHfRow(row, args.instance_id);
        }
      }

      if (rows.length < this.pageSize) break; // exhausted
      offset += rows.length;
    }
    throw new Error(
      `instance_id ${args.instance_id} not found in ${args.hf_dataset}/${args.hf_split} ` +
        `(scanned up to ${this.maxRows} rows)`,
    );
  }
}

function rowToHfRow(row: Record<string, unknown>, instance_id: string): HfRow {
  const image_name = stringField(row['image_name']);
  if (!image_name) {
    throw new Error(`HF row for ${instance_id} missing image_name`);
  }
  const repo = stringField(row['repo']);
  if (!repo) {
    throw new Error(`HF row for ${instance_id} missing repo`);
  }
  const installConfig = (row['install_config'] ?? {}) as Record<string, unknown>;
  const install = installConfig['install'];
  const test_cmd = installConfig['test_cmd'];
  const log_parser = installConfig['log_parser'];
  return {
    instance_id,
    repo,
    image_name,
    FAIL_TO_PASS: arrayOfStrings(row['FAIL_TO_PASS']),
    PASS_TO_PASS: arrayOfStrings(row['PASS_TO_PASS']),
    test_patch: stringField(row['test_patch']) ?? '',
    install_config: {
      install:
        typeof install === 'string'
          ? install
          : Array.isArray(install)
            ? (install as string[])
            : undefined,
      test_cmd:
        typeof test_cmd === 'string'
          ? test_cmd
          : Array.isArray(test_cmd)
            ? (test_cmd as string[])
            : '',
      log_parser: typeof log_parser === 'string' ? log_parser : '',
    },
  };
}

function stringField(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function arrayOfStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((s): s is string => typeof s === 'string');
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function retryAfterHeaderMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}
