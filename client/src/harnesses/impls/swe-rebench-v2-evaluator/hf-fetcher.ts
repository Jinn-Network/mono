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
   * Per-page retry backoff schedule (ms) for transient HTTP 5xx or network
   * errors. Default: [200, 800, 3200]. Each entry is the delay before the
   * Nth retry; an empty array disables retries. Non-5xx responses (e.g.
   * 404) are not retried — they're not transient.
   */
  retryBackoffMs?: number[];
  /** Minimum spacing between HF HTTP requests. Defaults to 250ms. */
  minRequestIntervalMs?: number;
  /** Sleep implementation. Defaults to the shared tx-retry sleep (allows test injection). */
  sleep?: (ms: number) => Promise<void>;
  /** Shared request limiter. Defaults to the module-level HF limiter. */
  limiter?: HfRequestLimiter;
}

const DEFAULT_BASE_URL = 'https://datasets-server.huggingface.co/rows';
const DEFAULT_RETRY_BACKOFF_MS = [200, 800, 3200];
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 250;

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

const sharedHfRequestLimiter = new SharedHfRequestLimiter();

export class HttpHfFetcher implements HfFetcher {
  private readonly baseUrl: string;
  private readonly pageSize: number;
  private readonly maxRows: number;
  private readonly fetchImpl: typeof fetch;
  private readonly retryBackoffMs: number[];
  private readonly minRequestIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly limiter: HfRequestLimiter;

  constructor(opts: HttpHfFetcherOptions = {}) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.pageSize = Math.min(opts.pageSize ?? 100, 100);
    this.maxRows = opts.maxRows ?? 1000;
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
    this.retryBackoffMs = opts.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    this.minRequestIntervalMs = opts.minRequestIntervalMs ?? DEFAULT_MIN_REQUEST_INTERVAL_MS;
    this.sleep = opts.sleep ?? defaultSleep;
    this.limiter = opts.limiter ?? sharedHfRequestLimiter;
  }

  private async fetchWithRetry(url: string): Promise<Response> {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= this.retryBackoffMs.length; attempt += 1) {
      let retryAfterMs: number | undefined;
      try {
        const res = await this.limiter.schedule(
          () => this.fetchImpl(url),
          { minRequestIntervalMs: this.minRequestIntervalMs, sleep: this.sleep },
        );
        if (res.ok || !isRetryableStatus(res.status)) return res;
        if (attempt >= this.retryBackoffMs.length) return res;
        retryAfterMs = retryAfterHeaderMs(res.headers.get('Retry-After'));
        lastErr = new Error(`HF returned ${res.status}`);
      } catch (err) {
        lastErr = err;
        if (attempt >= this.retryBackoffMs.length) {
          if (lastErr instanceof Error) throw lastErr;
          throw new Error('HF fetch failed after retries');
        }
      }
      if (attempt < this.retryBackoffMs.length) {
        await this.sleep(retryAfterMs ?? this.retryBackoffMs[attempt]);
      }
    }
    if (lastErr instanceof Error) throw lastErr;
    throw new Error('HF fetch failed after retries');
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

      const res = await this.fetchWithRetry(url.toString());
      if (!res.ok) {
        throw new Error(
          `HF datasets-server returned ${res.status} for ${args.hf_dataset}/${args.hf_split}`,
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
