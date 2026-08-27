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
 * Like every module here, this one must have NO import path — direct or
 * transitive — back into `operator/src/discovery/`; see
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

// ── GraphQL response types ───────────────────────────────────────────────────
// The wire shapes, before validation. Block heights arrive as `string | number`
// depending on column width, so every one is funnelled through parseExactBlock.

/** One cursor-paged connection. Every lifecycle leg answers in this shape. */
interface LifecyclePage<Row> {
  items: Row[];
  pageInfo?: { hasNextPage: boolean; endCursor: string | null };
}

/** A leg's response, keyed by its GraphQL root field. */
type LifecycleLegResponse<Row> = Record<string, LifecyclePage<Row>>;

interface LifecycleTaskGql {
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
}

interface LifecycleAttemptGql {
  taskId: string;
  chainId: number;
  attemptIndex: number;
  requestId: string;
  operator: string;
  priorityMech: string;
  deliveryRate: string | number;
  createdAtBlock: string | number;
}

interface LifecycleVerdictGql {
  taskId: string;
  chainId: number;
  attemptIndex: number;
  verdictIndex: number;
  requestId: string;
  evaluator: string;
  verdictCode: number;
  createdAtBlock: string | number;
}

interface LifecycleAttemptMetaGql {
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
}

/**
 * `taskId` / `attemptIndex` / `verdictIndex` / `evaluator` are the indexer's own
 * spine-shaped projections. They land here under their wire names and leave
 * under `projected*` — see the AC3 note in `./task-lifecycle-evidence.ts`.
 */
interface LifecycleVerdictMetaGql {
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
}

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

/**
 * A non-negative safe integer — the shape of every index, count and chain-id
 * column on these tables. Matches the `Number.isSafeInteger(x) && x >= 0` guard
 * `http.ts` applies to its own equivalents; without it a NaN attemptIndex
 * becomes a garbage spine key and a garbage sort comparator.
 */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

// ── Paging ───────────────────────────────────────────────────────────────────

/**
 * Drain one cursor-paged lifecycle leg, or report that the hard page cap bound.
 *
 * `leg` is both the GraphQL root field and the label the truncation warning
 * names, so the two can never disagree. Rows come back raw: each caller keeps
 * its own validation and projection, which is where the per-leg field lists
 * stay visible.
 */
async function drainLifecycleLeg<Row>(
  gqlUrl: string,
  fetchImpl: typeof fetch,
  leg: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<Row[] | undefined> {
  const rows: Row[] = [];
  let cursor: string | null = null;
  for (let page = 0; ; page++) {
    // The annotation reads as redundant but is not: `cursor` feeds the request
    // and is then assigned from the response, so without it tsc sees an
    // inference cycle between the two (TS7022).
    const data: LifecycleLegResponse<Row> = await postGql<LifecycleLegResponse<Row>>(
      gqlUrl,
      fetchImpl,
      query,
      { ...variables, limit: LIFECYCLE_PAGE_LIMIT, after: cursor },
    );
    const connection = data[leg];
    rows.push(...(connection?.items ?? []));
    const pageInfo = connection?.pageInfo;
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) return rows;
    if (page + 1 >= MAX_LIFECYCLE_PAGES) return undefined;
    cursor = pageInfo.endCursor;
  }
}

/**
 * The one honest answer to a truncated leg. A spine assembled from a capped
 * page walk would silently omit attempts or verdicts, so the whole read is
 * withdrawn rather than answered in part — absence beats a partial lie.
 */
function emptyOnLifecycleTruncate(leg: string): Map<string, TaskLifecycleEvidence> {
  console.warn(
    `[discovery-client] getTaskLifecycleEvidence: page cap hit on ${leg}; `
      + 'omitting results (absence > partial lie)',
  );
  return new Map();
}

/**
 * The same answer for an authoritative row the reader cannot parse. A spine
 * handed back with one task, attempt or verdict quietly missing is exactly the
 * partial lie the truncation guard exists to prevent, so a malformed
 * task/attempt/verdict row withdraws the whole read too.
 */
function emptyOnLifecycleRowReject(
  leg: string,
  identity: string,
): Map<string, TaskLifecycleEvidence> {
  console.warn(
    `[discovery-client] getTaskLifecycleEvidence: unusable ${leg} row (${identity}); `
      + 'omitting results (absence > partial lie)',
  );
  return new Map();
}

/**
 * Two drops are legitimate and lose nothing the caller asked for: a row outside
 * the scope its leg queried (a leaky indexer filter), and a malformed row on an
 * untrusted candidate leg. Neither may be SILENT, so each leg warns once for
 * the whole page walk.
 */
function skipWarner(leg: string): (reason: string) => void {
  let warned = false;
  return (reason: string) => {
    if (warned) return;
    warned = true;
    console.warn(
      `[discovery-client] getTaskLifecycleEvidence: skipped ${leg} row(s) — ${reason}`,
    );
  };
}

// ── Reader ───────────────────────────────────────────────────────────────────

export interface TaskLifecycleReader {
  /**
   * Authoritative task -> attempt -> verdict spine for the given task ids, plus
   * untrusted envelope candidates. Unknown task ids are omitted from the Map;
   * an empty `taskIds` short-circuits with zero I/O. Throws
   * `DiscoveryUnavailableError` when the indexer is unreachable or unready.
   *
   * Returns an EMPTY Map — never a partial spine — when any leg hits the page
   * cap or any task/attempt/verdict row cannot be parsed. Only two drops are
   * survivable, and both warn: a row outside the scope its leg queried, and a
   * malformed row on an untrusted `*EnvelopeMeta` candidate leg.
   */
  getTaskLifecycleEvidence(args: { taskIds: string[] }): Promise<Map<string, TaskLifecycleEvidence>>;
}

export function createTaskLifecycleReader(
  opts: HttpDiscoveryClientOptions,
  transport: DiscoveryHttpTransport = createDiscoveryHttpTransport(opts),
): TaskLifecycleReader {
  const { gqlUrl, fetchImpl, ensureReady } = transport;

  async function getTaskLifecycleEvidence(args: {
    taskIds: string[];
  }): Promise<Map<string, TaskLifecycleEvidence>> {
    if (args.taskIds.length === 0) return new Map();
    await ensureReady();

    const requestedIds = new Set(args.taskIds.filter(Boolean));
    if (requestedIds.size === 0) return new Map();

    const taskRows = await drainLifecycleLeg<LifecycleTaskGql>(
      gqlUrl, fetchImpl, 'tasks', LIFECYCLE_TASKS_QUERY,
      { taskIds: Array.from(requestedIds) },
    );
    if (!taskRows) return emptyOnLifecycleTruncate('tasks');

    const tasks: RawTaskRow[] = [];
    const warnTaskSkip = skipWarner('tasks');
    for (const row of taskRows) {
      // Out of scope rather than malformed: an indexer that widened `id_in`
      // would otherwise seed the Map with a task the caller never asked for,
      // against this interface's own "unknown task ids are omitted" contract.
      if (!requestedIds.has(row.id)) {
        warnTaskSkip('id outside the requested set');
        continue;
      }
      const createdAtBlock = parseExactBlock(row.createdAtBlock);
      if (createdAtBlock === undefined
        || !isCount(row.chainId) || !isCount(row.maxClaims) || !isCount(row.requiredVerdicts)
        || !isBytes32(row.manifestDigest) || !isBytes32(row.taskCidDigest)
        || !isAddress(row.creator)) {
        return emptyOnLifecycleRowReject('tasks', `taskId=${row.id}`);
      }
      const task: RawTaskRow = {
        taskId: row.id,
        chainId: row.chainId,
        manifestDigest: row.manifestDigest.toLowerCase() as `0x${string}`,
        taskCidDigest: row.taskCidDigest.toLowerCase() as `0x${string}`,
        creator: row.creator.toLowerCase() as `0x${string}`,
        maxClaims: row.maxClaims,
        // The indexer defaults this column to 0 before finalization and
        // normalizes it to 1 during it; mirror that so a not-yet-finalized task
        // does not read as "0 verdicts required". This is the ONE derived value
        // under `authoritative` — every other field is the raw chain value.
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

    if (tasks.length === 0) return new Map();

    // `attempt` and `verdict` are keyed by (…, chainId) but `task` is keyed by
    // id alone, so those two legs are scoped per chain the fetched tasks live on.
    const taskIdsByChain = new Map<number, string[]>();
    for (const t of tasks) {
      const list = taskIdsByChain.get(t.chainId);
      if (list) list.push(t.taskId);
      else taskIdsByChain.set(t.chainId, [t.taskId]);
    }

    const attempts: RawAttemptRow[] = [];
    const warnAttemptSkip = skipWarner('attempts');
    for (const [chainId, taskIds] of taskIdsByChain) {
      const rows = await drainLifecycleLeg<LifecycleAttemptGql>(
        gqlUrl, fetchImpl, 'attempts', LIFECYCLE_ATTEMPTS_QUERY, { taskIds, chainId },
      );
      if (!rows) return emptyOnLifecycleTruncate('attempts');
      for (const row of rows) {
        // Defense in depth against an indexer that ignores the chainId filter.
        // The assembler keys `out` by taskId alone, so a chain-B attempt row
        // for a chain-A task would otherwise attach to the spine.
        if (row.chainId !== chainId) {
          warnAttemptSkip('chainId outside the scoped chain');
          continue;
        }
        const createdAtBlock = parseExactBlock(row.createdAtBlock);
        if (createdAtBlock === undefined
          || !isCount(row.attemptIndex)
          || !isBytes32(row.requestId) || !isAddress(row.operator)
          || !isAddress(row.priorityMech)) {
          return emptyOnLifecycleRowReject(
            'attempts', `taskId=${row.taskId} attemptIndex=${row.attemptIndex}`,
          );
        }
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
    }

    const verdicts: RawVerdictRow[] = [];
    const warnVerdictSkip = skipWarner('verdicts');
    for (const [chainId, taskIds] of taskIdsByChain) {
      const rows = await drainLifecycleLeg<LifecycleVerdictGql>(
        gqlUrl, fetchImpl, 'verdicts', LIFECYCLE_VERDICTS_QUERY, { taskIds, chainId },
      );
      if (!rows) return emptyOnLifecycleTruncate('verdicts');
      for (const row of rows) {
        // Same chainId guard the attempts leg carries: with more than one chain
        // in play, a leaked chain-B verdict row would attach on the chain-A pass
        // and AGAIN on the chain-B pass, duplicating it inside a list this
        // module documents as sorted by verdictIndex.
        if (row.chainId !== chainId) {
          warnVerdictSkip('chainId outside the scoped chain');
          continue;
        }
        const createdAtBlock = parseExactBlock(row.createdAtBlock);
        if (createdAtBlock === undefined
          || !isCount(row.attemptIndex) || !isCount(row.verdictIndex)
          || !isCount(row.verdictCode)
          || !isBytes32(row.requestId) || !isAddress(row.evaluator)) {
          return emptyOnLifecycleRowReject(
            'verdicts',
            `taskId=${row.taskId} attemptIndex=${row.attemptIndex} `
              + `verdictIndex=${row.verdictIndex}`,
          );
        }
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
    }

    const solveRequestIds = Array.from(new Set(attempts.map((a) => a.requestId)));
    const evalRequestIds = Array.from(new Set(verdicts.map((v) => v.requestId)));

    const attemptCandidates: AttemptEnvelopeCandidate[] = [];
    if (solveRequestIds.length > 0) {
      const rows = await drainLifecycleLeg<LifecycleAttemptMetaGql>(
        gqlUrl, fetchImpl, 'attemptEnvelopeMetas', LIFECYCLE_ATTEMPT_METAS_QUERY,
        { requestIds: solveRequestIds },
      );
      if (!rows) return emptyOnLifecycleTruncate('attemptEnvelopeMetas');
      const warnSkip = skipWarner('attemptEnvelopeMetas');
      for (const row of rows) {
        // Candidates are untrusted hints, so a malformed one is skipped rather
        // than fatal — but never silently.
        const enrichedAtBlock = parseExactBlock(row.enrichedAtBlock);
        if (enrichedAtBlock === undefined || !isCount(row.chainId)
          || !isBytes32(row.requestId) || !isHex(row.manifestHash)) {
          warnSkip('unparseable candidate row');
          continue;
        }
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
    }

    const verdictCandidates: VerdictEnvelopeCandidate[] = [];
    if (evalRequestIds.length > 0) {
      const rows = await drainLifecycleLeg<LifecycleVerdictMetaGql>(
        gqlUrl, fetchImpl, 'verdictEnvelopeMetas', LIFECYCLE_VERDICT_METAS_QUERY,
        { requestIds: evalRequestIds },
      );
      if (!rows) return emptyOnLifecycleTruncate('verdictEnvelopeMetas');
      const warnSkip = skipWarner('verdictEnvelopeMetas');
      for (const row of rows) {
        const enrichedAtBlock = parseExactBlock(row.enrichedAtBlock);
        if (enrichedAtBlock === undefined || !isCount(row.chainId)
          || !isBytes32(row.requestId) || !isHex(row.manifestHash)) {
          warnSkip('unparseable candidate row');
          continue;
        }
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
        if (isCount(row.attemptIndex)) cand.projectedAttemptIndex = row.attemptIndex;
        if (isCount(row.verdictIndex)) cand.projectedVerdictIndex = row.verdictIndex;
        if (isAddress(row.evaluator)) {
          cand.projectedEvaluator = row.evaluator.toLowerCase() as `0x${string}`;
        }
        verdictCandidates.push(cand);
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
