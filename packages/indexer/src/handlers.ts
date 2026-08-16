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
import { decodeAbiParameters, isAddress, keccak256, toBytes, type Hex } from 'viem';
import { STOLAS_STAKING_PROXY_ABI } from '../abis/StolasStakingProxy.js';
import {
  parseEnvelopeKey,
  parsePluginKey,
  parseHarnessCheckpointKey,
  parseSolverNetManifestKey,
  tierFromRaw,
} from './types.js';
import { fetchIpfsJson, type FetchLike } from './ipfs.js';
import {
  safeStr,
  parseVerdictEnvelopeLite,
  resolveInstanceFields,
  type VerdictEnvelopeLite,
} from './enrichment-parse.js';

// Re-exported for the test suite (test/handlers.test.ts imports
// parseVerdictEnvelopeLite from '../src/handlers.js') and any downstream
// consumer that still reaches for these via the handlers module. The single
// definition lives in ./enrichment-parse.ts (#779).
export { parseVerdictEnvelopeLite };
export type { VerdictEnvelopeLite };

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
  /**
   * Count delivered verdict rows for one attempt scope — the indexer's proxy for
   * TaskCoordinator's on-chain `validVerdictCount`. One indexed `verdict` row per
   * delivered verdict (one `VerdictDeliveryClaimed` event). Used by
   * handleVerdictDeliveryClaimed to recompute task.finalized (issue #530).
   *
   * Real wiring (src/index.ts) backs this with `context.db.sql` (Ponder's raw
   * drizzle escape hatch); the in-memory fake scans its rows.
   */
  countVerdicts: (
    table: unknown,
    scope: { taskId: string; attemptIndex: number; chainId: number },
  ) => Promise<number>;
}

export interface HandlerContext {
  db: HandlerDb;
  chain: { id: number };
  client?: {
    readContract: (opts: Record<string, unknown>) => Promise<unknown>;
  };
}

export interface BlockShape {
  number: bigint;
  timestamp: bigint;
}
export interface TransactionShape {
  hash: `0x${string}`;
  transactionIndex?: number;
}
export interface LogShape {
  address?: `0x${string}`;
  logIndex?: number;
}

export interface TaskCreatedEvent {
  args: {
    creator: `0x${string}`;
    taskId: bigint;
    manifestDigest: `0x${string}`;
    taskCidDigest: `0x${string}`;
    maxClaims: bigint | number;
    // Tokenless TaskCreated events omit this; handler defaults to 1 for
    // first-verdict finalization.
    requiredVerdicts?: bigint | number;
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

export interface RewardsDistributedEvent {
  args: {
    serviceId: bigint;
    multisig: `0x${string}`;
    collectorAmount: bigint;
    protocolAmount: bigint;
    curatingAgentAmount: bigint;
  };
  block: BlockShape;
  transaction: TransactionShape;
  log: LogShape;
}

export interface ServiceStakedEvent {
  args: {
    epoch: bigint;
    serviceId: bigint;
    owner: `0x${string}`;
    multisig: `0x${string}`;
    nonces: readonly bigint[];
  };
  block: BlockShape;
  transaction: TransactionShape;
  log: LogShape;
}

export interface StakingCheckpointEvent {
  args: {
    epoch: bigint;
    availableRewards: bigint;
    serviceIds: readonly bigint[];
    rewards: readonly bigint[];
    epochLength: bigint;
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

const TOKENLESS_FIRST_VERDICT_REQUIRED_VERDICTS = 1;

function requiredVerdictsFromTaskCreated(value: bigint | number | undefined): number {
  return value === undefined ? TOKENLESS_FIRST_VERDICT_REQUIRED_VERDICTS : Number(value);
}

function requiredVerdictsForFinalization(value: number): number {
  return value <= 0 ? TOKENLESS_FIRST_VERDICT_REQUIRED_VERDICTS : value;
}

// ── ABI tuple for payload decoding ────────────────────────────────────────────
// Matches PAYLOAD_TUPLE_V2 in operator/src/erc8004/abis.ts. We try V2 first,
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

// ── Plug-in publication tuples (attd) ────────────────────────────────────────
// Byte-identical to PLUGIN_PAYLOAD_TUPLE / REVOCATION_PAYLOAD_TUPLE in
// operator/src/erc8004/abis.ts — the indexer package cannot import from operator/,
// so these are duplicated here and guarded by the drift test in
// test/handlers.plugin.test.ts.

export const PLUGIN_PAYLOAD_TUPLE = [
  { name: 'version', type: 'uint8' },
  { name: 'pluginName', type: 'string' },
  { name: 'pluginVersion', type: 'string' },
  { name: 'pluginSha256', type: 'bytes32' },
  { name: 'supports', type: 'string[]' },
  { name: 'publishedAt', type: 'uint64' },
] as const;

export const REVOCATION_PAYLOAD_TUPLE = [
  { name: 'version', type: 'uint8' },
  { name: 'revoked', type: 'bool' },
  { name: 'reason', type: 'string' },
] as const;

export interface DecodedPluginPayload {
  version: number;
  pluginName: string;
  pluginVersion: string;
  pluginSha256: `0x${string}`;
  supports: readonly string[];
  publishedAt: bigint;
}

export interface DecodedRevocationPayload {
  version: number;
  revoked: boolean;
  reason: string;
}

/**
 * Decodes a plug-in publication v1 payload. Returns null on decode failure
 * (the handler skips the event — same shape as decodeEnvelopePayload, which
 * returns a sentinel rather than throwing, but here we use null because the
 * payload is the entire row, not just two fields).
 */
export function decodePluginPayload(value: Hex): DecodedPluginPayload | null {
  try {
    const decoded = decodeAbiParameters(PLUGIN_PAYLOAD_TUPLE, value);
    return {
      version: Number(decoded[0]),
      pluginName: decoded[1],
      pluginVersion: decoded[2],
      pluginSha256: decoded[3],
      supports: decoded[4],
      publishedAt: decoded[5],
    };
  } catch {
    return null;
  }
}

export function decodeRevocationPayload(value: Hex): DecodedRevocationPayload | null {
  try {
    const decoded = decodeAbiParameters(REVOCATION_PAYLOAD_TUPLE, value);
    return {
      version: Number(decoded[0]),
      revoked: decoded[1],
      reason: decoded[2],
    };
  } catch {
    return null;
  }
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
      requiredVerdicts: requiredVerdictsFromTaskCreated(event.args.requiredVerdicts),
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

// ── JinnRouter: VerdictDeliveryClaimed → verdict (+ recompute task.finalized) ─
// One row per delivered verdict. verdictCode 0..4 per the VerdictCode enum.
// Idempotent: a replayed event with the same (taskId, attemptIndex, verdictIndex,
// chainId) does not clobber the original (onConflictDoNothing).
//
// Finalization (issue #530 / #1304): on the current tokenless JinnRouter V3,
// TaskCoordinator.recordVerdict finalizes on the first delivered verdict when
// TaskCreated omits requiredVerdicts. Older rows persisted that omission as 0,
// so non-positive requiredVerdicts are normalized to 1 for finalization. When a
// legacy event explicitly carries requiredVerdicts > 1, it still requires that
// many delivered verdicts.
//
// VerdictDeliveryClaimed fires once per *delivered* verdict, so the count of
// delivered `verdict` rows for this attempt scope equals validVerdictCount.
// After inserting the verdict row, recompute: finalized iff deliveredCount >=
// normalized requiredVerdicts. Mirrors metrics.ts:attemptFinalization.
// Monotonic — never flips finalized back to false (db.update only ever sets it
// to true here).
//
// Existence guard (mirrors handleSolutionDeliveryClaimed): the matching
// TaskCreated may predate `startBlock`, leaving no `task` row. db.update on a
// missing row throws and crashes the indexer, so look it up first and skip the
// finalized recompute if absent. The verdict row is still written either way.
export async function handleVerdictDeliveryClaimed({
  event,
  context,
  verdict,
  task,
}: {
  event: VerdictDeliveryClaimedEvent;
  context: HandlerContext;
  verdict: unknown;
  task: unknown;
}): Promise<void> {
  const taskId = event.args.taskId.toString();
  const attemptIndex = Number(event.args.attemptIndex);
  const chainId = context.chain.id;

  await context.db
    .insert(verdict)
    .values({
      taskId,
      attemptIndex,
      verdictIndex: Number(event.args.verdictIndex),
      evaluator: event.args.evaluator,
      requestId: event.args.requestId,
      verdictCode: Number(event.args.verdictCode),
      createdAtBlock: event.block.number,
      chainId,
    })
    .onConflictDoNothing();

  // Recompute finalized from normalized requiredVerdicts vs delivered verdicts.
  const existing = (await context.db.find(task, { id: taskId })) as
    | { requiredVerdicts: number; finalized: boolean }
    | null;
  if (!existing) return; // TaskCreated predates startBlock — skip; verdict row already written.
  if (existing.finalized) return; // Monotonic — already final, nothing to do.

  const requiredVerdicts = requiredVerdictsForFinalization(existing.requiredVerdicts);

  const deliveredCount = await context.db.countVerdicts(verdict, {
    taskId,
    attemptIndex,
    chainId,
  });
  if (deliveredCount >= requiredVerdicts) {
    await context.db.update(task, { id: taskId }).set({ finalized: true });
  }
}

// ── JinnRouter: SolutionDeliveryClaimed ──────────────────────────────────────
// A solution-slot delivery — the START of the evaluation phase, NOT finalization
// (issue #530 / #1304). On-chain finalization happens on verdict delivery and
// is handled in handleVerdictDeliveryClaimed. This handler deliberately does
// NOT touch task.finalized.
//
// At v0.1 there is nothing for this handler to persist beyond what TaskAttempt /
// Verdict events already record, but it keeps the existence guard + signature so
// src/index.ts can still register it (and so a future per-attempt
// solution-delivery column has a home). The guard: the matching TaskCreated may
// predate `startBlock`, leaving no `task` row; we look it up and skip if absent
// rather than crash. The daemon's canClaimTask simulation is the correctness
// gate regardless.
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
  // Intentionally a no-op on task.finalized — see issues #530 and #1304.
  // SolutionDeliveryClaimed is the start of evaluation; finalization is
  // recomputed in handleVerdictDeliveryClaimed from delivered-verdict count vs
  // normalized requiredVerdicts.
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

// ── ExternalStakingDistributor: RewardsDistributed → rewardDistribution ─────

export async function handleRewardsDistributed({
  event,
  context,
  rewardDistribution,
}: {
  event: RewardsDistributedEvent;
  context: HandlerContext;
  rewardDistribution: unknown;
}): Promise<void> {
  await context.db
    .insert(rewardDistribution)
    .values({
      serviceId: event.args.serviceId.toString(),
      multisig: event.args.multisig,
      operatorRewarded: event.args.collectorAmount,
      protocolRewarded: event.args.protocolAmount,
      curatingAgentRewarded: event.args.curatingAgentAmount,
      claimedAtBlock: event.block.number,
      claimedAtTimestamp: event.block.timestamp,
      logIndex: event.log.logIndex ?? 0,
      claimedAtTx: event.transaction.hash,
      chainId: context.chain.id,
    })
    .onConflictDoNothing();
}

// ── StolasStakingProxy: ServiceStaked → stakingService ───────────────────────

export async function handleServiceStaked({
  event,
  context,
  stakingService,
}: {
  event: ServiceStakedEvent;
  context: HandlerContext;
  stakingService: unknown;
}): Promise<void> {
  const stakingProxy = event.log.address;
  if (!stakingProxy) return;

  await context.db
    .insert(stakingService)
    .values({
      serviceId: event.args.serviceId.toString(),
      stakingProxy,
      owner: event.args.owner,
      multisig: event.args.multisig,
      stakedAtBlock: event.block.number,
      stakedAtTimestamp: event.block.timestamp,
      stakedAtTx: event.transaction.hash,
      chainId: context.chain.id,
    })
    .onConflictDoUpdate({
      owner: event.args.owner,
      multisig: event.args.multisig,
      stakedAtBlock: event.block.number,
      stakedAtTimestamp: event.block.timestamp,
      stakedAtTx: event.transaction.hash,
    });
}

// ── StolasStakingProxy: Checkpoint → stakingRewardCheckpoint ─────────────────

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

function parseServiceInfoAddress(value: unknown): `0x${string}` | null {
  if (typeof value !== 'string' || !isAddress(value) || value.toLowerCase() === ZERO_ADDRESS) {
    return null;
  }
  return value as `0x${string}`;
}

async function resolveCheckpointService({
  context,
  stakingService,
  stakingProxy,
  serviceId,
  event,
}: {
  context: HandlerContext;
  stakingService: unknown;
  stakingProxy: `0x${string}`;
  serviceId: string;
  event: StakingCheckpointEvent;
}): Promise<{ multisig: `0x${string}` } | null> {
  const chainId = context.chain.id;
  const existing = (await context.db.find(stakingService, {
    chainId,
    stakingProxy,
    serviceId,
  })) as { multisig?: `0x${string}` } | null;
  if (existing?.multisig) return { multisig: existing.multisig };

  if (!context.client?.readContract) return null;

  try {
    const serviceInfo = await context.client.readContract({
      address: stakingProxy,
      abi: STOLAS_STAKING_PROXY_ABI,
      functionName: 'mapServiceInfo',
      args: [BigInt(serviceId)],
      blockNumber: event.block.number,
    });

    const tuple = serviceInfo as readonly unknown[];
    const object = serviceInfo as { multisig?: unknown; owner?: unknown };
    const multisig = parseServiceInfoAddress(Array.isArray(tuple) ? tuple[0] : object.multisig);
    if (!multisig) return null;

    const owner = parseServiceInfoAddress(Array.isArray(tuple) ? tuple[1] : object.owner) ?? ZERO_ADDRESS;
    await context.db
      .insert(stakingService)
      .values({
        serviceId,
        stakingProxy,
        owner,
        multisig,
        stakedAtBlock: event.block.number,
        stakedAtTimestamp: event.block.timestamp,
        stakedAtTx: event.transaction.hash,
        chainId,
      })
      .onConflictDoNothing();

    return { multisig };
  } catch {
    return null;
  }
}

export async function handleStakingCheckpoint({
  event,
  context,
  stakingService,
  stakingRewardCheckpoint,
}: {
  event: StakingCheckpointEvent;
  context: HandlerContext;
  stakingService: unknown;
  stakingRewardCheckpoint: unknown;
}): Promise<void> {
  const stakingProxy = event.log.address;
  if (!stakingProxy) return;

  const chainId = context.chain.id;
  const logIndex = event.log.logIndex ?? 0;
  const count = Math.min(event.args.serviceIds.length, event.args.rewards.length);

  for (let i = 0; i < count; i++) {
    const serviceId = event.args.serviceIds[i]?.toString();
    const reward = event.args.rewards[i];
    if (!serviceId || reward === undefined) continue;

    const service = await resolveCheckpointService({
      context,
      stakingService,
      stakingProxy,
      serviceId,
      event,
    });
    if (!service?.multisig) continue;

    await context.db
      .insert(stakingRewardCheckpoint)
      .values({
        serviceId,
        stakingProxy,
        multisig: service.multisig,
        epoch: event.args.epoch.toString(),
        reward,
        epochLength: event.args.epochLength,
        checkpointAtBlock: event.block.number,
        checkpointAtTimestamp: event.block.timestamp,
        logIndex,
        checkpointAtTx: event.transaction.hash,
        chainId,
      })
      .onConflictDoNothing();
  }
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
  network: string;
  solutionPriceWei: string;
  verdictPriceWei: string;
  openRoles: string[];
  launcherSafeAddress: string;
  contractId: string;
  contractVersion: string;
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

  // Issue #985 criterion 1: read the remaining summary fields with the same
  // defensive reads. Field sources are manifest-schema.ts: top-level network /
  // solutionPriceWei / verdictPriceWei / openRoles; nested launcher.safeAddress;
  // nested contract.id / contract.version.
  const network = safeStr(b['network']);
  const solutionPriceWei = safeStr(b['solutionPriceWei']);
  const verdictPriceWei = safeStr(b['verdictPriceWei']);
  const openRoles = Array.isArray(b['openRoles'])
    ? (b['openRoles'] as unknown[]).filter((r): r is string => typeof r === 'string')
    : [];
  const launcher = b['launcher'];
  const launcherObj: Record<string, unknown> =
    launcher !== null && typeof launcher === 'object' ? (launcher as Record<string, unknown>) : {};
  const launcherSafeAddress = safeStr(launcherObj['safeAddress']);
  const contract = b['contract'];
  const contractObj: Record<string, unknown> =
    contract !== null && typeof contract === 'object' ? (contract as Record<string, unknown>) : {};
  const contractId = safeStr(contractObj['id']);
  const contractVersion = safeStr(contractObj['version']);

  return {
    name,
    description,
    solverNetId,
    network,
    solutionPriceWei,
    verdictPriceWei,
    openRoles,
    launcherSafeAddress,
    contractId,
    contractVersion,
  };
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
  // operator/src/types/envelope.ts:170 enforces sessionProvenance only on
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

// `parseVerdictEnvelopeLite`, `VerdictEnvelopeLite`, and the swe-rebench-v2
// `resolveInstanceFields` resolver moved to ./enrichment-parse.ts (#779) so the
// standalone enrichment worker shares one definition with this handler and they
// cannot drift. They are imported + re-exported at the top of this file.

// ── Capture-envelope signal parsers (#1314, #1842) ───────────────────────────
// Dep-free defensive parsers for the two-hop capture enrichment. New wrappers
// carry canonical `jinn.episode.v1` evidence; `jinn.trace-envelope.v0` remains
// frozen read compatibility. Artifact IPFS bodies may use the donation
// encoding (base64 `data`) or expose the evidence payload directly.

const EPISODE_ARTIFACT_TYPE = 'jinn.episode.v1' as const;
const TRACE_ENVELOPE_ARTIFACT_TYPE = 'jinn.trace-envelope.v0' as const;
const RETRIEVAL_VISIBLE_TAG = 'retrieval:visible.v1' as const;
export type EvidenceArtifactType =
  | typeof EPISODE_ARTIFACT_TYPE
  | typeof TRACE_ENVELOPE_ARTIFACT_TYPE;

export interface CaptureWrapperLite {
  /** participant.safeAddress — the contributor identity. */
  contributor: string;
  /** Canonical episode for new publications; trace-envelope for read compatibility. */
  artifactType: EvidenceArtifactType;
  /** IPFS cid of the evidence artifact. */
  evidenceArtifactCid: string;
}

export function parseCaptureWrapperLite(body: unknown): CaptureWrapperLite | null {
  if (body === null || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;

  const participant = b['participant'];
  const participantObj: Record<string, unknown> =
    participant !== null && typeof participant === 'object'
      ? (participant as Record<string, unknown>)
      : {};
  const contributor = safeStr(participantObj['safeAddress']);

  if (!Array.isArray(b['artifacts'])) return null;
  const artifacts = b['artifacts'] as unknown[];
  // Prefer the canonical payload even when a transitional wrapper carries
  // both types and happens to list the legacy trace first.
  for (const artifactType of [EPISODE_ARTIFACT_TYPE, TRACE_ENVELOPE_ARTIFACT_TYPE]) {
    for (const artifact of artifacts) {
      if (artifact === null || typeof artifact !== 'object') continue;
      const a = artifact as Record<string, unknown>;
      if (a['artifactType'] !== artifactType || !Array.isArray(a['sources'])) continue;
      for (const source of a['sources'] as unknown[]) {
        if (source === null || typeof source !== 'object') continue;
        const cid = safeStr((source as Record<string, unknown>)['cid']);
        if (cid) return { contributor, artifactType, evidenceArtifactCid: cid };
      }
    }
  }
  return null;
}

export interface TraceEnvelopeSignalLite {
  taskSummary: string;
  /** JSON.stringify(task.distributionTags) — '[]' when absent. */
  tagsJson: string;
  /** task.repositorySlug — '' when absent. */
  repositorySlug: string;
  /** Authored outcome/seed synthesis — '' when absent. */
  synthesis: string;
  /** Canonical named W2 projection; legacy traces derive it from their tag. */
  retrievalVisible: boolean;
  provenance: 'contributed' | 'imported' | 'derived-from-history';
  /** Compatibility projection of Episode verificationStrength / trace verifiabilityTier. */
  verifiabilityTier: string;
  /** environment.harness as "<name> <version>", '' when absent. Corpus detail (#1406). */
  harness: string;
  /** environment.model, '' when absent. Corpus detail (#1406). */
  model: string;
  /** JSON.stringify(environment.tools) — '[]' when absent. Corpus detail (#1406). */
  toolsJson: string;
  /** steps.length — 0 when absent. Corpus index + detail (#1406). */
  stepCount: number;
}

export function parseTraceEnvelopeSignalLite(
  body: unknown,
  expectedArtifactType: EvidenceArtifactType,
): TraceEnvelopeSignalLite | null {
  if (body === null || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;

  // The artifact body may be the donation encoding:
  // { data: base64(evidence JSON) }. Tolerate a raw evidence body too.
  let evidence: Record<string, unknown> = b;
  const data = b['data'];
  if (typeof data === 'string' && data) {
    if (b['artifactType'] !== expectedArtifactType) return null;
    try {
      evidence = JSON.parse(
        Buffer.from(data, 'base64').toString('utf-8'),
      ) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  if (evidence === null || typeof evidence !== 'object') return null;
  if (evidence['schemaVersion'] !== expectedArtifactType) return null;
  const isEpisode = expectedArtifactType === EPISODE_ARTIFACT_TYPE;

  const task = evidence['task'];
  const taskObj: Record<string, unknown> =
    task !== null && typeof task === 'object' ? (task as Record<string, unknown>) : {};
  const taskSummary = safeStr(taskObj['summary']);
  const repositorySlug = safeStr(taskObj['repositorySlug']);

  let tagsJson = '[]';
  let distributionTags: string[] = [];
  if (Array.isArray(taskObj['distributionTags'])) {
    try {
      distributionTags = (taskObj['distributionTags'] as unknown[])
        .filter((t): t is string => typeof t === 'string');
      tagsJson = JSON.stringify(distributionTags);
    } catch {
      tagsJson = '[]';
      distributionTags = [];
    }
  }

  const provenance =
    evidence['provenance'] === 'imported' ||
    evidence['provenance'] === 'derived-from-history'
      ? evidence['provenance']
      : 'contributed';

  const outcome = evidence['outcome'];
  const outcomeObj: Record<string, unknown> =
    outcome !== null && typeof outcome === 'object' ? (outcome as Record<string, unknown>) : {};
  const verifiabilityTier = safeStr(
    outcomeObj[isEpisode ? 'verificationStrength' : 'verifiabilityTier'],
  );

  const stepsRaw = evidence[isEpisode ? 'trajectory' : 'steps'];
  const steps = Array.isArray(stepsRaw) ? stepsRaw : [];
  let synthesis = safeStr(outcomeObj['summary']);
  if (!synthesis) {
    for (const step of steps) {
      if (step === null || typeof step !== 'object') continue;
      const attributes = (step as Record<string, unknown>)['attributes'];
      if (attributes === null || typeof attributes !== 'object') continue;
      synthesis = safeStr((attributes as Record<string, unknown>)['seed.synthesis']);
      if (synthesis) break;
    }
  }
  const retrievalVisible = Object.prototype.hasOwnProperty.call(evidence, 'retrievalVisible')
    ? evidence['retrievalVisible'] === true
    : distributionTags.includes(RETRIEVAL_VISIBLE_TAG);

  // ── Detail-view fields (#1406): environment fingerprint + step count. ──
  const environment = evidence['environment'];
  const envObj: Record<string, unknown> =
    environment !== null && typeof environment === 'object'
      ? (environment as Record<string, unknown>)
      : {};

  const harnessRaw = envObj['harness'];
  const harnessObj: Record<string, unknown> =
    harnessRaw !== null && typeof harnessRaw === 'object'
      ? (harnessRaw as Record<string, unknown>)
      : {};
  const harnessName = safeStr(harnessObj['name']);
  const harnessVersion = safeStr(harnessObj['version']);
  const harness = harnessName && harnessVersion ? `${harnessName} ${harnessVersion}` : harnessName;

  const model = safeStr(envObj['model']);

  let toolsJson = '[]';
  if (Array.isArray(envObj['tools'])) {
    try {
      toolsJson = JSON.stringify(
        (envObj['tools'] as unknown[]).filter((t) => typeof t === 'string'),
      );
    } catch {
      toolsJson = '[]';
    }
  }

  const stepCount = steps.length;

  return {
    taskSummary,
    tagsJson,
    repositorySlug,
    synthesis,
    retrievalVisible,
    provenance,
    verifiabilityTier,
    harness,
    model,
    toolsJson,
    stepCount,
  };
}

// ── IdentityRegistry: MetadataSet ────────────────────────────────────────────
// Routes by key prefix:
//   solvernet-manifest:<cid>  → upsert SolverNetManifest (most-recent-wins)
//   harness.checkpoint:<cid>  → insert HarnessCheckpoint (on-chain anchor only)
//   envelope:<cid>            → upsert Envelope
//   evaluation:<cid>          → upsert Envelope
//   capture:<cid>             → upsert Envelope
//   skill:<cid>               → upsert Envelope (jinn.skill.v1 layer-2 consumable; no enrichment)

export async function handleMetadataSet({
  event,
  context,
  solverNetManifest,
  envelope,
  pluginPublication,
  harnessCheckpoint,
  attemptEnvelopeMeta,
  verdictEnvelopeMeta,
  captureEnvelopeMeta,
  enrichEnvelopes = false,
  enrichVerdicts = false,
  enrichCaptures = false,
  ipfsGateway = '',
  fetchImpl,
}: {
  event: MetadataSetEvent;
  context: HandlerContext;
  solverNetManifest: unknown;
  envelope: unknown;
  pluginPublication?: unknown;
  harnessCheckpoint?: unknown;
  attemptEnvelopeMeta?: unknown;
  verdictEnvelopeMeta?: unknown;
  captureEnvelopeMeta?: unknown;
  /**
   * Governs in-handler IPFS enrichment of the execution-envelope
   * (attemptEnvelopeMeta), solverNetManifest, and harnessCheckpoint paths.
   * Unchanged by #779.
   */
  enrichEnvelopes?: boolean;
  /**
   * Governs in-handler IPFS enrichment of the EVALUATION (verdict) path →
   * verdictEnvelopeMeta. Split out from enrichEnvelopes by #779 so the verdict
   * path can default OFF (the enrichment worker owns it) while leaving the
   * execution path's behaviour unchanged. `true` restores in-handler verdict
   * enrichment (the AC5 rollback lever); default `false` writes verdict anchors
   * only. index.ts wires this from the SAME JINN_INDEXER_ENRICH_ENVELOPES env
   * but defaulting off.
   */
  enrichVerdicts?: boolean;
  /**
   * Governs in-handler IPFS enrichment of the CAPTURE path →
   * captureEnvelopeMeta (#1314, the distribution signal's data). Two IPFS
   * fetches per capture anchor (wrapper envelope, then its trace artifact).
   */
  enrichCaptures?: boolean;
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
              network: m.network,
              solutionPriceWei: m.solutionPriceWei,
              verdictPriceWei: m.verdictPriceWei,
              openRoles: m.openRoles,
              launcherSafeAddress: m.launcherSafeAddress,
              contractId: m.contractId,
              contractVersion: m.contractVersion,
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
              publisherAgentId: agentId,
              manifestHash,
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
              // The composite PK makes this conflict specific to one
              // publisher/CID candidate. Competing candidates insert separate
              // rows; only replays of this exact anchor are most-recent-wins.
              if (blockNumber >= row.enrichedAtBlock) {
                return {
                  manifestHash,
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
                };
              }
              // No-op: return existing row fields so Drizzle generates valid SQL.
              return {
                manifestHash: row.manifestHash,
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
    // submitted as Pass(1) by default in the daemon (operator/src/adapters/mech/
    // adapter.ts:899 + engine.ts:1751 fall-through), so failed evaluations
    // appear as Pass on-chain. The envelope is the source of truth.
    // verdictEnvelopeMeta is optional for backward compat with callers/tests
    // that don't pass it.
    if (envelopeKey.kind === 'evaluation' && enrichVerdicts && verdictEnvelopeMeta) {
      try {
        const body = await fetchIpfsJson(ipfsGateway, envelopeKey.cid, {
          timeoutMs: 5000,
          fetchImpl,
        });
        const meta = parseVerdictEnvelopeLite(body);
        if (meta) {
          // The verdict payload does NOT carry instance_id
          // (SweRebenchV2VerdictPayloadSchema in
          // packages/sdk/src/payloads/swe-rebench-v2.ts), so for
          // swe-rebench-v2 verdicts the only honest source is the task body
          // itself — fetched here via meta.taskCid. Gated by solverType so
          // other types pay no extra IPFS round-trip. Failures degrade
          // gracefully: instanceId stays '' and the launcher falls back to
          // its local counter for that instance (#669).
          //
          // We also read the task body's top-level `solverNetManifestCid`
          // (task.v1 schema; see operator/src/types/task-document.ts) so the
          // launcher's getInstanceSuccessCounts can scope by SolverNet —
          // preventing multi-SolverNet operators with overlapping
          // instance_id pools from cross-tenant over-counting
          // (#669 Finding 2). Same IPFS fetch, no extra round-trip.
          let instanceId = '';
          let bodySolverNetManifestCid = '';
          // The SOLVE-request id from the task body's top-level
          // `restorationRequestId`. The verdict's own requestId is the
          // EVALUATION request and does NOT cross-match attempt.requestId; this
          // field is the link that makes the (task, solution, verdict) tuple a
          // first-class join (#1433). Same task-body fetch, no extra round-trip.
          let solutionRequestId = '';
          if (meta.solverType.startsWith('swe-rebench-v2') && meta.taskCid) {
            try {
              const taskBody = await fetchIpfsJson(ipfsGateway, meta.taskCid, {
                timeoutMs: 5000,
                fetchImpl,
              });
              const resolved = resolveInstanceFields(taskBody);
              instanceId = resolved.instanceId;
              bodySolverNetManifestCid = resolved.solverNetManifestCid;
              solutionRequestId = resolved.solutionRequestId;
            } catch (err) {
              console.warn(
                `[indexer] task body fetch failed for verdict ${meta.requestId.slice(0, 10)}... cid=${meta.taskCid}: ${String(err)}`,
              );
            }
          }

          await context.db
            .insert(verdictEnvelopeMeta)
            .values({
              requestId: meta.requestId as `0x${string}`,
              verdictIndex: meta.verdictIndex,
              attemptIndex: meta.attemptIndex,
              taskId: meta.taskId,
              evaluator: meta.evaluator as `0x${string}`,
              manifestCid: envelopeKey.cid,
              publisherAgentId: agentId,
              manifestHash,
              solverType: meta.solverType,
              evidenceTier: meta.evidenceTier,
              actualPassed: meta.actualPassed,
              actualScore: meta.actualScore,
              passedCount: meta.passedCount,
              totalCount: meta.totalCount,
              instanceId,
              solverNetManifestCid: bodySolverNetManifestCid,
              solutionRequestId,
              evaluatorVerdict: meta.evaluatorVerdict,
              enrichmentStatus: 'ok',
              enrichedAtBlock: blockNumber,
              chainId,
            })
            .onConflictDoUpdate((row) => {
              // The composite PK makes this conflict specific to one
              // publisher/CID candidate. Competing candidates insert separate
              // rows; only replays of this exact anchor are most-recent-wins.
              if (blockNumber >= row.enrichedAtBlock) {
                return {
                  verdictIndex: meta.verdictIndex,
                  attemptIndex: meta.attemptIndex,
                  taskId: meta.taskId,
                  evaluator: meta.evaluator as `0x${string}`,
                  manifestHash,
                  solverType: meta.solverType,
                  evidenceTier: meta.evidenceTier,
                  actualPassed: meta.actualPassed,
                  actualScore: meta.actualScore,
                  passedCount: meta.passedCount,
                  totalCount: meta.totalCount,
                  instanceId,
                  solverNetManifestCid: bodySolverNetManifestCid,
                  solutionRequestId,
                  evaluatorVerdict: meta.evaluatorVerdict,
                  enrichmentStatus: 'ok',
                  enrichedAtBlock: blockNumber,
                };
              }
              // No-op: return existing row fields so Drizzle generates valid SQL.
              return {
                verdictIndex: row.verdictIndex,
                attemptIndex: row.attemptIndex,
                taskId: row.taskId,
                evaluator: row.evaluator,
                manifestHash: row.manifestHash,
                solverType: row.solverType,
                evidenceTier: row.evidenceTier,
                actualPassed: row.actualPassed,
                actualScore: row.actualScore,
                passedCount: row.passedCount,
                totalCount: row.totalCount,
                instanceId: row.instanceId,
                solverNetManifestCid: row.solverNetManifestCid,
                solutionRequestId: row.solutionRequestId,
                evaluatorVerdict: row.evaluatorVerdict,
                enrichmentStatus: row.enrichmentStatus,
                enrichedAtBlock: row.enrichedAtBlock,
              };
            });
        }
      } catch (err) {
        console.warn(`[indexer] verdict envelope enrichment failed for ${envelopeKey.cid}: ${String(err)}`);
        // no row — we have no requestId without the body; Ponder reprocesses on next sync.
      }
    }

    // ── Capture envelope enrichment → captureEnvelopeMeta (#1314) ──────────
    // Only for capture envelopes (kind === 'capture'). Two-hop: the wrapper
    // envelope body names the canonical jinn.episode.v1 artifact (or a frozen
    // trace-envelope.v0 compatibility artifact); its body carries the signal
    // and corpus metadata. captureEnvelopeMeta is optional for backward compat.
    if (envelopeKey.kind === 'capture' && enrichCaptures && captureEnvelopeMeta) {
      try {
        const wrapperBody = await fetchIpfsJson(ipfsGateway, envelopeKey.cid, {
          timeoutMs: 5000,
          fetchImpl,
        });
        const wrapper = parseCaptureWrapperLite(wrapperBody);
        if (wrapper) {
          const artifactBody = await fetchIpfsJson(ipfsGateway, wrapper.evidenceArtifactCid, {
            timeoutMs: 5000,
            fetchImpl,
          });
          const signalMeta = parseTraceEnvelopeSignalLite(
            artifactBody,
            wrapper.artifactType,
          );
          if (signalMeta) {
            // Anchor identity (#1406): the MetadataSet tx hash is the on-chain
            // anchor link; the block timestamp is the corpus item's createdAt.
            const anchorTx = event.transaction.hash;
            const createdAtTimestamp = event.block.timestamp;
            await context.db
              .insert(captureEnvelopeMeta)
              .values({
                manifestCid: envelopeKey.cid,
                chainId,
                agentId,
                contributor: wrapper.contributor,
                taskSummary: signalMeta.taskSummary,
                tagsJson: signalMeta.tagsJson,
                repositorySlug: signalMeta.repositorySlug,
                synthesis: signalMeta.synthesis,
                retrievalVisible: signalMeta.retrievalVisible,
                provenance: signalMeta.provenance,
                verifiabilityTier: signalMeta.verifiabilityTier,
                harness: signalMeta.harness,
                model: signalMeta.model,
                toolsJson: signalMeta.toolsJson,
                stepCount: signalMeta.stepCount,
                anchorTx,
                createdAtTimestamp,
                enrichmentStatus: 'ok',
                enrichedAtBlock: blockNumber,
              })
              .onConflictDoUpdate((row) => {
                // Most-recent-wins, mirroring the other meta tables.
                if (blockNumber >= row.enrichedAtBlock) {
                  return {
                    agentId,
                    contributor: wrapper.contributor,
                    taskSummary: signalMeta.taskSummary,
                    tagsJson: signalMeta.tagsJson,
                    repositorySlug: signalMeta.repositorySlug,
                    synthesis: signalMeta.synthesis,
                    retrievalVisible: signalMeta.retrievalVisible,
                    provenance: signalMeta.provenance,
                    verifiabilityTier: signalMeta.verifiabilityTier,
                    harness: signalMeta.harness,
                    model: signalMeta.model,
                    toolsJson: signalMeta.toolsJson,
                    stepCount: signalMeta.stepCount,
                    anchorTx,
                    createdAtTimestamp,
                    enrichmentStatus: 'ok',
                    enrichedAtBlock: blockNumber,
                  };
                }
                // No-op: return existing row fields so Drizzle generates valid SQL.
                return {
                  agentId: row.agentId,
                  contributor: row.contributor,
                  taskSummary: row.taskSummary,
                  tagsJson: row.tagsJson,
                  repositorySlug: row.repositorySlug,
                  synthesis: row.synthesis,
                  retrievalVisible: row.retrievalVisible,
                  provenance: row.provenance,
                  verifiabilityTier: row.verifiabilityTier,
                  harness: row.harness,
                  model: row.model,
                  toolsJson: row.toolsJson,
                  stepCount: row.stepCount,
                  anchorTx: row.anchorTx,
                  createdAtTimestamp: row.createdAtTimestamp,
                  enrichmentStatus: row.enrichmentStatus,
                  enrichedAtBlock: row.enrichedAtBlock,
                };
              });
          }
        }
      } catch (err) {
        console.warn(`[indexer] capture envelope enrichment failed for ${envelopeKey.cid}: ${String(err)}`);
        // no row — Ponder reprocesses on the next sync giving a natural retry.
      }
    }

    return;
  }

  // ── Plug-in publication (attd) ───────────────────────────────────────────
  const pluginKey = parsePluginKey(key);
  if (pluginKey !== null) {
    const txIndex = typeof event.transaction.transactionIndex === 'number'
      ? event.transaction.transactionIndex
      : 0;
    const logIndexResolved = typeof event.log.logIndex === 'number' ? event.log.logIndex : 0;
    const txHash = event.transaction.hash;

    // Try v1 first. If v1 decode fails, try v2 revocation. Decoders return null
    // on failure — that is the dispatch signal.
    const v1 = decodePluginPayload(event.args.metadataValue as Hex);
    const v2 = v1 ? null : decodeRevocationPayload(event.args.metadataValue as Hex);

    if (v1 && v1.version === 1) {
      // v1 publish — full insert/overwrite (revoked resets to false even if a
      // previous payload had set it true; republishing un-revokes).
      const id = `${agentId}:${pluginKey.cid}`;
      await context.db
        .insert(pluginPublication)
        .values({
          id,
          builderAgentId: agentId,
          pluginCid: pluginKey.cid,
          pluginName: v1.pluginName,
          pluginVersion: v1.pluginVersion,
          pluginSha256: v1.pluginSha256,
          supports: [...v1.supports],
          publishedAt: v1.publishedAt,
          revoked: false,
          revokedReason: null,
          txHash,
          blockNumber,
          txIndex,
          logIndex: logIndexResolved,
          chainId,
        })
        .onConflictDoUpdate((row) => {
          const incomingIsNewer =
            blockNumber > row.blockNumber ||
            (blockNumber === row.blockNumber && txIndex > row.txIndex) ||
            (blockNumber === row.blockNumber &&
              txIndex === row.txIndex &&
              logIndexResolved > row.logIndex);
          if (incomingIsNewer) {
            return {
              pluginName: v1.pluginName,
              pluginVersion: v1.pluginVersion,
              pluginSha256: v1.pluginSha256,
              supports: [...v1.supports],
              publishedAt: v1.publishedAt,
              revoked: false,
              revokedReason: null,
              txHash,
              blockNumber,
              txIndex,
              logIndex: logIndexResolved,
              chainId,
            };
          }
          return {
            pluginName: row.pluginName,
            pluginVersion: row.pluginVersion,
            pluginSha256: row.pluginSha256,
            supports: row.supports,
            publishedAt: row.publishedAt,
            revoked: row.revoked,
            revokedReason: row.revokedReason,
            txHash: row.txHash,
            blockNumber: row.blockNumber,
            txIndex: row.txIndex,
            logIndex: row.logIndex,
            chainId: row.chainId,
          };
        });
      return;
    }

    if (v2 && v2.version === 2 && v2.revoked) {
      // v2 revocation — only valid if a v1 row already exists. Find the row;
      // if missing, no-op (a revocation for a never-published key is meaningless).
      const id = `${agentId}:${pluginKey.cid}`;
      const existing = await context.db.find(pluginPublication, { id });
      if (!existing) return;
      // Most-recent-wins gate — only apply if the incoming event beats the
      // stored anchor on (block, txIndex, logIndex).
      const row = existing as {
        blockNumber: bigint;
        txIndex: number;
        logIndex: number;
      };
      const incomingIsNewer =
        blockNumber > row.blockNumber ||
        (blockNumber === row.blockNumber && txIndex > row.txIndex) ||
        (blockNumber === row.blockNumber &&
          txIndex === row.txIndex &&
          logIndexResolved > row.logIndex);
      if (!incomingIsNewer) return;
      await context.db.update(pluginPublication, { id }).set({
        revoked: true,
        revokedReason: v2.reason,
        txHash,
        blockNumber,
        txIndex,
        logIndex: logIndexResolved,
      });
      return;
    }

    // Garbage / unknown-version payload — no row written.
    return;
  }

  // Any other key (e.g. future metadata types) — no-op.
}
