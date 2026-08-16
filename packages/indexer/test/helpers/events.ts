/**
 * Synthetic-event builders + payload encoders for the indexer handler tests.
 *
 * These produce the narrow `{ args, block, transaction, log }` shapes the pure
 * handlers in `src/handlers.ts` declare — a structural subset of Ponder's real
 * generated `event` objects. Defaults are filled in so each test only has to
 * override the fields it cares about (taskId, block number, logIndex, …).
 */
import { encodeAbiParameters, toHex } from 'viem';
import {
  PAYLOAD_TUPLE_V1,
  PAYLOAD_TUPLE_V2,
  type MetadataSetEvent,
  type SolutionDeliveryClaimedEvent,
  type TaskAttemptCreatedEvent,
  type TaskBudgetRefundedEvent,
  type TaskCreatedEvent,
  type VerdictDeliveryClaimedEvent,
} from '../../src/handlers.js';

const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as const;
const ZERO_BYTES32 = `0x${'0'.repeat(64)}` as const;
const SOME_ADDR = '0x1111111111111111111111111111111111111111' as const;

interface EnvelopeOverrides {
  block?: bigint;
  /** Block timestamp (UTC seconds). Defaults to 0n in fixtures that don't care. */
  timestamp?: bigint;
  transactionIndex?: number;
  logIndex?: number;
  txHash?: `0x${string}`;
}

export function taskCreatedEvent(
  args: Partial<TaskCreatedEvent['args']> & { taskId: bigint },
  o: EnvelopeOverrides = {},
): TaskCreatedEvent {
  return {
    args: {
      creator: SOME_ADDR,
      manifestDigest: ZERO_BYTES32,
      taskCidDigest: ZERO_BYTES32,
      maxClaims: 1,
      requiredVerdicts: 1,
      ...args,
    },
    block: { number: o.block ?? 100n, timestamp: o.timestamp ?? 0n },
    transaction: { hash: o.txHash ?? ('0x' + 'ab'.repeat(32)) as `0x${string}`, transactionIndex: o.transactionIndex ?? 0 },
    log: { logIndex: o.logIndex ?? 0 },
  };
}

export function taskAttemptCreatedEvent(
  args: Partial<TaskAttemptCreatedEvent['args']> & { taskId: bigint },
  o: EnvelopeOverrides = {},
): TaskAttemptCreatedEvent {
  return {
    args: {
      attemptIndex: 0,
      requestId: ZERO_BYTES32,
      operator: SOME_ADDR,
      priorityMech: ZERO_ADDR,
      deliveryRate: 0n,
      ...args,
    },
    block: { number: o.block ?? 100n, timestamp: o.timestamp ?? 0n },
    transaction: { hash: o.txHash ?? ('0x' + 'cd'.repeat(32)) as `0x${string}`, transactionIndex: o.transactionIndex ?? 0 },
    log: { logIndex: o.logIndex ?? 0 },
  };
}

export function solutionDeliveryClaimedEvent(
  args: Partial<SolutionDeliveryClaimedEvent['args']> & { taskId: bigint },
  o: EnvelopeOverrides = {},
): SolutionDeliveryClaimedEvent {
  return {
    args: {
      operator: SOME_ADDR,
      requestId: ZERO_BYTES32,
      attemptIndex: 0,
      ...args,
    },
    block: { number: o.block ?? 100n, timestamp: o.timestamp ?? 0n },
    transaction: { hash: o.txHash ?? ('0x' + 'ef'.repeat(32)) as `0x${string}`, transactionIndex: o.transactionIndex ?? 0 },
    log: { logIndex: o.logIndex ?? 0 },
  };
}

export function metadataSetEvent(
  args: { agentId?: bigint; metadataKey: string; metadataValue: `0x${string}` },
  o: EnvelopeOverrides = {},
): MetadataSetEvent {
  return {
    args: {
      agentId: args.agentId ?? 42n,
      metadataKey: args.metadataKey,
      metadataValue: args.metadataValue,
    },
    block: { number: o.block ?? 100n, timestamp: o.timestamp ?? 0n },
    transaction: { hash: o.txHash ?? ('0x' + '12'.repeat(32)) as `0x${string}`, transactionIndex: o.transactionIndex ?? 0 },
    log: { logIndex: o.logIndex ?? 0 },
  };
}

export function verdictDeliveryClaimedEvent(
  args: Partial<VerdictDeliveryClaimedEvent['args']> & { taskId: bigint },
  o: EnvelopeOverrides = {},
): VerdictDeliveryClaimedEvent {
  return {
    args: {
      evaluator: SOME_ADDR,
      requestId: ZERO_BYTES32,
      attemptIndex: 0,
      verdictIndex: 0,
      verdictCode: 1,
      ...args,
    },
    block: { number: o.block ?? 100n, timestamp: o.timestamp ?? 0n },
    transaction: { hash: o.txHash ?? ('0x' + 'fe'.repeat(32)) as `0x${string}`, transactionIndex: o.transactionIndex ?? 0 },
    log: { logIndex: o.logIndex ?? 0 },
  };
}

export function taskBudgetRefundedEvent(
  args: Partial<TaskBudgetRefundedEvent['args']> & { taskId: bigint },
  o: EnvelopeOverrides = {},
): TaskBudgetRefundedEvent {
  return {
    args: {
      creator: SOME_ADDR,
      solutionAmount: 0n,
      verdictAmount: 0n,
      ...args,
    },
    block: { number: o.block ?? 100n, timestamp: o.timestamp ?? 0n },
    transaction: { hash: o.txHash ?? ('0x' + 'a1'.repeat(32)) as `0x${string}`, transactionIndex: o.transactionIndex ?? 0 },
    log: { logIndex: o.logIndex ?? 0 },
  };
}

// ── Payload encoders ──────────────────────────────────────────────────────────

/** JSON-encoded SolverNet lifecycle payload (the most-recent-wins shape). */
export function lifecyclePayload(payload: {
  schemaVersion?: string;
  status?: string;
  at?: string;
  hash?: string;
}): `0x${string}` {
  return toHex(JSON.stringify(payload));
}

/** ABI-encoded V2 envelope payload tuple. */
export function envelopePayloadV2(opts: {
  version?: number;
  tier: number;
  manifestHash: `0x${string}`;
  attestationQuoteCid?: `0x${string}`;
  sourceMeasurement?: `0x${string}`;
  codeDigest?: `0x${string}`;
  implName?: string;
  modeFlag?: number;
}): `0x${string}` {
  return encodeAbiParameters(PAYLOAD_TUPLE_V2, [
    opts.version ?? 2,
    opts.tier,
    opts.manifestHash,
    opts.attestationQuoteCid ?? '0x',
    opts.sourceMeasurement ?? ZERO_BYTES32,
    opts.codeDigest ?? ZERO_BYTES32,
    opts.implName ?? 'impl',
    opts.modeFlag ?? 0,
  ]);
}

/** ABI-encoded V1 envelope payload tuple (no harness identity fields). */
export function envelopePayloadV1(opts: {
  version?: number;
  tier: number;
  manifestHash: `0x${string}`;
  attestationQuoteCid?: `0x${string}`;
  sourceMeasurement?: `0x${string}`;
}): `0x${string}` {
  return encodeAbiParameters(PAYLOAD_TUPLE_V1, [
    opts.version ?? 1,
    opts.tier,
    opts.manifestHash,
    opts.attestationQuoteCid ?? '0x',
    opts.sourceMeasurement ?? ZERO_BYTES32,
  ]);
}

// ── Plug-in publication payloads (attd) ───────────────────────────────────────

/**
 * Byte-identical to PLUGIN_PAYLOAD_TUPLE in operator/src/erc8004/abis.ts. Re-stated
 * here so tests are self-contained — the indexer package cannot import from
 * operator/. A drift-guard test in handlers.plugin.test.ts compares this tuple to
 * the canonical one via a hex-encoded fixture.
 */
export const PLUGIN_PAYLOAD_TUPLE_TEST = [
  { name: 'version', type: 'uint8' },
  { name: 'pluginName', type: 'string' },
  { name: 'pluginVersion', type: 'string' },
  { name: 'pluginSha256', type: 'bytes32' },
  { name: 'supports', type: 'string[]' },
  { name: 'publishedAt', type: 'uint64' },
] as const;

export const REVOCATION_PAYLOAD_TUPLE_TEST = [
  { name: 'version', type: 'uint8' },
  { name: 'revoked', type: 'bool' },
  { name: 'reason', type: 'string' },
] as const;

export function pluginPayload(opts: {
  version?: number;
  pluginName: string;
  pluginVersion: string;
  pluginSha256: `0x${string}`;
  supports: string[];
  publishedAt: bigint;
}): `0x${string}` {
  return encodeAbiParameters(PLUGIN_PAYLOAD_TUPLE_TEST, [
    opts.version ?? 1,
    opts.pluginName,
    opts.pluginVersion,
    opts.pluginSha256,
    opts.supports,
    opts.publishedAt,
  ]);
}

export function revocationPayload(opts: {
  version?: number;
  revoked?: boolean;
  reason: string;
}): `0x${string}` {
  return encodeAbiParameters(REVOCATION_PAYLOAD_TUPLE_TEST, [
    opts.version ?? 2,
    opts.revoked ?? true,
    opts.reason,
  ]);
}
