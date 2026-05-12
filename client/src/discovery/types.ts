/**
 * DiscoveryAPI interface and shared types.
 *
 * The interface abstracts the daemon's read-side discovery queries (claimable
 * tasks, SolverNet manifests, corpus envelopes) from the backing store. Three
 * implementations exist: HttpDiscoveryAPI, EmbeddedPonderDiscoveryAPI, and
 * OnchainDiscoveryAPI. Callers always hold a DiscoveryAPI — they never depend
 * on a specific backing.
 *
 * Spec: spec/2026-05-11-discovery-api-and-shared-indexer.md §5.
 */

// ── Re-exports from sibling modules ─────────────────────────────────────────

// SolverNetManifestSummary is the canonical catalog-row shape used by both the
// registry client and the DiscoveryAPI; re-exported here so consumers of
// discovery only need one import path.
export type { SolverNetManifestSummary, SolverNetLifecycleStatus } from '../solvernets/registry-client.js';

// EnvelopeRef and CorpusQuery are the corpus library's public types; discovery
// returns them directly so the corpus library can wrap DiscoveryAPI without
// an impedance mismatch.
export type { EnvelopeRef, CorpusQuery } from '../corpus/types.js';

// ── Local imports used in the interface ─────────────────────────────────────

import type { SolverNetManifestSummary, SolverNetLifecycleStatus } from '../solvernets/registry-client.js';
import type { EnvelopeRef, CorpusQuery } from '../corpus/types.js';

// ── New types ────────────────────────────────────────────────────────────────

/**
 * A single task candidate that can be claimed by the operator.
 *
 * This is the same shape as `SubgraphTaskCandidate` in
 * `client/src/adapters/mech/task-subgraph.ts`, renamed and re-homed here as
 * the canonical type. The subgraph module retains its own definition until
 * callsite migration (jinn-mono-280n.3) lands and the old file is retired.
 */
export interface ClaimableTaskCandidate {
  taskId: string;
  taskCidDigest: `0x${string}`;
  manifestDigest: `0x${string}`;
  createdAtBlock?: number;
  createdAtTx?: `0x${string}`;
  claimWindowEnd?: number;
  maxClaims?: number;
  attemptCount: number;
  operatorAttemptCount: number;
}

// ── Interface ────────────────────────────────────────────────────────────────

/**
 * Read-only discovery interface. Abstracts the daemon's read-side queries so
 * the backing (HTTP indexer, embedded Ponder, or direct on-chain RPC) can be
 * swapped without changing call-sites.
 *
 * Each method may throw `DiscoveryUnavailableError` when the backing is
 * temporarily unavailable. The `withFallback` wrapper catches these and routes
 * to the floor implementation for the duration of the outage.
 */
export interface DiscoveryAPI {
  /**
   * Returns claimable task candidates for a set of SolverNet manifests,
   * filtered to tasks the given operator has not yet attempted.
   *
   * Replaces `queryClaimableTaskCandidates` in
   * `client/src/adapters/mech/task-subgraph.ts`.
   */
  findClaimableTasks(args: {
    solverNetManifestCids: string[];
    operatorAddress: `0x${string}`;
    nowSeconds?: number;
    pageSize?: number;
    maxPages?: number;
  }): Promise<ClaimableTaskCandidate[]>;

  /**
   * Returns launched SolverNet manifest summaries, optionally filtered by
   * launcher agent or lifecycle status.
   *
   * Replaces the subgraph fetcher in
   * `client/src/solvernets/registry-client-erc8004.ts`.
   */
  listLaunchedSolverNets(args?: {
    launcherAgentId?: string;
    status?: Array<'launched' | 'paused' | 'retired'>;
  }): Promise<SolverNetManifestSummary[]>;

  /**
   * Returns the current lifecycle status for a given manifest CID, or
   * `undefined` if no lifecycle events have been recorded for it yet.
   */
  getLifecycleStatus(manifestCid: string): Promise<SolverNetLifecycleStatus | undefined>;

  /**
   * Returns envelope refs matching the query. Refs only — byte retrieval is
   * done by the corpus library on demand.
   *
   * Replaces the subgraph branch of `corpus/index.ts::query`.
   */
  queryEnvelopes(query: CorpusQuery): Promise<EnvelopeRef[]>;
}

// ── Error ────────────────────────────────────────────────────────────────────

/**
 * Thrown by a DiscoveryAPI implementation when it is temporarily unable to
 * serve a request — e.g. indexer unreachable, embedded Ponder still syncing,
 * hosted subgraph 5xx.
 *
 * The `withFallback` wrapper catches this class (plus network-shaped errors)
 * and routes to the floor implementation for the duration of the outage.
 */
export class DiscoveryUnavailableError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'DiscoveryUnavailableError';
    this.cause = cause;
  }
}
