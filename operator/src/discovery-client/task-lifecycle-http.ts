/**
 * The HTTP lifecycle-evidence read (#2044).
 *
 * A SIBLING module, deliberately not a fifth `DiscoveryClient` method: the
 * four-method narrowness of `./types.ts` is a design invariant, every consumer
 * narrows with `Pick<DiscoveryClient, 'x'>`, and this read has no consumer today.
 *
 * Transport is REUSED, never re-implemented: `createDiscoveryHttpTransport` is
 * already exported from `./http.js` for exactly this, so the read inherits the
 * `/ready` gate, the 15s per-request timeout, and the 502/503 retry schedule.
 *
 * Multi-chain: there is NO chainId parameter. `task`'s primary key is `id`
 * alone, so a task id is globally unique in one indexer DB and a caller-supplied
 * chainId could only ever DISAGREE with the row, never disambiguate it. The
 * `attempt` and `verdict` primary keys DO include chainId, so the read groups
 * fetched tasks by their own chainId and scopes those legs per group.
 *
 * This module must not import anything outside `discovery-client/` — see
 * `operator/test/architecture/discovery-client-neutrality.test.ts`.
 */
import {
  createDiscoveryHttpTransport,
  postGql,
  type DiscoveryHttpTransport,
  type HttpDiscoveryClientOptions,
} from './http.js';
import {
  assembleTaskLifecycleEvidence,
  type AttemptEnvelopeCandidate,
  type RawAttemptRow,
  type RawTaskRow,
  type RawVerdictRow,
  type TaskLifecycleEvidence,
  type VerdictEnvelopeCandidate,
} from './task-lifecycle-evidence.js';

/** Rows per GraphQL page on every lifecycle leg. */
const LIFECYCLE_PAGE_LIMIT = 1000;
/** Hard page cap per leg. 50 x 1000 = 50k rows before the honesty guard fires. */
const MAX_LIFECYCLE_PAGES = 50;

const LIFECYCLE_TASKS_QUERY = `
query LifecycleTasks($taskIds: [String!]!, $limit: Int!, $after: String) {
  tasks(
    where: { id_in: $taskIds },
    limit: $limit,
    after: $after,
    orderBy: "id",
    orderDirection: "asc"
  ) {
    items {
      id
      chainId
      manifestDigest
      taskCidDigest
      creator
      maxClaims
      requiredVerdicts
      createdAtBlock
      createdAtTx
      finalized
      refunded
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
`;

const LIFECYCLE_ATTEMPTS_QUERY = `
query LifecycleAttempts($taskIds: [String!]!, $chainId: Int!, $limit: Int!, $after: String) {
  attempts(
    where: { taskId_in: $taskIds, chainId: $chainId },
    limit: $limit,
    after: $after,
    orderBy: "attemptIndex",
    orderDirection: "asc"
  ) {
    items {
      taskId
      chainId
      attemptIndex
      requestId
      operator
      priorityMech
      deliveryRate
      createdAtBlock
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
`;

const LIFECYCLE_VERDICTS_QUERY = `
query LifecycleVerdicts($taskIds: [String!]!, $chainId: Int!, $limit: Int!, $after: String) {
  verdicts(
    where: { taskId_in: $taskIds, chainId: $chainId },
    limit: $limit,
    after: $after,
    orderBy: "verdictIndex",
    orderDirection: "asc"
  ) {
    items {
      taskId
      chainId
      attemptIndex
      verdictIndex
      requestId
      evaluator
      verdictCode
      createdAtBlock
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
`;

const LIFECYCLE_ATTEMPT_METAS_QUERY = `
query LifecycleAttemptMetas($requestIds: [String!]!, $limit: Int!, $after: String) {
  attemptEnvelopeMetas(
    where: { requestId_in: $requestIds },
    limit: $limit,
    after: $after,
    orderBy: "enrichedAtBlock",
    orderDirection: "asc"
  ) {
    items {
      requestId
      chainId
      manifestCid
      publisherAgentId
      manifestHash
      enrichedAtBlock
      solverType
      implName
      implVersion
      codeDigest
      mode
      pluginsJson
      model
      evidenceTier
      sourcePublished
      enrichmentStatus
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
`;

const LIFECYCLE_VERDICT_METAS_QUERY = `
query LifecycleVerdictMetas($requestIds: [String!]!, $limit: Int!, $after: String) {
  verdictEnvelopeMetas(
    where: { requestId_in: $requestIds },
    limit: $limit,
    after: $after,
    orderBy: "enrichedAtBlock",
    orderDirection: "asc"
  ) {
    items {
      requestId
      chainId
      manifestCid
      publisherAgentId
      manifestHash
      enrichedAtBlock
      solverType
      evidenceTier
      actualPassed
      actualScore
      evaluatorVerdict
      solutionRequestId
      instanceId
      solverNetManifestCid
      enrichmentStatus
      taskId
      attemptIndex
      verdictIndex
      evaluator
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
`;

// ── Local parse helpers ──────────────────────────────────────────────────────
// `http.ts` keeps its equivalents module-private and stays untouched (#2044
// modifies no existing file), so this module carries its own copies.

function parseOptionalNumber(value: string | number | null | undefined): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

function parseExactBlock(value: string | number | null | undefined): number | undefined {
  const parsed = parseOptionalNumber(value);
  return parsed !== undefined && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function isBytes32(value: string | undefined | null): value is `0x${string}` {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isAddress(value: string | undefined | null): value is `0x${string}` {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

/**
 * Loose hex. Used for ONE field: `*EnvelopeMeta.manifestHash`, which the schema
 * declares `t.hex().notNull().default('0x')`. A strict check there would drop
 * real indexed candidate rows whose publisher committed no hash. Every
 * authoritative-spine hex uses isBytes32 / isAddress instead.
 */
function isHex(value: string | undefined | null): value is `0x${string}` {
  return typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value);
}

// ── Reader ───────────────────────────────────────────────────────────────────

export interface TaskLifecycleReader {
  /**
   * Authoritative task -> attempt -> verdict spine for the given task ids, plus
   * untrusted envelope candidates. Unknown task ids are omitted from the Map;
   * an empty `taskIds` short-circuits with zero I/O. Throws
   * `DiscoveryUnavailableError` when the indexer is unreachable or unready.
   */
  getTaskLifecycleEvidence(args: { taskIds: string[] }): Promise<Map<string, TaskLifecycleEvidence>>;
}

export function createTaskLifecycleReader(
  opts: HttpDiscoveryClientOptions,
  transport: DiscoveryHttpTransport = createDiscoveryHttpTransport(opts),
): TaskLifecycleReader {
  const { gqlUrl, fetchImpl, ensureReady } = transport;

  // Authoritative task→attempt→verdict spine + untrusted envelope candidates.
  // Empty taskIds short-circuits with no query. Unknown taskIds are omitted.
  // Candidates attach last by (requestId, chainId) and never rewrite spine.
  // If any GraphQL leg hits MAX_LIFECYCLE_PAGES with more pages remaining,
  // return empty (absence > partial lie).
  async function getTaskLifecycleEvidence(args: {
    taskIds: string[];
  }): Promise<Map<string, TaskLifecycleEvidence>> {
    if (args.taskIds.length === 0) return new Map();
    await ensureReady();

    const requestedIds = Array.from(new Set(args.taskIds.filter(Boolean)));
    if (requestedIds.length === 0) return new Map();

    type LifecyclePageInfo = { hasNextPage?: boolean; endCursor?: string | null } | undefined;
    /** Advance a cursor page, or signal truncation when the hard page cap binds. */
    const nextLifecyclePage = (
      page: number,
      pageInfo: LifecyclePageInfo,
    ): { kind: 'done' } | { kind: 'next'; cursor: string } | { kind: 'truncated' } => {
      if (!pageInfo?.hasNextPage || !pageInfo.endCursor) return { kind: 'done' };
      if (page + 1 >= MAX_LIFECYCLE_PAGES) return { kind: 'truncated' };
      return { kind: 'next', cursor: pageInfo.endCursor };
    };
    const emptyOnLifecycleTruncate = (leg: string): Map<string, TaskLifecycleEvidence> => {
      console.warn(
        `[discovery-client] getTaskLifecycleEvidence: page cap hit on ${leg}; ` +
          'omitting results (absence > partial lie)',
      );
      return new Map();
    };

    type LifecycleTaskGql = {
      id: string;
      chainId: number;
      manifestDigest: string;
      taskCidDigest: string;
      creator: string;
      maxClaims: number;
      requiredVerdicts: number;
      createdAtBlock: string | number;
      createdAtTx?: string | null;
      finalized: boolean;
      refunded: boolean;
    };
    type LifecycleAttemptGql = {
      taskId: string;
      chainId: number;
      attemptIndex: number;
      requestId: string;
      operator: string;
      priorityMech: string;
      deliveryRate: string | number;
      createdAtBlock: string | number;
    };
    type LifecycleVerdictGql = {
      taskId: string;
      chainId: number;
      attemptIndex: number;
      verdictIndex: number;
      requestId: string;
      evaluator: string;
      verdictCode: number;
      createdAtBlock: string | number;
    };
    type LifecycleAttemptMetaGql = {
      requestId: string;
      chainId: number;
      manifestCid: string;
      publisherAgentId: string;
      manifestHash: string;
      enrichedAtBlock: string | number;
      solverType?: string;
      implName?: string;
      implVersion?: string;
      codeDigest?: string;
      mode?: string;
      pluginsJson?: string;
      model?: string;
      evidenceTier?: string;
      sourcePublished?: boolean;
      enrichmentStatus?: string;
    };
    type LifecycleVerdictMetaGql = {
      requestId: string;
      chainId: number;
      manifestCid: string;
      publisherAgentId: string;
      manifestHash: string;
      enrichedAtBlock: string | number;
      solverType?: string;
      evidenceTier?: string;
      actualPassed?: boolean;
      actualScore?: string;
      evaluatorVerdict?: string;
      solutionRequestId?: string;
      instanceId?: string;
      solverNetManifestCid?: string;
      enrichmentStatus?: string;
      taskId?: string;
      attemptIndex?: number;
      verdictIndex?: number;
      evaluator?: string;
    };

    const tasks: RawTaskRow[] = [];
    let taskCursor: string | null = null;
    for (let page = 0; page < MAX_LIFECYCLE_PAGES; page++) {
      const data = await postGql<{
        tasks: {
          items: LifecycleTaskGql[];
          pageInfo?: { hasNextPage: boolean; endCursor: string | null };
        };
      }>(gqlUrl, fetchImpl, LIFECYCLE_TASKS_QUERY, {
        taskIds: requestedIds,
        limit: LIFECYCLE_PAGE_LIMIT,
        after: taskCursor,
      });
      for (const row of data.tasks?.items ?? []) {
        const createdAtBlock = parseExactBlock(row.createdAtBlock);
        if (createdAtBlock === undefined) continue;
        if (!isBytes32(row.manifestDigest) || !isBytes32(row.taskCidDigest)
          || !isAddress(row.creator)) continue;
        const task: RawTaskRow = {
          taskId: row.id,
          chainId: row.chainId,
          manifestDigest: row.manifestDigest.toLowerCase() as `0x${string}`,
          taskCidDigest: row.taskCidDigest.toLowerCase() as `0x${string}`,
          creator: row.creator.toLowerCase() as `0x${string}`,
          maxClaims: row.maxClaims,
          requiredVerdicts: row.requiredVerdicts > 0 ? row.requiredVerdicts : 1,
          createdAtBlock,
          finalized: row.finalized === true,
          refunded: row.refunded === true,
        };
        if (isBytes32(row.createdAtTx)) {
          task.createdAtTx = row.createdAtTx.toLowerCase() as `0x${string}`;
        }
        tasks.push(task);
      }
      const advance = nextLifecyclePage(page, data.tasks?.pageInfo);
      if (advance.kind === 'done') break;
      if (advance.kind === 'truncated') return emptyOnLifecycleTruncate('tasks');
      taskCursor = advance.cursor;
    }

    if (tasks.length === 0) return new Map();

    const taskIdsByChain = new Map<number, string[]>();
    for (const t of tasks) {
      const list = taskIdsByChain.get(t.chainId) ?? [];
      list.push(t.taskId);
      taskIdsByChain.set(t.chainId, list);
    }

    const attempts: RawAttemptRow[] = [];
    for (const [chainId, taskIds] of taskIdsByChain) {
      let attemptCursor: string | null = null;
      for (let page = 0; page < MAX_LIFECYCLE_PAGES; page++) {
        const data = await postGql<{
          attempts: {
            items: LifecycleAttemptGql[];
            pageInfo?: { hasNextPage: boolean; endCursor: string | null };
          };
        }>(gqlUrl, fetchImpl, LIFECYCLE_ATTEMPTS_QUERY, {
          taskIds,
          chainId,
          limit: LIFECYCLE_PAGE_LIMIT,
          after: attemptCursor,
        });
        for (const row of data.attempts?.items ?? []) {
          // Defense in depth against an indexer that ignores the chainId filter.
          // The assembler keys `out` by taskId alone, so a chain-B attempt row
          // for a chain-A task would otherwise attach to the spine.
          if (row.chainId !== chainId) continue;
          const createdAtBlock = parseExactBlock(row.createdAtBlock);
          if (createdAtBlock === undefined) continue;
          if (!isBytes32(row.requestId) || !isAddress(row.operator)
            || !isAddress(row.priorityMech)) continue;
          attempts.push({
            taskId: row.taskId,
            chainId: row.chainId,
            attemptIndex: row.attemptIndex,
            requestId: row.requestId.toLowerCase() as `0x${string}`,
            operator: row.operator.toLowerCase() as `0x${string}`,
            priorityMech: row.priorityMech.toLowerCase() as `0x${string}`,
            deliveryRate: String(row.deliveryRate),
            createdAtBlock,
          });
        }
        const advance = nextLifecyclePage(page, data.attempts?.pageInfo);
        if (advance.kind === 'done') break;
        if (advance.kind === 'truncated') return emptyOnLifecycleTruncate('attempts');
        attemptCursor = advance.cursor;
      }
    }

    const verdicts: RawVerdictRow[] = [];
    for (const [chainId, taskIds] of taskIdsByChain) {
      let verdictCursor: string | null = null;
      for (let page = 0; page < MAX_LIFECYCLE_PAGES; page++) {
        const data = await postGql<{
          verdicts: {
            items: LifecycleVerdictGql[];
            pageInfo?: { hasNextPage: boolean; endCursor: string | null };
          };
        }>(gqlUrl, fetchImpl, LIFECYCLE_VERDICTS_QUERY, {
          taskIds,
          chainId,
          limit: LIFECYCLE_PAGE_LIMIT,
          after: verdictCursor,
        });
        for (const row of data.verdicts?.items ?? []) {
          const createdAtBlock = parseExactBlock(row.createdAtBlock);
          if (createdAtBlock === undefined) continue;
          if (!isBytes32(row.requestId) || !isAddress(row.evaluator)) continue;
          verdicts.push({
            taskId: row.taskId,
            chainId: row.chainId,
            attemptIndex: row.attemptIndex,
            verdictIndex: row.verdictIndex,
            requestId: row.requestId.toLowerCase() as `0x${string}`,
            evaluator: row.evaluator.toLowerCase() as `0x${string}`,
            verdictCode: row.verdictCode,
            createdAtBlock,
          });
        }
        const advance = nextLifecyclePage(page, data.verdicts?.pageInfo);
        if (advance.kind === 'done') break;
        if (advance.kind === 'truncated') return emptyOnLifecycleTruncate('verdicts');
        verdictCursor = advance.cursor;
      }
    }

    const solveRequestIds = Array.from(new Set(attempts.map((a) => a.requestId)));
    const evalRequestIds = Array.from(new Set(verdicts.map((v) => v.requestId)));

    const attemptCandidates: AttemptEnvelopeCandidate[] = [];
    if (solveRequestIds.length > 0) {
      let metaCursor: string | null = null;
      for (let page = 0; page < MAX_LIFECYCLE_PAGES; page++) {
        const data = await postGql<{
          attemptEnvelopeMetas: {
            items: LifecycleAttemptMetaGql[];
            pageInfo?: { hasNextPage: boolean; endCursor: string | null };
          };
        }>(gqlUrl, fetchImpl, LIFECYCLE_ATTEMPT_METAS_QUERY, {
          requestIds: solveRequestIds,
          limit: LIFECYCLE_PAGE_LIMIT,
          after: metaCursor,
        });
        for (const row of data.attemptEnvelopeMetas?.items ?? []) {
          const enrichedAtBlock = parseExactBlock(row.enrichedAtBlock);
          if (enrichedAtBlock === undefined) continue;
          if (!isBytes32(row.requestId) || !isHex(row.manifestHash)) continue;
          const cand: AttemptEnvelopeCandidate = {
            requestId: row.requestId.toLowerCase() as `0x${string}`,
            chainId: row.chainId,
            manifestCid: row.manifestCid,
            publisherAgentId: row.publisherAgentId,
            manifestHash: row.manifestHash.toLowerCase() as `0x${string}`,
            enrichedAtBlock,
          };
          if (row.solverType) cand.solverType = row.solverType;
          if (row.implName) cand.implName = row.implName;
          if (row.implVersion) cand.implVersion = row.implVersion;
          if (row.codeDigest) cand.codeDigest = row.codeDigest;
          if (row.mode) cand.mode = row.mode;
          if (row.pluginsJson) cand.pluginsJson = row.pluginsJson;
          if (row.model) cand.model = row.model;
          if (row.evidenceTier) cand.evidenceTier = row.evidenceTier;
          if (typeof row.sourcePublished === 'boolean') cand.sourcePublished = row.sourcePublished;
          if (row.enrichmentStatus) cand.enrichmentStatus = row.enrichmentStatus;
          attemptCandidates.push(cand);
        }
        const advance = nextLifecyclePage(page, data.attemptEnvelopeMetas?.pageInfo);
        if (advance.kind === 'done') break;
        if (advance.kind === 'truncated') return emptyOnLifecycleTruncate('attemptEnvelopeMetas');
        metaCursor = advance.cursor;
      }
    }

    const verdictCandidates: VerdictEnvelopeCandidate[] = [];
    if (evalRequestIds.length > 0) {
      let metaCursor: string | null = null;
      for (let page = 0; page < MAX_LIFECYCLE_PAGES; page++) {
        const data = await postGql<{
          verdictEnvelopeMetas: {
            items: LifecycleVerdictMetaGql[];
            pageInfo?: { hasNextPage: boolean; endCursor: string | null };
          };
        }>(gqlUrl, fetchImpl, LIFECYCLE_VERDICT_METAS_QUERY, {
          requestIds: evalRequestIds,
          limit: LIFECYCLE_PAGE_LIMIT,
          after: metaCursor,
        });
        for (const row of data.verdictEnvelopeMetas?.items ?? []) {
          const enrichedAtBlock = parseExactBlock(row.enrichedAtBlock);
          if (enrichedAtBlock === undefined) continue;
          if (!isBytes32(row.requestId) || !isHex(row.manifestHash)) continue;
          const cand: VerdictEnvelopeCandidate = {
            requestId: row.requestId.toLowerCase() as `0x${string}`,
            chainId: row.chainId,
            manifestCid: row.manifestCid,
            publisherAgentId: row.publisherAgentId,
            manifestHash: row.manifestHash.toLowerCase() as `0x${string}`,
            enrichedAtBlock,
          };
          if (row.solverType) cand.solverType = row.solverType;
          if (row.evidenceTier) cand.evidenceTier = row.evidenceTier;
          if (typeof row.actualPassed === 'boolean') cand.actualPassed = row.actualPassed;
          if (row.actualScore) cand.actualScore = row.actualScore;
          if (row.evaluatorVerdict) cand.evaluatorVerdict = row.evaluatorVerdict;
          if (row.solutionRequestId) cand.solutionRequestId = row.solutionRequestId;
          if (row.instanceId) cand.instanceId = row.instanceId;
          if (row.solverNetManifestCid) cand.solverNetManifestCid = row.solverNetManifestCid;
          if (row.enrichmentStatus) cand.enrichmentStatus = row.enrichmentStatus;
          // Projected hints only — never used as spine keys (AC3).
          if (row.taskId) cand.projectedTaskId = row.taskId;
          if (typeof row.attemptIndex === 'number') cand.projectedAttemptIndex = row.attemptIndex;
          if (typeof row.verdictIndex === 'number') cand.projectedVerdictIndex = row.verdictIndex;
          if (isAddress(row.evaluator)) {
            cand.projectedEvaluator = row.evaluator.toLowerCase() as `0x${string}`;
          }
          verdictCandidates.push(cand);
        }
        const advance = nextLifecyclePage(page, data.verdictEnvelopeMetas?.pageInfo);
        if (advance.kind === 'done') break;
        if (advance.kind === 'truncated') return emptyOnLifecycleTruncate('verdictEnvelopeMetas');
        metaCursor = advance.cursor;
      }
    }

    return assembleTaskLifecycleEvidence({
      tasks,
      attempts,
      verdicts,
      attemptCandidates,
      verdictCandidates,
    });
  }

  return { getTaskLifecycleEvidence };
}
