import { randomUUID } from 'node:crypto';
import type { Task } from '../types/task.js';
import type { TaskV1, SignedTaskV1 } from '../types/task-document.js';
import { resolvePredictionApyV0Template } from './prediction-apy-v0-template.js';
import { signTaskV1 } from '../tasks/signing.js';
import { AAVE_V3_USDC } from '../venues/aave-v3/addresses.js';

export interface PredictionApyV0AutoConfig {
  venue?: 'aave-v3-base-sepolia' | 'aave-v3-base' | 'aave-v3-mainnet';
  windowDurationMs?: number;
  resolveGapMs?: number;
  twaWindowSeconds?: number;
  sampleCount?: number;
  toleranceBps?: number;
  /**
   * Agent EOA address. When provided alongside `safeAddress` and
   * `agentPrivateKey`, the generator produces a `SignedTaskV1` embedded in
   * the returned Task's `task` field.
   */
  agentEoa?: `0x${string}`;
  /** Safe address — embedded in `task.creator.safeAddress`. */
  safeAddress?: `0x${string}`;
  /** Agent private key — used to sign the TaskV1. */
  agentPrivateKey?: `0x${string}`;
  /**
   * Spec §14 (Task 24): IPFS CID of the launched SolverNet manifest. Becomes
   * `manifestDigest = keccak256(manifestCid)` on-chain. Required for signed
   * tasks that hit the production adapter.
   */
  solverNetManifestCid?: string;
}

export type PredictionApyV0Generator = () => Promise<Task | null>;

export function makePredictionApyV0Generator(config: PredictionApyV0AutoConfig = {}): PredictionApyV0Generator {
  const venue = config.venue ?? 'aave-v3-base-sepolia';
  const addrs = AAVE_V3_USDC[venue];
  const windowDurationMs = config.windowDurationMs ?? 600_000;
  const resolveGapMs = config.resolveGapMs ?? 300_000;
  const twaWindowSeconds = config.twaWindowSeconds ?? 3_600;
  const sampleCount = config.sampleCount ?? 12;
  const toleranceBps = config.toleranceBps ?? 50;

  return async (): Promise<Task | null> => {
    const now = Date.now();
    const startTs = Math.floor(now / windowDurationMs) * windowDurationMs;
    const endTs = startTs + windowDurationMs;
    const resolveTs = endTs + resolveGapMs;
    const claimPolicy = {
      mode: 'parallel' as const,
      maxClaims: 25,
      maxClaimsPerOperator: 1,
      claimWindowStartTs: startTs,
      claimWindowEndTs: endTs,
      submissionDeadlineTs: endTs,
      claimLeaseTtlSeconds: Math.max(60, Math.floor((endTs - startTs) / 1000)),
    };
    try {
      const resolved = await resolvePredictionApyV0Template({
        id: `pred-apy-v0-auto-${startTs}`,
        description: `Auto-generated prediction.apy.v0 task for ${addrs.symbol} on ${venue}`,
        window: { startTs, endTs },
        spec: {
          solverType: 'prediction.apy.v0',
          oracle: {
            venue,
            pool: addrs.pool,
            reserve: addrs.reserve,
            reserveSymbol: addrs.symbol,
          },
          metric: {
            type: 'supply-apy-twa-bps',
            twaWindowSeconds,
            sampleCount,
            toleranceBps,
          },
          question: { resolveTs },
        },
        eligibility: { maxSubmissionDelayMs: windowDurationMs },
      });

      // When signing credentials AND a SolverNet manifest CID are available,
      // produce a SignedTaskV1 and embed it in the Task's `task` field so
      // MechAdapter's `state.signedTask ?? buildTaskPayload(...)` path picks
      // it up. Without a `solverNetManifestCid` we cannot derive the on-chain
      // `manifestDigest` (spec §14, Task 24) — fall back to the unsigned shape.
      if (
        config.agentEoa &&
        config.safeAddress &&
        config.agentPrivateKey &&
        config.solverNetManifestCid
      ) {
        const taskDoc: TaskV1 = {
          schemaVersion: 'task.v1',
          id: resolved.id ?? randomUUID(),
          solverType: 'prediction.apy.v0',
          contractId: 'prediction.apy',
          contractVersion: 'v0',
          solverNetManifestCid: config.solverNetManifestCid,
          role: 'restoration',
          description: resolved.description,
          window: resolved.window,
          spec: resolved.spec as TaskV1['spec'],
          eligibility: resolved.eligibility ?? {},
          claimPolicy,
          creator: {
            safeAddress: config.safeAddress,
            agentEoa: config.agentEoa,
          },
          createdAt: Date.now(),
        };
        const signed: SignedTaskV1 = await signTaskV1(taskDoc, config.agentPrivateKey);
        const task: Task = {
          ...(resolved as unknown as Task),
          solverType: 'prediction.apy.v0',
          contractId: 'prediction.apy',
          contractVersion: 'v0',
          solverNetManifestCid: config.solverNetManifestCid,
          claimPolicy,
          spec: Object.fromEntries(
            Object.entries((resolved.spec ?? {}) as Record<string, unknown>).filter(([key]) => key !== 'kind'),
          ),
        };
        return { ...task, signedTask: signed };
      }

      // No signing credentials (or no manifest CID) — return the resolved
      // shape without a signed task.
      return {
        ...(resolved as unknown as Task),
        solverType: 'prediction.apy.v0',
        contractId: 'prediction.apy',
        contractVersion: 'v0',
        ...(config.solverNetManifestCid
          ? { solverNetManifestCid: config.solverNetManifestCid }
          : {}),
        claimPolicy,
        spec: Object.fromEntries(
          Object.entries((resolved.spec ?? {}) as Record<string, unknown>).filter(([key]) => key !== 'kind'),
        ),
      };
    } catch {
      return null;
    }
  };
}
