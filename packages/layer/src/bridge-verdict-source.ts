/**
 * The bridge's verdict-row source (spec/2026-07-06-distillation-v1.md §8, D10).
 *
 * Reads swe-rebench-v2 verdicts from the Ponder indexer's GraphQL — BOTH
 * polarities (D10): evaluator-confirmed passes (→ pattern-eligible) and
 * evaluator-confirmed failures (→ lesson-eligible) — and returns them as
 * `AttemptRef[]` for `bridgeAttempts()`.
 *
 * A single paged GraphQL query over `verdictEnvelopeMetas`:
 *   - filtered to swe-rebench-v2 / enriched-ok;
 *   - keep only PASS and FAIL polarities (INVALID / INDETERMINATE / UNKNOWN are
 *     noise, not lessons — dropped, as is any actualPassed/verdict disagreement);
 *   - carry each verdict row's own `manifestCid` as `verdictManifestCid` — the
 *     entry point of the VERIFIED verdict→solution join done by
 *     `bridge-fetch-evidence.ts` (verdict envelope → task doc →
 *     authoritative verdict → attempt tuple → attemptEnvelopeMeta → solution
 *     envelope patch).
 *
 * The predecessor's `attemptEnvelopeMeta(requestId=verdict.requestId)` join is
 * gone: probed live (see operator/scripts/distill-run-live.ts), that key does not
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
      enrichmentStatus: "ok"
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
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

// ── Constants ──────────────────────────────────────────────────────────────────

/** Ponder caps plural-query `limit` at 1000. */
const PAGE_LIMIT = 1000;
/** Bound on pages walked — 20 × 1000 rows is far beyond any realistic slate. */
const MAX_PAGES = 20;
/**
 * A MetadataSet publisher can project arbitrary enrichment identity. Retain a
 * finite number of projections for one authoritative request tuple so an
 * attacker-first row cannot suppress the genuine candidate.
 */
const MAX_IDENTITY_CANDIDATES_PER_ATTEMPT = 32;

export class IncompleteVerdictWalkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncompleteVerdictWalkError';
  }
}

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

function requireVerdictsPage(data: unknown): VerdictsPage['verdictEnvelopeMetas'] {
  if (typeof data !== 'object' || data === null) {
    throw new IncompleteVerdictWalkError(
      'incomplete verdict walk: malformed GraphQL data payload',
    );
  }
  const verdictEnvelopeMetas = (data as Record<string, unknown>)['verdictEnvelopeMetas'];
  if (typeof verdictEnvelopeMetas !== 'object' || verdictEnvelopeMetas === null) {
    throw new IncompleteVerdictWalkError(
      'incomplete verdict walk: missing or malformed verdictEnvelopeMetas',
    );
  }
  const items = (verdictEnvelopeMetas as Record<string, unknown>)['items'];
  if (!Array.isArray(items)) {
    throw new IncompleteVerdictWalkError(
      'incomplete verdict walk: verdictEnvelopeMetas.items is not an array',
    );
  }
  const pageInfo = (verdictEnvelopeMetas as Record<string, unknown>)['pageInfo'];
  if (typeof pageInfo !== 'object' || pageInfo === null) {
    throw new IncompleteVerdictWalkError(
      'incomplete verdict walk: missing or malformed verdictEnvelopeMetas.pageInfo',
    );
  }
  const hasNextPage = (pageInfo as Record<string, unknown>)['hasNextPage'];
  const endCursor = (pageInfo as Record<string, unknown>)['endCursor'];
  if (
    typeof hasNextPage !== 'boolean'
    || (endCursor !== null && typeof endCursor !== 'string')
  ) {
    throw new IncompleteVerdictWalkError(
      'incomplete verdict walk: malformed verdictEnvelopeMetas.pageInfo fields',
    );
  }
  return {
    items: items as VerdictRow[],
    pageInfo: { hasNextPage, endCursor },
  };
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
    if (
      args.limit !== undefined
      && (!Number.isSafeInteger(args.limit) || args.limit <= 0)
    ) {
      throw new RangeError('verdict-source limit must be a positive safe integer');
    }
    const limit = args.limit ?? Number.POSITIVE_INFINITY;

    // Page verdict rows (both polarities), dropping non-PASS/FAIL and any row
    // missing its verdict `manifestCid` (no join entry point → nothing to bridge).
    const refs: AttemptRef[] = [];
    const refsByRequestPolarity = new Map<string, AttemptRef>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await postGql<unknown>(url, fetchImpl, VERDICTS_QUERY, {
        limit: PAGE_LIMIT,
        after: cursor,
      });
      const verdictsPage = requireVerdictsPage(data);
      for (const row of verdictsPage.items) {
        const polarity = polarityOf(row);
        if (polarity === null) continue; // INVALID/INDETERMINATE/UNKNOWN — dropped.
        if (!row.manifestCid) continue; // no verdict envelope CID → no join entry point.
        const candidateKey =
          `${row.chainId}:${row.requestId.toLowerCase()}:${polarity}`;
        const discoveryCandidate = {
          instanceId: typeof row.instanceId === 'string' ? row.instanceId : '',
          verdictManifestCid: row.manifestCid,
        };
        const existing = refsByRequestPolarity.get(candidateKey);
        if (existing) {
          if (
            existing.discoveryCandidates
            && existing.discoveryCandidates.length < MAX_IDENTITY_CANDIDATES_PER_ATTEMPT
          ) {
            existing.discoveryCandidates.push(discoveryCandidate);
          }
          continue;
        }
        // `limit` bounds authoritative attempt tuples, not permissionless
        // candidate rows. Continue walking the bounded result set after the
        // tuple cap so later candidates for selected tuples survive.
        if (refs.length >= limit) continue;
        const attempt: AttemptRef = {
          requestId: row.requestId,
          chainId: row.chainId,
          instanceId: discoveryCandidate.instanceId,
          // The attempt-join that once supplied the model is gone; the bridge
          // falls back to 'unknown' when model is empty.
          model: '',
          // Filled by the evidence fetcher's authoritative join off verdictManifestCid.
          manifestCid: '',
          polarity,
          verdictManifestCid: row.manifestCid,
          discoveryCandidates: [discoveryCandidate],
        };
        refsByRequestPolarity.set(candidateKey, attempt);
        refs.push(attempt);
      }
      const pageInfo = verdictsPage.pageInfo;
      if (!pageInfo.hasNextPage) return refs;
      if (!pageInfo.endCursor) {
        throw new IncompleteVerdictWalkError(
          'incomplete verdict walk: indexer advertised another page without an end cursor',
        );
      }
      cursor = pageInfo.endCursor;
    }
    throw new IncompleteVerdictWalkError(
      `incomplete verdict walk: indexer still advertised rows after ${MAX_PAGES} pages`,
    );
  }

  return { list };
}
