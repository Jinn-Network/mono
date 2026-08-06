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
 */
export function buildNativeEvaluationSpecResolver(
  records: NativeRecordsByDigest,
): (expected: `sha256:${string}`) => Promise<Uint8Array | undefined> {
  return async (expected) => {
    try {
      const bytes = await records.byDigest(expected);
      return documentDigest(bytes) === expected ? bytes : undefined;
    } catch {
      return undefined;
    }
  };
}

/** The tier-4 admission policy both callers evaluate every discovered card against. */
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
