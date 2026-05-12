/**
 * HttpSubgraphDiscoveryAPI — transitional DiscoveryAPI backed by the existing
 * subgraph clients.
 *
 * This is a thin adapter that wraps the existing subgraph helpers behind the
 * DiscoveryAPI interface. It exists only for the migration window — it will
 * be removed when jinn-mono-280n.6 retires the hosted subgraph dependency
 * entirely.
 *
 * Errors from the upstream subgraph clients are wrapped in
 * DiscoveryUnavailableError so the withFallback chain can engage when the
 * subgraph 429s or times out — directly addressing the failure mode in
 * jinn-mono-uy6v.1.1.
 *
 * Spec: spec/2026-05-11-discovery-api-and-shared-indexer.md §9.2 (callsite
 * migration — transitional wrapper).
 *
 * TODO(280n.6): delete this file once the hosted subgraph is fully removed.
 */

import type { DiscoveryAPI, ClaimableTaskCandidate } from './types.js';
import { DiscoveryUnavailableError } from './types.js';
import type { SolverNetManifestSummary, SolverNetLifecycleStatus } from '../solvernets/registry-client.js';
import type { EnvelopeRef, CorpusQuery } from '../corpus/types.js';
import {
  queryClaimableTaskCandidates,
} from '../adapters/mech/task-subgraph.js';
import type { SubgraphClient } from '../solvernets/registry-client-erc8004.js';
import { resolveMostRecentWins } from '../solvernets/most-recent-wins.js';
import { runCorpusQuery } from '../corpus/query.js';

// ── Constants ────────────────────────────────────────────────────────────────

const SOLVERNET_MANIFEST_KEY_PREFIX = 'solvernet-manifest:';

// ── Options ───────────────────────────────────────────────────────────────────

export interface HttpSubgraphDiscoveryAPIOptions {
  /** Subgraph GraphQL endpoint URL. */
  subgraphUrl: string;
  /**
   * Subgraph client for SolverNet manifest events (listLaunchedSolverNets /
   * getLifecycleStatus). Injected so tests can provide a stub without
   * reaching the network.
   */
  subgraphClient: SubgraphClient;
  /** Fetch implementation (for testability). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

// ── Factory ────────────────────────────────────────────────────────────────────

/**
 * Creates a transitional DiscoveryAPI backed by the existing subgraph clients.
 *
 * All four DiscoveryAPI methods delegate to existing subgraph helpers:
 *
 * - `findClaimableTasks`        → `queryClaimableTaskCandidates` from task-subgraph.ts
 * - `listLaunchedSolverNets`    → SubgraphClient.fetchSetMetadataEvents + most-recent-wins
 * - `getLifecycleStatus`        → SubgraphClient.fetchSetMetadataEventsForCid + most-recent-wins
 * - `queryEnvelopes`            → `runCorpusQuery` from corpus/query.ts
 *
 * Errors from the upstream clients are wrapped in DiscoveryUnavailableError.
 */
export function createHttpSubgraphDiscoveryAPI(
  opts: HttpSubgraphDiscoveryAPIOptions,
): DiscoveryAPI {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const { subgraphUrl, subgraphClient } = opts;

  // ── findClaimableTasks ─────────────────────────────────────────────────────

  async function findClaimableTasks(args: {
    solverNetManifestCids: string[];
    operatorAddress: `0x${string}`;
    nowSeconds?: number;
    pageSize?: number;
    maxPages?: number;
  }): Promise<ClaimableTaskCandidate[]> {
    let candidates;
    try {
      candidates = await queryClaimableTaskCandidates({
        url: subgraphUrl,
        solverNetManifestCids: args.solverNetManifestCids,
        operatorAddress: args.operatorAddress,
        nowSeconds: args.nowSeconds,
        pageSize: args.pageSize,
        maxPages: args.maxPages,
        fetchImpl,
      });
    } catch (err) {
      throw new DiscoveryUnavailableError(
        `HttpSubgraphDiscoveryAPI.findClaimableTasks: subgraph query failed`,
        err,
      );
    }

    // SubgraphTaskCandidate and ClaimableTaskCandidate have the same shape;
    // no field transformation needed — just pass through.
    return candidates as ClaimableTaskCandidate[];
  }

  // ── listLaunchedSolverNets ─────────────────────────────────────────────────

  async function listLaunchedSolverNets(args?: {
    launcherAgentId?: string;
    status?: Array<'launched' | 'paused' | 'retired'>;
  }): Promise<SolverNetManifestSummary[]> {
    let events;
    try {
      events = await subgraphClient.fetchSetMetadataEvents({
        keyPrefix: SOLVERNET_MANIFEST_KEY_PREFIX,
      });
    } catch (err) {
      throw new DiscoveryUnavailableError(
        `HttpSubgraphDiscoveryAPI.listLaunchedSolverNets: subgraph query failed`,
        err,
      );
    }

    const resolved = resolveMostRecentWins(events);

    const out: SolverNetManifestSummary[] = [];
    for (const row of resolved) {
      if (
        args?.launcherAgentId !== undefined &&
        row.launcherAgentId !== args.launcherAgentId
      ) {
        continue;
      }
      if (args?.status !== undefined && !args.status.includes(row.status)) {
        continue;
      }

      // The subgraph floor can only populate fields derivable from on-chain
      // events without an IPFS fetch. Callers that need the full manifest body
      // (name, network, solutionPriceWei, etc.) should call getManifest on the
      // registry client directly.
      out.push({
        manifestCid: row.manifestCid,
        solverNetId: row.manifestCid,        // best-effort: cid as id
        name: '',                             // requires IPFS fetch
        network: '',                          // requires IPFS fetch
        launcherAgentId: row.launcherAgentId,
        launcherSafeAddress: '0x0000000000000000000000000000000000000000',
        status: row.status,
        statusUpdatedAt: row.statusUpdatedAt,
        contractId: '',                       // requires IPFS fetch
        contractVersion: '',                  // requires IPFS fetch
        solutionPriceWei: '0',               // requires IPFS fetch
        verdictPriceWei: '0',                // requires IPFS fetch
        openRoles: [],                        // requires IPFS fetch
        anchorBlock: row.anchorBlock,
      });
    }

    return out;
  }

  // ── getLifecycleStatus ─────────────────────────────────────────────────────

  async function getLifecycleStatus(
    manifestCid: string,
  ): Promise<SolverNetLifecycleStatus | undefined> {
    let events;
    try {
      events = await subgraphClient.fetchSetMetadataEventsForCid({ manifestCid });
    } catch (err) {
      throw new DiscoveryUnavailableError(
        `HttpSubgraphDiscoveryAPI.getLifecycleStatus: subgraph query failed`,
        err,
      );
    }

    if (events.length === 0) return undefined;

    const resolved = resolveMostRecentWins(events);
    if (resolved.length === 0) return undefined;

    // Pick the most-recent across all launchers
    const latest = resolved.reduce((acc, cur) => {
      if (cur.anchorBlock !== acc.anchorBlock) {
        return cur.anchorBlock > acc.anchorBlock ? cur : acc;
      }
      return cur.anchorTransactionIndex > acc.anchorTransactionIndex ? cur : acc;
    });

    return {
      status: latest.status,
      statusUpdatedAt: latest.statusUpdatedAt,
      sourceBlock: latest.anchorBlock,
    };
  }

  // ── queryEnvelopes ─────────────────────────────────────────────────────────

  async function queryEnvelopes(query: CorpusQuery): Promise<EnvelopeRef[]> {
    try {
      return await runCorpusQuery(subgraphUrl, query, fetchImpl);
    } catch (err) {
      throw new DiscoveryUnavailableError(
        `HttpSubgraphDiscoveryAPI.queryEnvelopes: subgraph query failed`,
        err,
      );
    }
  }

  return {
    findClaimableTasks,
    listLaunchedSolverNets,
    getLifecycleStatus,
    queryEnvelopes,
  };
}
