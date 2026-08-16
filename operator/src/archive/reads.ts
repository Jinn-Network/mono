/**
 * Thin archive/projector reads that replace the DiscoveryAPI methods the
 * operator API still drives after Wave-4 D4.
 *
 * Intentionally narrower than the original stage-4 Task 11 sketch: D4 does
 * not expand `discovery-client/` and does not port `getCodeDigestRewards` /
 * `getInstanceSuccessCounts` / `getInstanceClaimCounts`. Verdict tallies
 * stay on `Store.verdictTallyReadModel()`. This module owns:
 *
 *   - `getTaskPostCounts` — chain-wide nesting from projector `TaskCreated`
 *     observations. Per-cid `byCid` is zeros: native/revised `TaskCreated`
 *     has no `manifestDigest`.
 *   - `getTaskStatuses` — empty Map (launcher chips render `'unknown'`):
 *     observations do not carry indexer finalization fields keyed by
 *     manifestCid.
 *
 * Callers inject observation accessors so `api/` never imports `daemon/`.
 */

import {
  bucketTaskPostCounts,
  type TaskPostCounts,
  type TaskStatusSnapshot,
} from './types.js';

export class ArchiveReadUnavailableError extends Error {
  readonly code: 'archive_unavailable' | 'projector_behind';

  constructor(message: string, code: 'archive_unavailable' | 'projector_behind' = 'archive_unavailable') {
    super(message);
    this.name = 'ArchiveReadUnavailableError';
    this.code = code;
  }
}

export interface ArchiveReads {
  getTaskPostCounts(q?: { manifestCids?: string[] }): Promise<{
    windowEndBlock: number;
    windowEndTs: number;
    chain: TaskPostCounts;
    byCid: Record<string, TaskPostCounts>;
  }>;
  getTaskStatuses(q: { manifestCid: string }): Promise<Map<string, TaskStatusSnapshot>>;
}

export interface ArchiveReadsDeps {
  /** Block numbers of projector `TaskCreated` observations. */
  listTaskCreatedBlocks: () => readonly number[];
  /** Projector cursor's finalized head (window end). */
  windowEndBlock: () => number;
  /** Override wall clock (unix ms) for tests. */
  now?: () => number;
}

export function createArchiveReads(deps: ArchiveReadsDeps): ArchiveReads {
  return {
    async getTaskPostCounts(q) {
      const windowEndBlock = deps.windowEndBlock();
      const windowEndTs = Math.floor((deps.now?.() ?? Date.now()) / 1000);
      const events = deps.listTaskCreatedBlocks().map((block) => ({ block, digest: '' }));
      // Requested cids get empty buckets. Native/revised TaskCreated has no
      // manifestDigest, so nothing can join an observation onto a cid.
      const cidByDigest = new Map<string, string>();
      for (const cid of q?.manifestCids ?? []) {
        cidByDigest.set(`unjoinable:${cid}`, cid);
      }
      const { chain, byCid } = bucketTaskPostCounts(
        windowEndBlock,
        windowEndTs,
        events,
        cidByDigest,
      );
      return { windowEndBlock, windowEndTs, chain, byCid };
    },
    async getTaskStatuses(_q) {
      void _q;
      return new Map();
    },
  };
}

/**
 * Pull TaskCreated block numbers out of serialized projector observations.
 * TaskCreated projects as `submission-accepted.v1` with `derivation.event`
 * still `'TaskCreated'` (see marketplace-projector `observe.ts`).
 */
export function extractTaskCreatedBlocks(observationJsons: readonly string[]): number[] {
  const blocks: number[] = [];
  for (const json of observationJsons) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const derivation = (parsed as { derivation?: { event?: unknown; blockNumber?: unknown } }).derivation;
    if (derivation?.event !== 'TaskCreated') continue;
    const block = derivation.blockNumber;
    if (typeof block === 'number' && Number.isFinite(block)) blocks.push(block);
  }
  return blocks;
}

/**
 * SQLite surface `Store.db` already exposes; kept narrow so `archive/` stays
 * off `daemon/`. `any` on the statement methods is load-bearing: better-sqlite3
 * types `Statement.all`/`get` as invariant in the bind-parameter tuple, so
 * `(...args: unknown[])` is not assignable from a no-bind statement.
 */
export interface ArchiveReadsStore {
  db: {
    prepare(sql: string): { all: (...args: any[]) => unknown; get: (...args: any[]) => unknown };
  };
}

/**
 * Production wiring: read TaskCreated observations and the projector cursor
 * from the daemon's SQLite store. Empty / missing tables degrade to zeros
 * rather than throwing — the SPA already treats that as `'unknown'`.
 */
export function createArchiveReadsFromStore(
  store: ArchiveReadsStore,
  opts?: { now?: () => number },
): ArchiveReads {
  return createArchiveReads({
    listTaskCreatedBlocks: () => {
      try {
        const rows = store.db.prepare(
          `SELECT observation_json FROM projector_observations`,
        ).all() as { observation_json: string }[];
        return extractTaskCreatedBlocks(rows.map((row) => row.observation_json));
      } catch {
        return [];
      }
    },
    windowEndBlock: () => {
      try {
        const row = store.db.prepare(
          `SELECT MAX(CAST(finalized_block_number AS INTEGER)) AS head FROM projector_cursor`,
        ).get() as { head: number | null } | undefined;
        return row?.head ?? 0;
      } catch {
        return 0;
      }
    },
    ...(opts?.now !== undefined ? { now: opts.now } : {}),
  });
}
