/**
 * Shared native-runtime assembly helpers — one assembly, two callers (one-swap M2,
 * umbrella #2461, DR-2026-08-05).
 *
 * Every function here is a verbatim extraction from `native-solver-production.ts`, the
 * only place this graph existed before the swap. `native-solver-production.ts` (the
 * retiring `native-main.ts` solver host, stage 5) and the ONE multi-role fleet daemon
 * (`main.ts` -> `composition-root.ts`) now build the same pieces from the same code
 * instead of the fleet path growing a second copy that drifts.
 *
 * Two rules govern this file:
 *
 * 1. **Extraction, not redesign.** Bodies are moved unchanged. Where a parameter type
 *    named `NativeProductConfig['operator']['native']` (the strict, role-scoped schema
 *    of the retiring native entry point) it is widened to the structural shape the body
 *    actually reads, so the fleet path can supply the same values out of the shape-v2
 *    `config.json` without importing a schema that retires at stage 5.
 *
 * 2. **No runtime relative imports.** `test/architecture/native-product-import-boundary.test.ts`
 *    walks the native product graph for leaks into the compatibility daemon. This module
 *    is on that graph, so it takes its collaborators as parameters and imports their names
 *    `import type` only — the guard's regex strips type imports, so nothing here can widen
 *    the native graph.
 */
import { documentDigest } from '@jinn-network/task-execution-protocol';
import { recordPath } from '@jinn-network/record-discovery-protocol';
import type { NativeTier4ClaimPolicy } from './native-claim-policy.js';
import type { NativeEngagementRow, NativeOperatorStateRepository } from './native-operator-state.js';
import type { RoleIdentitySet } from './role-identities.js';

/** Exact bytes of one engagement's sealed Task/Submission pair. */
export interface NativeExactDocuments {
  readonly taskBytes: Uint8Array;
  readonly submissionBytes: Uint8Array;
}

/** The one record port these helpers need: exact bytes for an exact digest. */
export interface NativeRecordsByDigest {
  byDigest(digest: `sha256:${string}`): Promise<Uint8Array>;
}

/**
 * The record ports the EvaluationSpec resolver reads: the marketplace IPFS plane
 * (`byDigest`) plus the requester's HTTP serving plane (`byLocation`). Native records — the
 * EvaluationSpec among them — are published only to the HTTP serving plane and never pushed to
 * IPFS, so the resolver needs both.
 */
export interface NativeEvaluationSpecRecords extends NativeRecordsByDigest {
  byLocation(url: string): Promise<Uint8Array>;
}

/**
 * Structural chain identity. `NativeProductConfig['operator']['native']` satisfies it, and
 * so does the fleet daemon's pinned `BASE_SEPOLIA_TODAY` projection, without either side
 * importing the other's schema.
 */
export interface NativeChainIdentityConfig {
  readonly chainId: number;
  readonly generation: 'today' | 'revised';
  readonly contracts: {
    readonly taskCoordinator: string;
    readonly jinnRouter: string;
    readonly mechMarketplace: string;
    readonly activityChecker: string;
  };
}

/** Structural claim-policy inputs: chain identity plus this operator's escrow spend bound. */
export interface NativeClaimPolicyConfig extends NativeChainIdentityConfig {
  readonly transactionCaps: { readonly escrowMaxWei: string };
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

export function digest(value: unknown, label: string): `sha256:${string}` {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} is not a canonical sha256 digest`);
  }
  return value as `sha256:${string}`;
}

export function address(value: unknown, label: string): `0x${string}` {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/u.test(value)) {
    throw new Error(`${label} is not an EVM address`);
  }
  return value as `0x${string}`;
}

export function hash(value: unknown, label: string): `0x${string}` {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/u.test(value)) {
    throw new Error(`${label} is not a 32-byte hash`);
  }
  return value as `0x${string}`;
}

export function uint(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`${label} is not a canonical unsigned integer`);
  }
  return BigInt(value);
}

/**
 * THE reader for a chain id carried on a signed fact — one helper, three call sites (#2529).
 *
 * `uint()` above demands a decimal STRING because it exists for uint256-scale values (`taskId`,
 * wei amounts) that cannot round-trip through a JS number. A chain id is small and bounded, so a
 * JSON number is its natural wire form: it is what `native-requester/requester.ts` has always
 * emitted, and what `native-evaluator-opportunity-source.ts` has always accepted. The solver leg's
 * decode (`native-requester-decode.ts`) reached for `uint()` instead, so an operator's own
 * DSSE-signed announcement was undecodable by its own boot path, and — because the fleet path
 * REQUIRES its own requester source — every subsequent boot died on it.
 *
 * The fact is signed, so the READER is what moves: re-emitting `chainId` as a string would change
 * signed bytes and leave the already-published announcement undecodable forever, i.e. it would
 * force an append-only signed history to be purged to work around a reader bug.
 *
 * Both canonical forms are accepted here, on ONE code path, so the three readers cannot drift
 * apart again. Nothing is loosened: a float, a negative, NaN/Infinity, a leading-zero or
 * whitespace-padded string, a value past IEEE-754 exact-integer range, a boolean, `null` and an
 * object are all refused exactly as `uint()` refuses them.
 */
export function chainId(value: unknown, label: string): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${label} is not a canonical unsigned integer`);
    }
    return value;
  }
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new Error(`${label} is not a canonical unsigned integer`);
}

export function chain(config: NativeChainIdentityConfig) {
  return {
    chainId: config.chainId,
    generation: config.generation,
    taskCoordinator: config.contracts.taskCoordinator as `0x${string}`,
    jinnRouter: config.contracts.jinnRouter as `0x${string}`,
    mechMarketplace: config.contracts.mechMarketplace as `0x${string}`,
    activityChecker: config.contracts.activityChecker as `0x${string}`,
  } as const;
}

export function roleKeyIds(roles: RoleIdentitySet): Readonly<Record<string, string>> {
  return {
    'solver-delivery': roles.get('solver-delivery').keyId,
    'solver-settlement': roles.get('solver-settlement').keyId,
    'solver-discovery': roles.get('solver-discovery').keyId,
  };
}

export function nonterminal(state: string): boolean {
  return !['solution-settled', 'lost', 'failed'].includes(state);
}

export function closeAll(actions: readonly (() => void | Promise<void>)[]): () => Promise<void> {
  let closed = false;
  return async () => {
    if (closed) return;
    closed = true;
    const failures: unknown[] = [];
    for (const action of actions) {
      try { await action(); } catch (cause) { failures.push(cause); }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'native solver cleanup failed');
  };
}

/** Live count of engagements this operator still owes work on — the claim policy's concurrency input. */
export function countActiveNativeEngagements(state: NativeOperatorStateRepository): number {
  return state.listEngagements().filter(({ state: value }) => nonterminal(value)).length;
}

/**
 * Re-fetches the sealed Task/Submission bytes by exact digest and refuses anything whose
 * digest changed in transit. The retrieval port is never trusted to be content-addressed.
 */
export function buildNativeExactDocuments(
  records: NativeRecordsByDigest,
): (engagement: Pick<NativeEngagementRow, 'taskDigest' | 'submissionDigest'>) => Promise<NativeExactDocuments> {
  return async (engagement) => {
    const [taskBytes, submissionBytes] = await Promise.all([
      records.byDigest(engagement.taskDigest),
      records.byDigest(engagement.submissionDigest),
    ]);
    if (documentDigest(taskBytes) !== engagement.taskDigest
      || documentDigest(submissionBytes) !== engagement.submissionDigest) {
      throw new Error('native exact Task/Submission retrieval changed digest');
    }
    return { taskBytes, submissionBytes };
  };
}

/**
 * Resolves a Task's advertised public EvaluationSpec by exact digest. A miss, a transport
 * failure, and a digest mismatch are all `undefined` — the verification port treats an
 * unresolvable spec as "not proven", never as "no spec was required".
 *
 * Two planes are tried, in order. First the marketplace IPFS plane (`byDigest`), where the
 * on-chain post path uploads the Task. Then, on any IPFS miss/failure/mismatch, the requester's
 * HTTP serving plane (`byLocation` of `<requesterServingBaseUrl>/records/<digest>`) — where native
 * records, the EvaluationSpec included, are actually published (they are never pushed to IPFS).
 * This is the same serving plane the solver already resolves the Submission through at discovery.
 * The transport stays untrusted on both planes: bytes are accepted only when their digest re-derives
 * to `expected`, so a substituted HTTP response is rejected exactly as a substituted IPFS block is.
 */
export function buildNativeEvaluationSpecResolver(
  records: NativeEvaluationSpecRecords,
  requesterServingBaseUrls: readonly string[] = [],
): (expected: `sha256:${string}`) => Promise<Uint8Array | undefined> {
  const verified = (bytes: Uint8Array, expected: `sha256:${string}`): Uint8Array | undefined =>
    documentDigest(bytes) === expected ? bytes : undefined;
  return async (expected) => {
    try {
      const bytes = verified(await records.byDigest(expected), expected);
      if (bytes !== undefined) return bytes;
    } catch { /* IPFS miss/failure — fall through to the HTTP serving plane */ }
    for (const base of requesterServingBaseUrls) {
      try {
        const url = `${base.replace(/\/+$/u, '')}${recordPath(expected)}`;
        const bytes = verified(await records.byLocation(url), expected);
        if (bytes !== undefined) return bytes;
      } catch { /* serving-plane miss/failure — try the next configured origin */ }
    }
    return undefined;
  };
}

/**
 * The tier-4 admission policy both callers evaluate every discovered card against.
 *
 * `maxConcurrent: 1` and `minDeadlineLeadMs: 5min` are DELIBERATE swap-era defaults, not values
 * inherited unexamined from the native solver host (coordinator ruling, M3 review note 2;
 * DR-2026-08-05). Conservative claim concurrency is the right posture through the gate phase, and
 * the fleet path's exactly-one-requester-source constraint
 * (`native-fleet-discovery.ts`'s `selectFleetRequesterSources`) may lean on the single-claim
 * bound. A post-gate operator-facing config surface for both is filed as a follow-up; until it
 * lands, changing either here is a policy decision, not a tuning knob.
 */
export function buildNativeClaimPolicy(config: NativeClaimPolicyConfig): NativeTier4ClaimPolicy {
  return {
    chainId: config.chainId,
    coordinator: config.contracts.taskCoordinator,
    generation: config.generation,
    maxSpendWei: BigInt(config.transactionCaps.escrowMaxWei),
    minDeadlineLeadMs: 5 * 60 * 1_000,
    maxConcurrent: 1,
  };
}
