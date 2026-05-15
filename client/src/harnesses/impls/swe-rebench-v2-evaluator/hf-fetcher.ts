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
}

const DEFAULT_BASE_URL = 'https://datasets-server.huggingface.co/rows';
const DEFAULT_RETRY_BACKOFF_MS = [200, 800, 3200];

export class HttpHfFetcher implements HfFetcher {
  private readonly baseUrl: string;
  private readonly pageSize: number;
  private readonly maxRows: number;
  private readonly fetchImpl: typeof fetch;
  private readonly retryBackoffMs: number[];

  constructor(opts: HttpHfFetcherOptions = {}) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.pageSize = Math.min(opts.pageSize ?? 100, 100);
    this.maxRows = opts.maxRows ?? 1000;
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
    this.retryBackoffMs = opts.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  }

  private async fetchWithRetry(url: string): Promise<Response> {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= this.retryBackoffMs.length; attempt += 1) {
      try {
        const res = await this.fetchImpl(url);
        if (res.ok || (res.status >= 400 && res.status < 500)) return res;
        // 5xx → retry-eligible
        lastErr = new Error(`HF returned ${res.status}`);
      } catch (err) {
        lastErr = err;
      }
      if (attempt < this.retryBackoffMs.length) {
        await new Promise((r) => setTimeout(r, this.retryBackoffMs[attempt]));
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
