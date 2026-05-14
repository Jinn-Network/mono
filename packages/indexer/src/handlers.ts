/**
 * Pure event-handler logic for the Jinn protocol indexer, extracted out of the
 * `ponder.on(...)` registrations in `src/index.ts` so it can be unit-tested
 * without booting the Ponder runtime.
 *
 * Why an extract instead of Ponder's test utilities: Ponder 0.16.x ships no
 * first-class unit-test util for indexing functions — the `ponder:registry`,
 * `ponder:schema`, and `ponder:api` modules are virtual modules resolved only
 * by the Ponder build, not importable from Vitest. So `src/index.ts` is reduced
 * to thin `ponder.on(...)` shims that forward `{ event, context }` to the pure
 * functions here, passing the schema table objects as arguments. Tests call the
 * pure functions directly with synthetic events, the real schema tables, and an
 * in-memory `db` stub that mirrors the `insert / update / find /
 * onConflictDoUpdate / onConflictDoNothing` surface the handlers use.
 *
 * The behaviour here is byte-for-byte the same as the original inline handlers
 * — this is a refactor, not a behaviour change. See `src/index.ts` for the
 * Ponder docs links and the schema rationale.
 */
import { decodeAbiParameters, keccak256, toBytes, type Hex } from 'viem';
import {
  parseEnvelopeKey,
  parseHarnessCheckpointKey,
  parseSolverNetManifestKey,
  tierFromRaw,
} from './types.js';
import { fetchIpfsJson, type FetchLike } from './ipfs.js';

// ── Minimal structural types for the handler context ──────────────────────────
// Deliberately narrow — only the fields the handlers actually touch. The real
// Ponder `event` / `context` objects are structurally compatible supersets of
// these, so `src/index.ts` passes them through without casts.

/** The `db` surface the handlers use — a structural subset of Ponder's `Db`. */
export interface HandlerDb {
  find: (table: unknown, key: Record<string, unknown>) => Promise<unknown | null>;
  insert: (table: unknown) => {
    values: (values: Record<string, unknown>) => Promise<unknown> & {
      onConflictDoNothing: () => Promise<unknown>;
      onConflictDoUpdate: (
        update: Record<string, unknown> | ((row: any) => Record<string, unknown>),
      ) => Promise<unknown>;
    };
  };
  update: (
    table: unknown,
    key: Record<string, unknown>,
  ) => { set: (values: Record<string, unknown> | ((row: any) => Record<string, unknown>)) => Promise<unknown> };
}

export interface HandlerContext {
  db: HandlerDb;
  chain: { id: number };
}

export interface BlockShape {
  number: bigint;
}
export interface TransactionShape {
  hash: `0x${string}`;
  transactionIndex?: number;
}
export interface LogShape {
  logIndex?: number;
}

export interface TaskCreatedEvent {
  args: {
    creator: `0x${string}`;
    taskId: bigint;
    manifestDigest: `0x${string}`;
    taskCidDigest: `0x${string}`;
    maxClaims: bigint | number;
    requiredVerdicts: bigint | number;
  };
  block: BlockShape;
  transaction: TransactionShape;
  log: LogShape;
}

export interface TaskAttemptCreatedEvent {
  args: {
    taskId: bigint;
    attemptIndex: bigint | number;
    requestId: `0x${string}`;
    operator: `0x${string}`;
    priorityMech: `0x${string}`;
    deliveryRate: bigint;
  };
  block: BlockShape;
  transaction: TransactionShape;
  log: LogShape;
}

export interface SolutionDeliveryClaimedEvent {
  args: {
    operator: `0x${string}`;
    requestId: `0x${string}`;
    taskId: bigint;
    attemptIndex: bigint | number;
  };
  block: BlockShape;
  transaction: TransactionShape;
  log: LogShape;
}

export interface VerdictDeliveryClaimedEvent {
  args: {
    evaluator: `0x${string}`;
    requestId: `0x${string}`;
    taskId: bigint;
    attemptIndex: bigint | number;
    verdictIndex: bigint | number;
    verdictCode: bigint | number;
  };
  block: BlockShape;
  transaction: TransactionShape;
  log: LogShape;
}

export interface TaskBudgetRefundedEvent {
  args: {
    taskId: bigint;
    creator: `0x${string}`;
    solutionAmount: bigint;
    verdictAmount: bigint;
  };
  block: BlockShape;
  transaction: TransactionShape;
  log: LogShape;
}

export interface MetadataSetEvent {
  args: {
    agentId: bigint;
    metadataKey: string;
    metadataValue: `0x${string}`;
  };
  block: BlockShape;
  transaction: TransactionShape;
  log: LogShape;
}

// ── ABI tuple for payload decoding ────────────────────────────────────────────
// Matches PAYLOAD_TUPLE_V2 in client/src/erc8004/abis.ts. We try V2 first,
// then fall back to V1 (without the trailing harness identity fields).

export const PAYLOAD_TUPLE_V2 = [
  { name: 'version', type: 'uint8' },
  { name: 'tier', type: 'uint8' },
  { name: 'manifestHash', type: 'bytes32' },
  { name: 'attestationQuoteCid', type: 'bytes' },
  { name: 'sourceMeasurement', type: 'bytes32' },
  { name: 'codeDigest', type: 'bytes32' },
  { name: 'implName', type: 'string' },
  { name: 'modeFlag', type: 'uint8' },
] as const;

export const PAYLOAD_TUPLE_V1 = [
  { name: 'version', type: 'uint8' },
  { name: 'tier', type: 'uint8' },
  { name: 'manifestHash', type: 'bytes32' },
  { name: 'attestationQuoteCid', type: 'bytes' },
  { name: 'sourceMeasurement', type: 'bytes32' },
] as const;

export function decodeEnvelopePayload(value: Hex): {
  manifestHash: string;
  evidenceTier: 'self-signed' | 'committed' | 'attested' | 'unknown';
} {
  try {
    const decoded = decodeAbiParameters(PAYLOAD_TUPLE_V2, value);
    return {
      manifestHash: decoded[2],
      evidenceTier: tierFromRaw(Number(decoded[1])),
    };
  } catch {
    // not V2 — try V1
  }
  try {
    const decoded = decodeAbiParameters(PAYLOAD_TUPLE_V1, value);
    return {
      manifestHash: decoded[2],
      evidenceTier: tierFromRaw(Number(decoded[1])),
    };
  } catch {
    return { manifestHash: '', evidenceTier: 'unknown' };
  }
}

export interface ClaimedEvent {
  args: {
    serviceId: bigint;
    multisig: `0x${string}`;
    operatorMinted: bigint;
    daoMinted: bigint;
    totalEntitledOperator: bigint;
    totalEntitledDao: bigint;
  };
  block: BlockShape;
  transaction: TransactionShape;
  log: LogShape;
}

// ── JinnRouter: TaskCreated ───────────────────────────────────────────────────

export async function handleTaskCreated({
  event,
  context,
  task,
}: {
  event: TaskCreatedEvent;
  context: HandlerContext;
  task: unknown;
}): Promise<void> {
  await context.db
    .insert(task)
    .values({
      id: event.args.taskId.toString(),
      manifestDigest: event.args.manifestDigest,
      taskCidDigest: event.args.taskCidDigest,
      creator: event.args.creator,
      maxClaims: Number(event.args.maxClaims),
      requiredVerdicts: Number(event.args.requiredVerdicts ?? 0),
      createdAtBlock: event.block.number,
      createdAtTx: event.transaction.hash,
      // claimWindowStart and claimWindowEnd are not emitted in TaskCreated on
      // JinnRouter V3 — they require call-trace decoding (280n.4). Left null.
      claimWindowStart: null,
      claimWindowEnd: null,
      finalized: false,
      refunded: false,
      chainId: context.chain.id,
    })
    .onConflictDoNothing();
}

// ── JinnRouter: TaskAttemptCreated ───────────────────────────────────────────

export async function handleTaskAttemptCreated({
  event,
  context,
  attempt,
}: {
  event: TaskAttemptCreatedEvent;
  context: HandlerContext;
  attempt: unknown;
}): Promise<void> {
  await context.db
    .insert(attempt)
    .values({
      taskId: event.args.taskId.toString(),
      attemptIndex: Number(event.args.attemptIndex),
      requestId: event.args.requestId,
      operator: event.args.operator,
      priorityMech: event.args.priorityMech,
      deliveryRate: event.args.deliveryRate,
      createdAtBlock: event.block.number,
      chainId: context.chain.id,
    })
    .onConflictDoNothing();
}

// ── JinnRouter: VerdictDeliveryClaimed → verdict ─────────────────────────────
// One row per delivered verdict. verdictCode 0..4 per the VerdictCode enum.
// Idempotent: a replayed event with the same (taskId, attemptIndex, verdictIndex,
// chainId) does not clobber the original.
export async function handleVerdictDeliveryClaimed({
  event,
  context,
  verdict,
}: {
  event: VerdictDeliveryClaimedEvent;
  context: HandlerContext;
  verdict: unknown;
}): Promise<void> {
  await context.db
    .insert(verdict)
    .values({
      taskId: event.args.taskId.toString(),
      attemptIndex: Number(event.args.attemptIndex),
      verdictIndex: Number(event.args.verdictIndex),
      evaluator: event.args.evaluator,
      requestId: event.args.requestId,
      verdictCode: Number(event.args.verdictCode),
      createdAtBlock: event.block.number,
      chainId: context.chain.id,
    })
    .onConflictDoNothing();
}

// ── JinnRouter: SolutionDeliveryClaimed ──────────────────────────────────────
// Used as a proxy for task finalization. JinnRouter V3 has no standalone
// TaskFinalized event; SolutionDeliveryClaimed is the terminal success state.
//
// Existence guard: the matching TaskCreated may predate `startBlock` (or, in a
// future multi-chain config, live on a chain this indexer doesn't cover), in
// which case there is no `task` row. `db.update` on a missing row throws and
// crashes the indexer — so look it up first and skip if absent. The daemon's
// canClaimTask simulation is the correctness gate regardless.
export async function handleSolutionDeliveryClaimed({
  event,
  context,
  task,
}: {
  event: SolutionDeliveryClaimedEvent;
  context: HandlerContext;
  task: unknown;
}): Promise<void> {
  const id = event.args.taskId.toString();
  const existing = await context.db.find(task, { id });
  if (!existing) return;
  await context.db.update(task, { id }).set({ finalized: true });
}

// ── JinnRouter: TaskBudgetRefunded → task.refunded = true ────────────────────
// Existence guard mirrors handleSolutionDeliveryClaimed: the matching TaskCreated
// may predate startBlock; db.update on a missing row throws and crashes the
// indexer, so look up first and skip if absent.
export async function handleTaskBudgetRefunded({
  event,
  context,
  task,
}: {
  event: TaskBudgetRefundedEvent;
  context: HandlerContext;
  task: unknown;
}): Promise<void> {
  const id = event.args.taskId.toString();
  const existing = await context.db.find(task, { id });
  if (!existing) return;
  await context.db.update(task, { id }).set({ refunded: true });
}

// ── CheckpointManifest lite parser ───────────────────────────────────────────
// Dep-free defensive parser: reads only the fields needed for harnessCheckpoint
// enrichment from a HarnessCheckpointManifest body (packages/sdk/src/checkpoint.ts).
// Returns null if the body isn't an object or lacks the required codeDigest /
// implStateDirCid fields — defensive safeStr reads like parseEnvelopeLite.

export interface CheckpointManifestLite {
  name: string;
  version: string;
  codeDigest: string;
  parentCheckpointCid: string | null;
  implStateDirCid: string;
  implName: string;
  implVersion: string;
  sourceBundleCid: string;
}

export function parseCheckpointManifestLite(body: unknown): CheckpointManifestLite | null {
  if (body === null || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;

  // codeDigest is required — if absent/empty this isn't a valid checkpoint manifest.
  const codeDigest = safeStr(b['codeDigest']);
  if (!codeDigest) return null;

  // implStateDirCid is required by the schema.
  const implStateDirCid = safeStr(b['implStateDirCid']);
  if (!implStateDirCid) return null;

  const name = safeStr(b['name']);
  const version = safeStr(b['version']);

  // parentCheckpointCid: nullable per schema
  const rawParent = b['parentCheckpointCid'];
  const parentCheckpointCid =
    rawParent === null || rawParent === undefined ? null : safeStr(rawParent) || null;

  // harnessPackage block
  const pkg = b['harnessPackage'];
  const pkgObj: Record<string, unknown> =
    pkg !== null && typeof pkg === 'object' ? (pkg as Record<string, unknown>) : {};
  const implName = safeStr(pkgObj['implName']);
  const implVersion = safeStr(pkgObj['implVersion']);
  const sourceBundleCid = safeStr(pkgObj['sourceBundleCid']);

  return {
    name,
    version,
    codeDigest,
    parentCheckpointCid,
    implStateDirCid,
    implName,
    implVersion,
    sourceBundleCid,
  };
}

// ── SolverNet manifest lite parser ────────────────────────────────────────────
// For solvernet-manifest:<cid> IPFS bodies. Reads the user-facing name +
// description + numeric solverNetId. Returns null if body lacks the required
// `name` field. The on-chain solverNetManifest row already has the cid (the
// PK), status/lifecycle, manifestHash, anchor block — this enrichment fills
// the user-visible label so the SPA can show 'SWE-rebench v2' instead of the
// 60-char CID.

export interface SolverNetManifestLite {
  name: string;
  description: string;
  solverNetId: string;
}

export function parseSolverNetManifestLite(body: unknown): SolverNetManifestLite | null {
  if (body === null || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const name = safeStr(b['name']);
  if (!name) return null;
  const description = safeStr(b['description']);
  // solverNetId may be number or string in the manifest; normalize to string.
  let solverNetId = '';
  const raw = b['solverNetId'];
  if (typeof raw === 'string') solverNetId = raw;
  else if (typeof raw === 'number' && Number.isFinite(raw)) solverNetId = String(raw);
  else if (typeof raw === 'bigint') solverNetId = raw.toString();
  return { name, description, solverNetId };
}

// ── Envelope lite parser ──────────────────────────────────────────────────────
// Dep-free defensive parser: reads only the fields needed for attemptEnvelopeMeta.
// Returns null if the body isn't an object or task.requestId is absent/empty.

export interface EnvelopeLite {
  requestId: string;
  solverType: string;
  implName: string;
  implVersion: string;
  codeDigest: string;
  mode: string;
  pluginsJson: string;
  model: string;
  language: string;
  evidenceTier: string;
  sourcePublished: boolean;
}

function safeStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function parseEnvelopeLite(body: unknown): EnvelopeLite | null {
  if (body === null || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;

  // task.requestId is the join key — required.
  const task = b['task'];
  if (task === null || typeof task !== 'object') return null;
  const taskObj = task as Record<string, unknown>;
  const requestId = safeStr(taskObj['requestId']);
  if (!requestId) return null;

  // executor block
  const executor = b['executor'];
  const executorObj: Record<string, unknown> =
    executor !== null && typeof executor === 'object' ? (executor as Record<string, unknown>) : {};

  const implName = safeStr(executorObj['implName']);
  const implVersion = safeStr(executorObj['implVersion']);
  const codeDigest = safeStr(executorObj['codeDigest']);
  // mode: anything that isn't exactly 'frozen' → 'train' (absent → 'train').
  const mode = executorObj['mode'] === 'frozen' ? 'frozen' : 'train';
  const sourcePublished = executorObj['source'] != null;

  // plugins: executor.plugins should be an array; JSON.stringify it.
  let pluginsJson = '[]';
  if (Array.isArray(executorObj['plugins'])) {
    try {
      pluginsJson = JSON.stringify(executorObj['plugins']);
    } catch {
      pluginsJson = '[]';
    }
  }

  // Model label — read executor.model when present (the daemon currently does NOT
  // publish this field; tracked as jinn-mono-gbut / gh#191). Until the daemon
  // catches up, this stays '' and the explorer hides the byModel facet. When the
  // daemon starts stamping executor.model = ctx.solverNet?.model ?? ctx.claudeModel,
  // this parser path auto-lights-up — no further indexer change needed.
  //
  // Why NOT sessionProvenance.originatingTool.name: the envelope schema in
  // client/src/types/envelope.ts:170 enforces sessionProvenance only on
  // role='capture' envelopes; role='restoration' (the ones we enrich) never
  // carry it. Reading it would be 100% empty (it was, in the first cut).
  const model = safeStr(executorObj['model']);

  // language: best-effort from payload
  let language = '';
  const payload = b['payload'];
  if (payload !== null && typeof payload === 'object') {
    const payloadObj = payload as Record<string, unknown>;
    const lang = payloadObj['language'];
    if (typeof lang === 'string' && lang) {
      language = lang;
    } else {
      const repo = payloadObj['repo'];
      if (repo !== null && typeof repo === 'object') {
        const repoObj = repo as Record<string, unknown>;
        const repoLang = safeStr(repoObj['language']);
        if (repoLang) language = repoLang;
      }
    }
  }

  const evidenceTier = safeStr(b['evidenceTier']);
  const solverType = safeStr(b['solverType']);

  return {
    requestId,
    solverType,
    implName,
    implVersion,
    codeDigest,
    mode,
    pluginsJson,
    model,
    language,
    evidenceTier,
    sourcePublished,
  };
}

// ── Verdict envelope lite parser ──────────────────────────────────────────────
// For evaluation envelopes (role='verdict' or kind='evaluation'). Reads the
// ACTUAL evaluator outcome — the on-chain VerdictDeliveryClaimed.verdictCode
// defaults to Pass(1) for failed evaluations (daemon bug), so the off-chain
// envelope is the source of truth.
//
// SWE-rebench v2: payload.{passed_match,score}. Other solverTypes: payload.verdict.
// Returns null if body isn't a recognisable jinn.execution.v1 verdict envelope.

export interface VerdictEnvelopeLite {
  requestId: string;
  verdictIndex: number;
  attemptIndex: number;
  taskId: string;
  evaluator: string;
  solverType: string;
  evidenceTier: string;
  actualPassed: boolean;
  actualScore: string;
  evaluatorVerdict: 'PASS' | 'FAIL' | 'INVALID' | 'INDETERMINATE' | 'UNKNOWN';
}

function safeInt(v: unknown, def = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string') {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  if (typeof v === 'bigint') return Number(v);
  return def;
}

function normalizeVerdict(raw: unknown): 'PASS' | 'FAIL' | 'INVALID' | 'INDETERMINATE' | 'UNKNOWN' {
  if (typeof raw !== 'string') return 'UNKNOWN';
  const v = raw.trim().toUpperCase();
  if (v === 'PASS' || v === 'SCORED' || v === 'OK') return 'PASS';
  if (v === 'FAIL' || v === 'REJECTED' || v === 'FAILED') return 'FAIL';
  if (v === 'INVALID') return 'INVALID';
  if (v === 'INDETERMINATE' || v === 'UNRESOLVED' || v === 'UNKNOWN') return 'INDETERMINATE';
  return 'UNKNOWN';
}

export function parseVerdictEnvelopeLite(body: unknown): VerdictEnvelopeLite | null {
  if (body === null || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;

  // role must be 'verdict' for an evaluation envelope (execution envelopes are role='restoration').
  // We're permissive: also accept envelopes that lack role but have task.requestId + a parseable payload.
  // task.requestId is the join key — required.
  const task = b['task'];
  if (task === null || typeof task !== 'object') return null;
  const taskObj = task as Record<string, unknown>;
  const requestId = safeStr(taskObj['requestId']);
  if (!requestId) return null;

  const attemptIndex = safeInt(taskObj['attemptIndex'], 0);
  const taskId = safeStr(taskObj['taskId']) || String(taskObj['taskId'] ?? '');
  // verdictIndex may be at the top level or under task. It is diagnostic only
  // for older envelopes that omit it; requestId is the stable verdict join key.
  const verdictIndex = safeInt(b['verdictIndex'] ?? taskObj['verdictIndex'], 0);

  const solverType = safeStr(b['solverType']);
  const evidenceTier = safeStr(b['evidenceTier']);

  // participant.safeAddress → evaluator
  let evaluator = '0x';
  const participant = b['participant'];
  if (participant !== null && typeof participant === 'object') {
    const p = participant as Record<string, unknown>;
    const s = safeStr(p['safeAddress']);
    if (s) evaluator = s;
  }

  // Payload — read the verdict.
  const payload = b['payload'];
  const payloadObj: Record<string, unknown> =
    payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};

  let actualPassed = false;
  let actualScore = '';
  let evaluatorVerdict: VerdictEnvelopeLite['evaluatorVerdict'] = 'UNKNOWN';

  // SWE-rebench v2 (solverType prefix): payload.passed_match + payload.score.
  if (solverType.startsWith('swe-rebench-v2')) {
    const passedRaw =
      payloadObj['passed_match'] ?? payloadObj['passedMatch'] ?? payloadObj['passed'];
    if (typeof passedRaw === 'boolean') {
      actualPassed = passedRaw;
    } else if (typeof passedRaw === 'string') {
      actualPassed = passedRaw.toLowerCase() === 'true' || passedRaw === '1';
    }
    const scoreRaw = payloadObj['score'];
    if (typeof scoreRaw === 'number' && Number.isFinite(scoreRaw)) {
      actualScore = scoreRaw.toString();
    } else if (typeof scoreRaw === 'string') {
      actualScore = scoreRaw;
    }
    evaluatorVerdict = actualPassed ? 'PASS' : 'FAIL';
  } else {
    // Generic: payload.verdict (uppercase normalize).
    const norm = normalizeVerdict(payloadObj['verdict']);
    evaluatorVerdict = norm;
    actualPassed = norm === 'PASS';
  }

  return {
    requestId,
    verdictIndex,
    attemptIndex,
    taskId,
    evaluator,
    solverType,
    evidenceTier,
    actualPassed,
    actualScore,
    evaluatorVerdict,
  };
}

// ── IdentityRegistry: MetadataSet ────────────────────────────────────────────
// Routes by key prefix:
//   solvernet-manifest:<cid>  → upsert SolverNetManifest (most-recent-wins)
//   harness.checkpoint:<cid>  → insert HarnessCheckpoint (on-chain anchor only)
//   envelope:<cid>            → upsert Envelope
//   evaluation:<cid>          → upsert Envelope
//   capture:<cid>             → upsert Envelope

export async function handleMetadataSet({
  event,
  context,
  solverNetManifest,
  envelope,
  harnessCheckpoint,
  attemptEnvelopeMeta,
  verdictEnvelopeMeta,
  enrichEnvelopes = false,
  ipfsGateway = '',
  fetchImpl,
}: {
  event: MetadataSetEvent;
  context: HandlerContext;
  solverNetManifest: unknown;
  envelope: unknown;
  harnessCheckpoint: unknown;
  attemptEnvelopeMeta?: unknown;
  verdictEnvelopeMeta?: unknown;
  enrichEnvelopes?: boolean;
  ipfsGateway?: string;
  fetchImpl?: FetchLike;
}): Promise<void> {
  const key = event.args.metadataKey;
  const agentId = event.args.agentId.toString();
  const chainId = context.chain.id;
  const blockNumber = event.block.number;

  // ── SolverNet manifest lifecycle ─────────────────────────────────────────
  const manifestCid = parseSolverNetManifestKey(key);
  if (manifestCid !== null) {
    // Decode the lifecycle payload. The payload is JSON-encoded UTF-8 bytes
    // following the most-recent-wins spec (§6.3):
    //   { schemaVersion, status, at, hash }
    let status: 'launched' | 'paused' | 'retired' = 'launched';
    let statusUpdatedAt = new Date().toISOString();
    let manifestHash: `0x${string}` = '0x';
    let transactionIndex = 0;
    const logIndex = typeof event.log.logIndex === 'number' ? event.log.logIndex : 0;

    try {
      const payloadText = Buffer.from(event.args.metadataValue.slice(2), 'hex').toString('utf8');
      const payload = JSON.parse(payloadText) as {
        status?: string;
        at?: string;
        hash?: string;
        schemaVersion?: string;
      };
      if (payload.status === 'launched' || payload.status === 'paused' || payload.status === 'retired') {
        status = payload.status;
      }
      if (payload.at) statusUpdatedAt = payload.at;
      if (payload.hash && /^0x[0-9a-fA-F]{64}$/.test(payload.hash)) {
        manifestHash = payload.hash as `0x${string}`;
      }
      if (typeof event.transaction.transactionIndex === 'number') {
        transactionIndex = event.transaction.transactionIndex;
      }
    } catch {
      // Non-JSON payload — skip this event; it's not a valid lifecycle update.
      return;
    }

    // Most-recent-wins upsert: only update if the new event is more recent than
    // the stored one, ordered by (block, transactionIndex, logIndex). Including
    // logIndex makes two lifecycle updates in the same transaction resolve
    // deterministically (later log wins) instead of tiebreaking arbitrarily.
    await context.db
      .insert(solverNetManifest)
      .values({
        id: manifestCid,
        cidKeccak: keccak256(toBytes(manifestCid)),
        launcherAgentId: agentId,
        status,
        statusUpdatedAt,
        manifestHash,
        anchorBlock: blockNumber,
        anchorTransactionIndex: transactionIndex,
        anchorLogIndex: logIndex,
        chainId,
      })
      .onConflictDoUpdate((row) => {
        // Only update if the incoming event is more recent than the stored one.
        //
        // IMPORTANT: Drizzle's onConflictDoUpdate generates `ON CONFLICT DO UPDATE
        // SET col1 = val1, col2 = val2, ...`. Returning `{}` here would produce an
        // empty SET clause which is invalid SQL on Postgres/PGlite. The no-op path
        // must return all existing row fields so Drizzle generates a valid
        // `SET col = col, ...` statement — semantically a no-op, syntactically valid.
        const incomingIsNewer =
          blockNumber > row.anchorBlock ||
          (blockNumber === row.anchorBlock && transactionIndex > row.anchorTransactionIndex) ||
          (blockNumber === row.anchorBlock &&
            transactionIndex === row.anchorTransactionIndex &&
            logIndex > row.anchorLogIndex);
        if (incomingIsNewer) {
          return {
            cidKeccak: keccak256(toBytes(manifestCid)),
            launcherAgentId: agentId,
            status,
            statusUpdatedAt,
            manifestHash,
            anchorBlock: blockNumber,
            anchorTransactionIndex: transactionIndex,
            anchorLogIndex: logIndex,
            chainId,
          };
        }
        // No-op: return existing row fields so Drizzle generates valid SQL.
        // (SET col = col, ... is a valid no-op; SET with empty SET clause is not.)
        return {
          cidKeccak: row.cidKeccak,
          launcherAgentId: row.launcherAgentId,
          status: row.status,
          statusUpdatedAt: row.statusUpdatedAt,
          manifestHash: row.manifestHash,
          anchorBlock: row.anchorBlock,
          anchorTransactionIndex: row.anchorTransactionIndex,
          anchorLogIndex: row.anchorLogIndex,
          chainId: row.chainId,
        };
      });

    // ── SolverNet manifest body enrichment (ebu7.13 follow-up) ─────────────
    // The IPFS body at `manifestCid` carries the human-readable `name`,
    // `description`, and `solverNetId`. We enrich the on-chain row with those
    // so the SPA can display 'SWE-rebench v2' instead of the CID. Like the
    // harnessCheckpoint case, we have the PK from the on-chain event without
    // needing the body, so we can always write a 'failed' marker for retry.
    if (enrichEnvelopes) {
      try {
        const body = await fetchIpfsJson(ipfsGateway, manifestCid, {
          timeoutMs: 5000,
          fetchImpl,
        });
        const m = parseSolverNetManifestLite(body);
        if (m) {
          await context.db
            .update(solverNetManifest, { id: manifestCid })
            .set({
              name: m.name,
              description: m.description,
              solverNetId: m.solverNetId,
              manifestEnrichmentStatus: 'ok',
            });
        } else {
          console.warn(`[indexer] solvernet manifest parse failed for ${manifestCid}: body missing required 'name' field`);
          await context.db
            .update(solverNetManifest, { id: manifestCid })
            .set({ manifestEnrichmentStatus: 'failed' });
        }
      } catch (err) {
        console.warn(`[indexer] solvernet manifest enrichment failed for ${manifestCid}: ${String(err)}`);
        await context.db
          .update(solverNetManifest, { id: manifestCid })
          .set({ manifestEnrichmentStatus: 'failed' });
      }
    }

    return;
  }

  // ── HarnessCheckpoint anchor + manifest enrichment ───────────────────────
  // The on-chain value for a harness.checkpoint:<cid> MetadataSet is the
  // manifest CID string itself — not an ABI-encoded ExecutionPayload tuple.
  // The CID is already in the key; the value is redundant and intentionally
  // ignored here. The manifest body lives on IPFS.
  //
  // ebu7.9: if enrichEnvelopes is true, fetch the manifest from IPFS and
  // populate the enriched columns; mark 'ok' on success, 'failed' on error.
  // Unlike the envelope case, we DO have the PK (agentId, cid, chainId) from
  // the on-chain event without needing the body, so we can always write a
  // 'failed' marker for future batch retry.
  const checkpointCid = parseHarnessCheckpointKey(key);
  if (checkpointCid !== null) {
    const logIndex = typeof event.log.logIndex === 'number' ? event.log.logIndex : 0;
    await context.db
      .insert(harnessCheckpoint)
      .values({
        cid: checkpointCid,
        agentId,
        publishedAtBlock: blockNumber,
        logIndex,
        chainId,
        enrichmentStatus: 'pending',
      })
      .onConflictDoNothing();

    if (enrichEnvelopes) {
      try {
        const body = await fetchIpfsJson(ipfsGateway, checkpointCid, {
          timeoutMs: 5000,
          fetchImpl,
        });
        const m = parseCheckpointManifestLite(body);
        if (m) {
          await context.db
            .update(harnessCheckpoint, { agentId, cid: checkpointCid, chainId })
            .set({
              name: m.name,
              version: m.version,
              codeDigest: m.codeDigest,
              parentCheckpointCid: m.parentCheckpointCid,
              implStateDirCid: m.implStateDirCid,
              implName: m.implName,
              implVersion: m.implVersion,
              sourceBundleCid: m.sourceBundleCid,
              enrichmentStatus: 'ok',
            });
        } else {
          console.warn(`[indexer] checkpoint manifest parse failed for ${checkpointCid}: body missing required fields`);
          await context.db
            .update(harnessCheckpoint, { agentId, cid: checkpointCid, chainId })
            .set({ enrichmentStatus: 'failed' });
        }
      } catch (err) {
        console.warn(`[indexer] checkpoint manifest enrichment failed for ${checkpointCid}: ${String(err)}`);
        await context.db
          .update(harnessCheckpoint, { agentId, cid: checkpointCid, chainId })
          .set({ enrichmentStatus: 'failed' });
      }
    }

    return;
  }

  // ── Envelope (evidence / evaluation / capture) ───────────────────────────
  const envelopeKey = parseEnvelopeKey(key);
  if (envelopeKey !== null) {
    const payload = decodeEnvelopePayload(event.args.metadataValue as Hex);
    const logIndex = typeof event.log.logIndex === 'number' ? event.log.logIndex : 0;

    // Guard against empty manifestHash from total decode failures.
    // `decodeEnvelopePayload` returns `manifestHash: ''` when both V2 and V1
    // decode attempts throw. An empty string is not a valid hex value and would
    // fail the `hex()` column constraint at runtime. Substitute `'0x'` (a valid
    // zero-length hex sentinel) so the row is written and the event is not lost.
    // The daemon compensates: canClaimTask and corpus-fetch verify content via
    // the IPFS manifest hash independently of this indexed copy.
    const manifestHash = (payload.manifestHash || '0x') as `0x${string}`;

    await context.db
      .insert(envelope)
      .values({
        agentId,
        metadataKey: key,
        chainId,
        kind: envelopeKey.kind,
        manifestCid: envelopeKey.cid,
        manifestHash,
        evidenceTier: payload.evidenceTier,
        publishedAtBlock: blockNumber,
        logIndex,
      })
      .onConflictDoUpdate((row) => {
        // Most-recent-wins: if the same agent re-publishes to the same key,
        // keep the later event ordered by (publishedAtBlock, logIndex). Two
        // MetadataSet events in the same block must compare logIndex so they
        // resolve deterministically (later log wins) rather than letting the
        // unconditional update clobber a newer row with an older one.
        //
        // The no-op branch returns existing row fields so Drizzle emits a valid
        // `SET col = col, ...` rather than an empty SET clause.
        const incomingIsNewer =
          blockNumber > row.publishedAtBlock ||
          (blockNumber === row.publishedAtBlock && logIndex >= row.logIndex);
        if (incomingIsNewer) {
          return {
            manifestHash,
            evidenceTier: payload.evidenceTier,
            publishedAtBlock: blockNumber,
            logIndex,
          };
        }
        return {
          manifestHash: row.manifestHash,
          evidenceTier: row.evidenceTier,
          publishedAtBlock: row.publishedAtBlock,
          logIndex: row.logIndex,
        };
      });

    // ── Envelope enrichment → attemptEnvelopeMeta ──────────────────────────
    // Only for execution envelopes (kind === 'envelope'), not evaluation or
    // capture. attemptEnvelopeMeta is optional for backward compat with callers
    // that don't pass it (the existing test suite without enrichEnvelopes).
    if (envelopeKey.kind === 'envelope' && enrichEnvelopes && attemptEnvelopeMeta) {
      try {
        const body = await fetchIpfsJson(ipfsGateway, envelopeKey.cid, {
          timeoutMs: 5000,
          fetchImpl,
        });
        const meta = parseEnvelopeLite(body);
        if (meta) {
          await context.db
            .insert(attemptEnvelopeMeta)
            .values({
              requestId: meta.requestId as `0x${string}`,
              manifestCid: envelopeKey.cid,
              solverType: meta.solverType,
              implName: meta.implName,
              implVersion: meta.implVersion,
              codeDigest: meta.codeDigest,
              mode: meta.mode,
              pluginsJson: meta.pluginsJson,
              model: meta.model,
              language: meta.language,
              evidenceTier: meta.evidenceTier,
              sourcePublished: meta.sourcePublished,
              enrichmentStatus: 'ok',
              enrichedAtBlock: blockNumber,
              chainId,
            })
            .onConflictDoUpdate((row) => {
              // Most-recent-wins: only update if the incoming event is at least
              // as recent as the stored enrichment. Stale replays are no-ops.
              if (blockNumber >= row.enrichedAtBlock) {
                return {
                  manifestCid: envelopeKey.cid,
                  solverType: meta.solverType,
                  implName: meta.implName,
                  implVersion: meta.implVersion,
                  codeDigest: meta.codeDigest,
                  mode: meta.mode,
                  pluginsJson: meta.pluginsJson,
                  model: meta.model,
                  language: meta.language,
                  evidenceTier: meta.evidenceTier,
                  sourcePublished: meta.sourcePublished,
                  enrichmentStatus: 'ok',
                  enrichedAtBlock: blockNumber,
                  chainId,
                };
              }
              // No-op: return existing row fields so Drizzle generates valid SQL.
              return {
                manifestCid: row.manifestCid,
                solverType: row.solverType,
                implName: row.implName,
                implVersion: row.implVersion,
                codeDigest: row.codeDigest,
                mode: row.mode,
                pluginsJson: row.pluginsJson,
                model: row.model,
                language: row.language,
                evidenceTier: row.evidenceTier,
                sourcePublished: row.sourcePublished,
                enrichmentStatus: row.enrichmentStatus,
                enrichedAtBlock: row.enrichedAtBlock,
                chainId: row.chainId,
              };
            });
        }
      } catch (err) {
        console.warn(`[indexer] envelope enrichment failed for ${envelopeKey.cid}: ${String(err)}`);
        // no row — we have no requestId without the body; Ponder reprocesses on next sync.
      }
    }

    // ── Evaluation envelope enrichment → verdictEnvelopeMeta (ebu7.13) ─────
    // Only for evaluation envelopes (kind === 'evaluation'). The off-chain body
    // carries the evaluator's ACTUAL outcome — the on-chain verdictCode is
    // submitted as Pass(1) by default in the daemon (client/src/adapters/mech/
    // adapter.ts:899 + engine.ts:1751 fall-through), so failed evaluations
    // appear as Pass on-chain. The envelope is the source of truth.
    // verdictEnvelopeMeta is optional for backward compat with callers/tests
    // that don't pass it.
    if (envelopeKey.kind === 'evaluation' && enrichEnvelopes && verdictEnvelopeMeta) {
      try {
        const body = await fetchIpfsJson(ipfsGateway, envelopeKey.cid, {
          timeoutMs: 5000,
          fetchImpl,
        });
        const meta = parseVerdictEnvelopeLite(body);
        if (meta) {
          await context.db
            .insert(verdictEnvelopeMeta)
            .values({
              requestId: meta.requestId as `0x${string}`,
              verdictIndex: meta.verdictIndex,
              attemptIndex: meta.attemptIndex,
              taskId: meta.taskId,
              evaluator: meta.evaluator as `0x${string}`,
              manifestCid: envelopeKey.cid,
              solverType: meta.solverType,
              evidenceTier: meta.evidenceTier,
              actualPassed: meta.actualPassed,
              actualScore: meta.actualScore,
              evaluatorVerdict: meta.evaluatorVerdict,
              enrichmentStatus: 'ok',
              enrichedAtBlock: blockNumber,
              chainId,
            })
            .onConflictDoUpdate((row) => {
              // Most-recent-wins by enrichedAtBlock. Stale replays no-op.
              if (blockNumber >= row.enrichedAtBlock) {
                return {
                  verdictIndex: meta.verdictIndex,
                  attemptIndex: meta.attemptIndex,
                  taskId: meta.taskId,
                  evaluator: meta.evaluator as `0x${string}`,
                  manifestCid: envelopeKey.cid,
                  solverType: meta.solverType,
                  evidenceTier: meta.evidenceTier,
                  actualPassed: meta.actualPassed,
                  actualScore: meta.actualScore,
                  evaluatorVerdict: meta.evaluatorVerdict,
                  enrichmentStatus: 'ok',
                  enrichedAtBlock: blockNumber,
                  chainId,
                };
              }
              // No-op: return existing row fields so Drizzle generates valid SQL.
              return {
                verdictIndex: row.verdictIndex,
                attemptIndex: row.attemptIndex,
                taskId: row.taskId,
                evaluator: row.evaluator,
                manifestCid: row.manifestCid,
                solverType: row.solverType,
                evidenceTier: row.evidenceTier,
                actualPassed: row.actualPassed,
                actualScore: row.actualScore,
                evaluatorVerdict: row.evaluatorVerdict,
                enrichmentStatus: row.enrichmentStatus,
                enrichedAtBlock: row.enrichedAtBlock,
                chainId: row.chainId,
              };
            });
        }
      } catch (err) {
        console.warn(`[indexer] verdict envelope enrichment failed for ${envelopeKey.cid}: ${String(err)}`);
        // no row — we have no requestId without the body; Ponder reprocesses on next sync.
      }
    }

    return;
  }

  // Any other key (e.g. future metadata types) — no-op.
}

// ── JinnDistributor: Claimed → rewardDistribution ────────────────────────────
export async function handleClaimed({
  event,
  context,
  rewardDistribution,
}: {
  event: ClaimedEvent;
  context: HandlerContext;
  rewardDistribution: unknown;
}): Promise<void> {
  const logIndex = typeof event.log.logIndex === 'number' ? event.log.logIndex : 0;
  await context.db
    .insert(rewardDistribution)
    .values({
      serviceId: event.args.serviceId.toString(),
      multisig: event.args.multisig,
      operatorMinted: event.args.operatorMinted,
      daoMinted: event.args.daoMinted,
      totalEntitledOperator: event.args.totalEntitledOperator,
      totalEntitledDao: event.args.totalEntitledDao,
      claimedAtBlock: event.block.number,
      logIndex,
      claimedAtTx: event.transaction.hash,
      chainId: context.chain.id,
    })
    .onConflictDoNothing();
}
