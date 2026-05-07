/**
 * Auto-generator for prediction.v1 tasks.
 *
 * Produces a fresh Task per hour bucket: reads current Chainlink
 * price, builds a template with the configured threshold sentinel
 * (default "current+0.5%" — coin-flip-ish, slightly biased NO), and resolves
 * it via the shared template helper. Stable ID per hour prevents duplicate
 * posts within a window; the CreatorLoop's SQLite cache guards against
 * restart-replay.
 *
 * Wired in main.ts for testnet-only (jinn-mono-9ew). Operators can opt out
 * with JINN_DISABLE_AUTO_TASKS=1.
 */

import { randomUUID } from 'node:crypto';
import { createPublicClient, http, type PublicClient } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { readChainlinkLatest, scaleToDecimal } from '../venues/chainlink/client.js';
import type { Task } from '../types/task.js';
import type { TaskV1, SignedTaskV1 } from '../types/task-document.js';
import { resolvePredictionV1Template } from './prediction-v0-template.js';
import { signTaskV1 } from '../tasks/signing.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface PredictionV1AutoConfig {
  /** Chainlink AggregatorV3 proxy address. Defaults to Base Sepolia ETH/USD. */
  feed: `0x${string}`;
  /** Human-readable feed description embedded in the generated task. */
  feedDescription: string;
  /** Which chain the feed lives on. */
  venue: 'chainlink-base' | 'chainlink-base-sepolia';
  /**
   * Threshold sentinel to resolve each cycle. Defaults to "current+0.5%" —
   * biases slightly NO, Brier scores land meaningfully around 0.75. Use
   * "current" for a strict coin-flip direction question.
   */
  thresholdSentinel?: string;
  /** Comparator operator. Default 'GT'. */
  operator?: 'GT' | 'GTE' | 'LT' | 'LTE';
  /**
   * Submission window duration in ms. Default: 600_000 (10 min) to sync with
   * the 15-min fast-test epoch on Base Sepolia. Set to 3_600_000 for 1h
   * mainnet-style windows. Bucket size also uses this value.
   */
  windowDurationMs?: number;
  /**
   * Gap between window.endTs and resolveTs in ms. Default: 300_000 (5 min).
   * Bounded by schema to ≤ 1h.
   */
  resolveGapMs?: number;
  /** RPC URL for the publicClient used to read Chainlink. */
  rpcUrl?: string;
  /** Injected publicClient — tests pass a mock; production leaves unset. */
  _publicClient?: PublicClient;
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

export type PredictionV1Generator = () => Promise<Task | null>;

// ── Generator factory ──────────────────────────────────────────────────────────

/**
 * Build a generator closure. Calling the closure returns a freshly-resolved
 * Task for the current hour bucket, or null if Chainlink is
 * unreachable (caller skips this tick).
 */
export function makePredictionV1Generator(config: PredictionV1AutoConfig): PredictionV1Generator {
  const threshold = config.thresholdSentinel ?? 'current+0.5%';
  const operator = config.operator ?? 'GT';
  const windowDurationMs = config.windowDurationMs ?? 600_000;   // 10 min default (fast-test)
  const resolveGapMs = config.resolveGapMs ?? 300_000;           // 5 min default

  // Lazy publicClient construction — reused across calls.
  let publicClient: PublicClient | null = config._publicClient ?? null;
  const getPublicClient = (): PublicClient => {
    if (publicClient) return publicClient;
    const chain = config.venue === 'chainlink-base' ? base : baseSepolia;
    const rpcUrl = config.rpcUrl ?? (config.venue === 'chainlink-base'
      ? 'https://mainnet.base.org'
      : 'https://sepolia.base.org');
    publicClient = createPublicClient({ chain, transport: http(rpcUrl) }) as unknown as PublicClient;
    return publicClient;
  };

  return async (): Promise<Task | null> => {
    // Bucket start = windowDurationMs boundary ≤ now. Stable ID per bucket
    // prevents duplicate posts within the same window.
    const now = Date.now();
    const startTs = Math.floor(now / windowDurationMs) * windowDurationMs;
    const endTs = startTs + windowDurationMs;
    const resolveTs = endTs + resolveGapMs;

    const template = {
      id: `pred-v1-auto-${startTs}`,
      solverType: 'prediction.v1',
      description: `Auto-generated prediction.v1 task — ${config.feedDescription} ${operator} ${threshold} at ${new Date(resolveTs).toISOString()}`,
      window: { startTs, endTs },
      spec: {
        oracle: {
          venue: config.venue,
          feed: config.feed,
          feedDescription: config.feedDescription,
        },
        question: {
          kind: 'threshold',
          operator,
          threshold,
          resolveTs,
        },
      },
      eligibility: { maxSubmissionDelayMs: 60_000 },
      claimPolicy: {
        mode: 'parallel' as const,
        maxClaims: 25,
        maxClaimsPerOperator: 1,
        claimWindowStartTs: startTs,
        claimWindowEndTs: endTs,
        submissionDeadlineTs: endTs,
        claimLeaseTtlSeconds: Math.max(60, Math.floor((endTs - startTs) / 1000)),
      },
    };

    try {
      const resolved = await resolvePredictionV1Template(template, {
        readCurrent: async ({ feed }) => {
          const reading = await readChainlinkLatest(feed, getPublicClient());
          return scaleToDecimal(reading.answer, reading.decimals);
        },
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
          solverType: 'prediction.v1',
          contractId: 'prediction',
          contractVersion: 'v1',
          solverNetManifestCid: config.solverNetManifestCid,
          role: 'restoration',
          description: resolved.description,
          window: resolved.window,
          spec: resolved.spec as TaskV1['spec'],
          eligibility: resolved.eligibility ?? {},
          claimPolicy: template.claimPolicy,
          creator: {
            safeAddress: config.safeAddress,
            agentEoa: config.agentEoa,
          },
          createdAt: Date.now(),
        };
        const signed: SignedTaskV1 = await signTaskV1(taskDoc, config.agentPrivateKey);
        const task: Task = {
          ...(resolved as unknown as Task),
          solverType: 'prediction.v1',
          contractId: 'prediction',
          contractVersion: 'v1',
          solverNetManifestCid: config.solverNetManifestCid,
          claimPolicy: template.claimPolicy,
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
        solverType: 'prediction.v1',
        contractId: 'prediction',
        contractVersion: 'v1',
        ...(config.solverNetManifestCid
          ? { solverNetManifestCid: config.solverNetManifestCid }
          : {}),
        claimPolicy: template.claimPolicy,
        spec: Object.fromEntries(
          Object.entries((resolved.spec ?? {}) as Record<string, unknown>).filter(([key]) => key !== 'kind'),
        ),
      };
    } catch {
      // Chainlink read failure or schema mismatch — skip this tick, try next.
      return null;
    }
  };
}
