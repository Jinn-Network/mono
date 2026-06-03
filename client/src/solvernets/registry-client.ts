/**
 * SolverNet registry client interface.
 *
 * Abstract surface for publishing and reading SolverNet launched-instance
 * authority documents (manifests) and their lifecycle status. Per
 * `spec/2026-05-05-solvernet-creation-and-launch.md` §13: the operator app
 * depends on this interface so the day-1 IdentityRegistry+subgraph backing can
 * be replaced later (alternative IPFS gateway, future on-chain SolverNet
 * registry contract, etc.) without touching the manifest schema or operator
 * flow.
 *
 * INTERFACE ONLY. The day-1 concrete implementation
 * (`IdentityRegistryBackedSolverNetRegistryClient`) lands in Task 4 and wires:
 *   - publishManifest / publishLifecycleTransition → IdentityRegistry.setMetadata
 *   - listLaunched / getLifecycleStatus            → subgraph (most-recent-wins)
 *   - getManifest                                  → IPFS via `client/src/adapters/mech/ipfs.ts`
 */

import type { SolverNetManifestV1 } from '@jinn-network/sdk/solvernets';

// ── Supporting types ────────────────────────────────────────────────────────

/**
 * Current lifecycle status of a SolverNet manifest.
 *
 * Returned by `SolverNetRegistryClient.getLifecycleStatus`. This is the
 * canonical definition; `client/src/discovery/types.ts` re-exports it so
 * consumers of the discovery layer only need one import path.
 */
export interface SolverNetLifecycleStatus {
  status: 'launched' | 'paused' | 'retired';
  statusUpdatedAt: string;
  sourceBlock: number;
  manifestHash: `0x${string}`;
}

/**
 * Minimal "ready to sign" handle for the launcher's agent EOA. Held by the
 * registry client implementation to (a) sign manifests via `signManifest` and
 * (b) send the on-chain `setMetadata` tx that anchors the manifest CID.
 *
 * Kept data-only on purpose: no viem `Account`, no signer abstraction. This
 * makes test doubles trivial and avoids leaking viem types into the interface.
 * The Task 4 implementation derives the viem account from `agentEoaPrivateKey`
 * at the call site.
 *
 * `agentId` is included for convenience so the implementation does not have to
 * round-trip the IdentityRegistry to look it up before publishing.
 */
export interface SignerWithAgentEoa {
  agentEoaAddress: `0x${string}`;
  agentEoaPrivateKey: `0x${string}`;
  agentId: string;
}

/**
 * Catalog-row projection of a launched SolverNet — the minimum useful shape
 * for the operator catalog UI and join flow. `listLaunched` returns these;
 * the full manifest is fetched on demand via `getManifest`.
 *
 * `status` and `statusUpdatedAt` reflect the most-recent-wins resolution of
 * the launcher's lifecycle transitions (§13 day-1 implementation note).
 *
 * Lives next to the interface (not in the SDK) until a second consumer
 * appears; promotable later without breaking callers.
 */
export interface SolverNetManifestSummary {
  manifestCid: string;
  solverNetId: string;
  name: string;
  network: string;
  launcherAgentId: string;
  launcherSafeAddress: `0x${string}`;
  status: 'launched' | 'paused' | 'retired';
  statusUpdatedAt: string;
  contractId: string;
  contractVersion: string;
  solutionPriceWei: string;
  verdictPriceWei: string;
  openRoles: Array<'solver' | 'evaluator'>;
  anchorBlock: number;
  /**
   * Indexed chain id from the on-chain MetadataSet event (84532 = base-sepolia,
   * 8453 = base). Used by listLaunched for chain scoping without an IPFS fetch.
   * Issue #985 criterion 2.
   */
  chainId: number;
}

// ── Interface ───────────────────────────────────────────────────────────────

/**
 * Abstract registry client. Five methods, mirroring spec §13 exactly.
 *
 * Publish-side (`publishManifest`, `publishLifecycleTransition`) require a
 * `SignerWithAgentEoa` — they sign and broadcast on the launcher's behalf.
 * Read-side (`listLaunched`, `getManifest`, `getLifecycleStatus`) are
 * permissionless lookups that do not need a signer.
 */
export interface SolverNetRegistryClient {
  publishManifest(args: {
    manifest: SolverNetManifestV1;
    signer: SignerWithAgentEoa;
  }): Promise<{
    manifestCid: string;
    metadataTxHash: `0x${string}`;
    metadataBlockNumber: number;
  }>;

  publishLifecycleTransition(args: {
    manifestCid: string;
    launcherAgentId: string;
    target: 'launched' | 'paused' | 'retired';
    signer: SignerWithAgentEoa;
  }): Promise<{
    metadataTxHash: `0x${string}`;
    metadataBlockNumber: number;
  }>;

  listLaunched(args: {
    network: string;
    statusFilter?: Array<'launched' | 'paused' | 'retired'>;
    sinceBlock?: number;
  }): Promise<SolverNetManifestSummary[]>;

  getManifest(args: {
    manifestCid: string;
  }): Promise<SolverNetManifestV1>;

  /**
   * Cache-only manifest lookup. Returns the cached manifest body if the
   * client has previously seen this cid (via publish or read), or `null`
   * otherwise. Never falls through to IPFS — the goal is server-side hot-
   * path enrichment (e.g. embedding manifest summaries in list responses)
   * where an IPFS round-trip per row would be unacceptable. Callers that
   * need the full IPFS-validated body should use `getManifest`.
   *
   * Synchronous in spirit (the day-1 implementation reads a Map), but typed
   * as `Promise` to keep the interface symmetric with the rest of the API
   * and to allow future implementations to back the cache with async
   * storage (e.g. SQLite) without a breaking change.
   */
  getManifestFromCache(args: {
    manifestCid: string;
  }): Promise<SolverNetManifestV1 | null>;

  getLifecycleStatus(args: {
    manifestCid: string;
  }): Promise<SolverNetLifecycleStatus>;
}
