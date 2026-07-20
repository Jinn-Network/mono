/**
 * The bridge's verdict-row source (spec/2026-07-06-distillation-v1.md §8, D10).
 *
 * Reads swe-rebench-v2 verdicts from the Ponder indexer's GraphQL — BOTH
 * polarities (D10): evaluator-confirmed passes (→ pattern-eligible) and
 * evaluator-confirmed failures (→ lesson-eligible) — and returns them as
 * `AttemptRef[]` for `bridgeAttempts()`.
 *
 * A single paged GraphQL query over `verdictEnvelopeMetas`:
 *   - filtered to swe-rebench-v2 / enriched-ok / non-empty instanceId;
 *   - keep only PASS and FAIL polarities (INVALID / INDETERMINATE / UNKNOWN are
 *     noise, not lessons — dropped, as is any actualPassed/verdict disagreement);
 *   - carry each verdict row's own `manifestCid` as `verdictManifestCid` — the
 *     entry point of the VERIFIED verdict→solution join done by
 *     `bridge-fetch-evidence.ts` (verdict envelope → task doc →
 *     authoritative verdict → attempt tuple → attemptEnvelopeMeta → solution
 *     envelope patch).
 *
 * The predecessor's `attemptEnvelopeMeta(requestId=verdict.requestId)` join is
 * gone: probed live (see client/scripts/distill-run-live.ts), that key does not
 * match, so the join returned empty. The real link runs through the task doc's
 * chain-indexed verdict/attempt tuple, resolved lazily in the evidence fetcher.
 *
 * I/O is injected (`fetchImpl`) so the module is unit-testable without a live
 * indexer, mirroring `queryCaptureMeta` in ./consume.ts.
 */

import type { AttemptRef } from './bridge.js';

// ── GraphQL query string ──────────────────────────────────────────────────────

/**
 * Paged verdict rows for swe-rebench-v2. Filters mirror
 * INSTANCE_SUCCESS_COUNTS_QUERY in http.ts, minus the `actualPassed: true`
 * pin — we source both polarities, so polarity is decided client-side from
 * `actualPassed` + `evaluatorVerdict`. Each row carries its own `manifestCid`
 * (the verdict envelope CID) — the entry point of the verdict→solution join.
 */
const VERDICTS_QUERY = `
query BridgeVerdicts($limit: Int!, $after: String) {
  verdictEnvelopeMetas(
    where: {
      solverType_starts_with: "swe-rebench-v2",
      enrichmentStatus: "ok",
      instanceId_not: ""
    },
    limit: $limit,
    after: $after,
    orderBy: "enrichedAtBlock",
    orderDirection: "asc"
  ) {
    items {
      requestId
      chainId
      instanceId
      actualPassed
      evaluatorVerdict
      manifestCid
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
`;

// ── GraphQL response types ────────────────────────────────────────────────────

interface GqlResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

interface VerdictRow {
  requestId: string;
  chainId: number;
  instanceId: string;
  actualPassed: boolean;
  evaluatorVerdict: string;
  manifestCid: string;
}

interface VerdictsPage {
  verdictEnvelopeMetas: {
    items: VerdictRow[];
    pageInfo?: { hasNextPage: boolean; endCursor: string | null };
  };
}

// ── Constants ──────────────────────────────────────────────────────────────────

/** Ponder caps plural-query `limit` at 1000. */
const PAGE_LIMIT = 1000;
/** Bound on pages walked — 20 × 1000 rows is far beyond any realistic slate. */
const MAX_PAGES = 20;
/** Default cap on returned refs when the caller does not pass `limit`. */
const DEFAULT_LIMIT = 500;

// ── Helpers ─────────────────────────────────────────────────────────────────────

async function postGql<T>(
  url: string,
  fetchImpl: typeof fetch,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    throw new Error(`verdict-source GraphQL HTTP ${response.status} ${response.statusText}`);
  }
  const json = (await response.json()) as GqlResponse<T>;
  if (json.errors?.length) {
    throw new Error(`verdict-source GraphQL error: ${json.errors.map((e) => e.message ?? 'unknown').join('; ')}`);
  }
  if (!json.data) {
    throw new Error('verdict-source GraphQL response missing data field');
  }
  return json.data;
}

/**
 * Map an enriched verdict row to a polarity, or `null` when it is neither a
 * clean PASS nor a clean FAIL (INVALID / INDETERMINATE / UNKNOWN, or any
 * disagreement between `actualPassed` and `evaluatorVerdict`) — those are noise,
 * not lessons, and are dropped.
 */
function polarityOf(row: VerdictRow): 'pass' | 'fail' | null {
  if (row.actualPassed === true && row.evaluatorVerdict === 'PASS') return 'pass';
  if (row.actualPassed === false && row.evaluatorVerdict === 'FAIL') return 'fail';
  return null;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export interface VerdictSourceOptions {
  /** Ponder GraphQL endpoint, e.g. https://my-indexer.example/graphql */
  graphqlUrl: string;
  /** Injectable fetch (tests). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export interface VerdictSource {
  /** List swe-rebench-v2 verdict rows (both polarities) as `AttemptRef[]`. */
  list(args?: { limit?: number }): Promise<AttemptRef[]>;
}

/**
 * Build a verdict-row source over a Ponder GraphQL endpoint. No live I/O until
 * `list()` is called.
 */
export function createVerdictSource(opts: VerdictSourceOptions): VerdictSource {
  const url = opts.graphqlUrl.endsWith('/graphql') ? opts.graphqlUrl : `${opts.graphqlUrl}/graphql`;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error('No fetch implementation available; pass fetchImpl in options');
  }

  async function list(args: { limit?: number } = {}): Promise<AttemptRef[]> {
    const limit = Math.max(1, args.limit ?? DEFAULT_LIMIT);

    // Page verdict rows (both polarities), dropping non-PASS/FAIL and any row
    // missing its verdict `manifestCid` (no join entry point → nothing to bridge).
    const refs: AttemptRef[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const data: VerdictsPage = await postGql<VerdictsPage>(url, fetchImpl, VERDICTS_QUERY, {
        limit: PAGE_LIMIT,
        after: cursor,
      });
      for (const row of data.verdictEnvelopeMetas?.items ?? []) {
        const polarity = polarityOf(row);
        if (polarity === null) continue; // INVALID/INDETERMINATE/UNKNOWN — dropped.
        if (!row.manifestCid) continue; // no verdict envelope CID → no join entry point.
        refs.push({
          requestId: row.requestId,
          chainId: row.chainId,
          instanceId: row.instanceId,
          // The attempt-join that once supplied the model is gone; the bridge
          // falls back to 'unknown' when model is empty.
          model: '',
          // Filled by the evidence fetcher's authoritative join off verdictManifestCid.
          manifestCid: '',
          polarity,
          verdictManifestCid: row.manifestCid,
        });
        if (refs.length >= limit) break;
      }
      if (refs.length >= limit) break;
      const pageInfo: VerdictsPage['verdictEnvelopeMetas']['pageInfo'] = data.verdictEnvelopeMetas?.pageInfo;
      if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
      cursor = pageInfo.endCursor;
    }
    return refs;
  }

  return { list };
}
