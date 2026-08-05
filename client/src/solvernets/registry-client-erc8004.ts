/**
 * IdentityRegistry-backed `SolverNetRegistryClient` implementation.
 *
 * Day-1 wiring of the abstract interface from `registry-client.ts`:
 *
 *   - publishManifest                → IPFS pin (canonical JCS) + IdentityRegistry.setMetadata
 *   - publishLifecycleTransition     → IdentityRegistry.setMetadata (same key, updated payload)
 *   - listLaunched                   → DiscoveryAPI.listLaunchedSolverNets + IPFS enrichment
 *   - getManifest                    → IPFS fetch + canonical-hash verification + schema validation
 *   - getLifecycleStatus             → DiscoveryAPI.getLifecycleStatus
 *
 * Construction takes a deps bag (IPFS / publisher / discoveryApi) so tests
 * can inject mocks. The interfaces here are deliberately small — a future
 * replacement (alternative gateway, on-chain SolverNet registry contract)
 * can swap implementations without touching the operator flow per
 * spec §13.
 *
 * `DiscoveryAPI.getLifecycleStatus` is the read path for both `getManifest`
 * hash verification and `getLifecycleStatus`.
 */

import { canonicalJson } from '../util/canonical-json.js';
import {
  canonicalManifestJson,
  manifestHash,
} from './manifest.js';
import {
  type SetMetadataEvent,
  type SetMetadataLifecyclePayload,
} from './most-recent-wins.js';
import {
  validateSolverNetManifest,
  type SolverNetManifestV1,
} from '@jinn-network/sdk/solvernets';
import type {
  SolverNetRegistryClient,
  SolverNetManifestSummary,
  SignerWithAgentEoa,
} from './registry-client.js';
import type { DiscoveryAPI } from '../discovery/types.js';
import { DiscoveryUnavailableError } from '../discovery/types.js';

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Metadata-key prefix for SolverNet manifest anchors. The full key is
 * `solvernet-manifest:<cid>`; the prefix alone is what we hand to the
 * subgraph for `LIKE 'solvernet-manifest:%'` filtering.
 */
export const SOLVERNET_MANIFEST_KEY_PREFIX = 'solvernet-manifest:';

/**
 * Map the operator-facing network name (manifest-schema.ts `network` enum) to
 * the on-chain chain id the indexer scopes rows by.
 * Issue #985 criterion 2 — the list path filters on the indexed chainId, not
 * on a manifest body fetched per-row from IPFS.
 */
function networkToChainId(network: string): number {
  return network === 'base' ? 8453 : 84532;
}

function warnAndRethrowDiscoveryUnavailable(manifestCid: string, err: unknown): void {
  if (!(err instanceof DiscoveryUnavailableError)) {
    return;
  }
  const codeSuffix = err.code ? ` (${err.code})` : '';
  console.warn(
    `[solvernet] manifest ${manifestCid}: discoveryApi hash check unavailable${codeSuffix}: ${err.message}`,
  );
  throw err;
}

/**
 * Schema version embedded in every lifecycle payload. Keep in sync with
 * spec §6.3.
 */
export const LIFECYCLE_PAYLOAD_SCHEMA_VERSION = 'solvernet.lifecycle.v1';

// ── Dep interfaces ──────────────────────────────────────────────────────────

/**
 * IPFS surface used by the registry client. Two methods, content-addressed.
 *
 * `upload` accepts an arbitrary serializable object (typically the manifest
 * itself). Implementations are expected to canonicalize via JCS (RFC 8785) so
 * that re-uploading the same logical content yields the same CID — the
 * existing `client/src/adapters/mech/ipfs.ts#uploadToIpfs` already does this.
 *
 * `fetch` returns the parsed JSON body (the helper in `mech/ipfs.ts` returns
 * `unknown`; callers narrow the type at the call site).
 */
export interface IpfsClient {
  upload(data: unknown): Promise<string>;
  fetch(cid: string): Promise<unknown>;
}

/**
 * Result of a single `setMetadata` write — what the publisher returns and
 * what `publishManifest` / `publishLifecycleTransition` propagate.
 */
export interface SetMetadataPublishResult {
  txHash: `0x${string}`;
  blockNumber: number;
}

/**
 * Abstract handle for publishing `IdentityRegistry.setMetadata` writes.
 *
 * The existing `IdentityPublisher` (`client/src/erc8004/identity.ts`) is
 * specialised to the ABI-encoded execution payload tuple; SolverNet
 * lifecycle payloads are a different schema (JCS-canonical JSON bytes), so
 * we abstract via a small interface that takes raw `value` bytes. The Task
 * 5+ wiring will provide a viem-backed implementation; tests mock this.
 *
 * `signer` is plumbed through for implementations that need it (e.g. to
 * derive the agent-EOA private key for the wallet client). The mock test
 * publisher ignores it.
 */
export interface MetadataPublisher {
  setMetadata(args: {
    signer: SignerWithAgentEoa;
    agentId: string;
    key: string;
    value: Uint8Array;
  }): Promise<SetMetadataPublishResult>;
}

/**
 * Subgraph surface used by the registry client. Two queries:
 *
 *   - `fetchSetMetadataEvents` — broad scan by key prefix, used by
 *     `listLaunched`. Optional `sinceBlock` for incremental sync.
 *   - `fetchSetMetadataEventsForCid` — narrow lookup by full key (cid),
 *     used by `getLifecycleStatus`.
 *
 * The Jinn subgraph already indexes `IdentityRegistry.setMetadata` events
 * with `(agentId, key, value, blockNumber, transactionIndex)` rows; this
 * interface narrows that to what the registry client needs.
 *
 * NOTE: at time of writing the subgraph has *not* surfaced this query
 * shape. A follow-up task (Phase 7 / subgraph extension) wires the real
 * GraphQL — see DONE_WITH_CONCERNS in the task report.
 */
export interface SubgraphClient {
  fetchSetMetadataEvents(args: {
    keyPrefix: string;
    sinceBlock?: number;
  }): Promise<SetMetadataEvent[]>;

  fetchSetMetadataEventsForCid(args: {
    manifestCid: string;
  }): Promise<SetMetadataEvent[]>;
}

// ── Construction ────────────────────────────────────────────────────────────

export interface IdentityRegistryBackedSolverNetRegistryClientConfig {
  ipfs: IpfsClient;
  publisher: MetadataPublisher;
  /**
   * DiscoveryAPI instance for all read-side operations (`listLaunched`,
   * `getLifecycleStatus`, manifest-hash cross-checks in `fetchAndValidateManifest`
   * and `getManifest`).
   */
  discoveryApi?: DiscoveryAPI;
  /**
   * Network for which this client serves operator catalog rows. Used to
   * filter `listLaunched` summaries — manifests record their target network
   * in `manifest.network` per spec §7.
   */
  network: 'base-sepolia' | 'base';
  /**
   * Override `Date.now()` for ISO timestamps in published lifecycle
   * payloads. Mainly for deterministic tests.
   */
  now?: () => Date;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Encode a lifecycle payload into JCS-canonical UTF-8 JSON bytes — the on-wire
 * format passed to `IdentityRegistry.setMetadata` for `solvernet.lifecycle.v1`.
 *
 * Exported so the launch state machine (`launch-state-machine.ts`) can encode
 * the same payload shape without duplicating the JCS canonicalization.
 */
export function encodeLifecyclePayload(payload: SetMetadataLifecyclePayload): Uint8Array {
  return new TextEncoder().encode(canonicalJson(payload));
}

// ── Implementation ──────────────────────────────────────────────────────────

export class IdentityRegistryBackedSolverNetRegistryClient
  implements SolverNetRegistryClient
{
  private readonly ipfs: IpfsClient;
  private readonly publisher: MetadataPublisher;
  private readonly discoveryApi: DiscoveryAPI | undefined;
  private readonly network: 'base-sepolia' | 'base';
  private readonly now: () => Date;

  /**
   * In-process cache of manifests we've published or read. Used so
   * `listLaunched` can populate per-row catalog fields (name, contract,
   * prices, openRoles) without forcing a synchronous IPFS fetch for every
   * row. The catalog UI gets a coarse view from the subgraph + cache, and
   * the full manifest is fetched on demand via `getManifest`.
   *
   * For rows whose manifest has not been seen yet (other launchers), the
   * cache miss falls through to a real IPFS fetch — which lets the catalog
   * stay accurate at the cost of some latency. The Task 6 daemon-side
   * SolverNetCatalog will likely add a persistent cache.
   */
  private readonly manifestCache = new Map<string, SolverNetManifestV1>();

  /**
   * Set of cids whose cached manifest body has been verified against the
   * on-chain advertised hash (or where we ourselves were the publisher and
   * therefore know the body is canonical). Once a cid lands here,
   * `getManifest` short-circuits the DiscoveryAPI round-trip on subsequent
   * cache hits — without this set, every cache hit re-verified by calling
   * `discoveryApi.getLifecycleStatus`, silently doubling discovery load in
   * catalog refresh ticks (daemon polling scenarios).
   */
  private readonly verifiedCids = new Set<string>();

  constructor(config: IdentityRegistryBackedSolverNetRegistryClientConfig) {
    this.ipfs = config.ipfs;
    this.publisher = config.publisher;
    this.discoveryApi = config.discoveryApi;
    this.network = config.network;
    this.now = config.now ?? (() => new Date());
  }

  // ── Publish ───────────────────────────────────────────────────────────────

  async publishManifest(args: {
    manifest: SolverNetManifestV1;
    signer: SignerWithAgentEoa;
  }): Promise<{
    manifestCid: string;
    metadataTxHash: `0x${string}`;
    metadataBlockNumber: number;
  }> {
    const { manifest, signer } = args;

    if (signer.agentId !== manifest.launcher.agentId) {
      throw new Error(
        `signer.agentId (${signer.agentId}) does not match manifest.launcher.agentId (${manifest.launcher.agentId})`,
      );
    }

    // Pin the canonical body (signature included — that IS the launched
    // document). IPFS is content-addressed; the same body yields the same
    // cid regardless of how many times we re-pin.
    const manifestCid = await this.ipfs.upload(manifest);

    // Cache the manifest so listLaunched can populate row fields without an
    // IPFS round-trip. We're the publisher here, so the body is canonical
    // by construction — mark the cid as verified so subsequent getManifest
    // calls skip the subgraph re-verification round-trip.
    this.manifestCache.set(manifestCid, manifest);
    this.verifiedCids.add(manifestCid);

    const lifecycle: SetMetadataLifecyclePayload = {
      schemaVersion: LIFECYCLE_PAYLOAD_SCHEMA_VERSION,
      status: 'launched',
      at: this.now().toISOString(),
      hash: manifestHash(manifest),
    };

    const result = await this.publisher.setMetadata({
      signer,
      agentId: signer.agentId,
      key: `${SOLVERNET_MANIFEST_KEY_PREFIX}${manifestCid}`,
      value: encodeLifecyclePayload(lifecycle),
    });

    return {
      manifestCid,
      metadataTxHash: result.txHash,
      metadataBlockNumber: result.blockNumber,
    };
  }

  async publishLifecycleTransition(args: {
    manifestCid: string;
    launcherAgentId: string;
    target: 'launched' | 'paused' | 'retired';
    signer: SignerWithAgentEoa;
  }): Promise<{
    metadataTxHash: `0x${string}`;
    metadataBlockNumber: number;
  }> {
    const { manifestCid, launcherAgentId, target, signer } = args;

    if (signer.agentId !== launcherAgentId) {
      throw new Error(
        `signer.agentId (${signer.agentId}) does not match launcherAgentId (${launcherAgentId})`,
      );
    }

    // Look up the original manifest hash if we have it cached so the
    // lifecycle payload re-asserts the canonical hash. If we don't have it
    // (stateless re-launch from another process), recover by fetching IPFS
    // and canonicalizing — fetchAndValidateManifest also verifies against
    // the on-chain advertised hash so we don't sign over a tampered body.
    //
    // The cache-hit path skips both the subgraph round-trip and the IPFS
    // fetch: the cached manifest was either published by us (canonical by
    // construction) or already verified on a prior read (recorded in
    // `verifiedCids`). Hashing the cached body locally is sufficient to
    // populate the lifecycle payload.
    const cached = this.manifestCache.get(manifestCid);
    let hash: `0x${string}`;
    if (cached !== undefined) {
      hash = manifestHash(cached);
    } else {
      const fetched = await this.fetchAndValidateManifest(manifestCid);
      hash = manifestHash(fetched);
    }

    const lifecycle: SetMetadataLifecyclePayload = {
      schemaVersion: LIFECYCLE_PAYLOAD_SCHEMA_VERSION,
      status: target,
      at: this.now().toISOString(),
      hash,
    };

    const result = await this.publisher.setMetadata({
      signer,
      agentId: launcherAgentId,
      key: `${SOLVERNET_MANIFEST_KEY_PREFIX}${manifestCid}`,
      value: encodeLifecyclePayload(lifecycle),
    });

    return {
      metadataTxHash: result.txHash,
      metadataBlockNumber: result.blockNumber,
    };
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  async listLaunched(args: {
    network: string;
    statusFilter?: Array<'launched' | 'paused' | 'retired'>;
    sinceBlock?: number;
  }): Promise<SolverNetManifestSummary[]> {
    if (!this.discoveryApi) {
      throw new Error(
        'IdentityRegistryBackedSolverNetRegistryClient requires a DiscoveryAPI for listLaunched',
      );
    }
    // Step 1: Obtain enriched summaries from the DiscoveryAPI. Post-#985 the
    // indexer persists every summary field (name/network/prices/openRoles/
    // launcher safe / contract id+version) on the solverNetManifest row, so a
    // single GraphQL query returns the catalog. Rows the indexer hasn't enriched
    // yet (or that an old indexer omits) pass through unenriched here — empty
    // name, '0' prices, zero launcher address; they are not re-enriched via IPFS
    // on this path. Full fields appear once enrichment lands, or via the
    // hash-verified getManifest detail path. Note: listLaunchedSolverNets does
    // not accept sinceBlock — that was a subgraph optimisation that does not
    // translate to the abstract interface.
    const rawSummaries = await this.discoveryApi.listLaunchedSolverNets(
      args.statusFilter !== undefined ? { status: args.statusFilter } : undefined,
    );

    // Step 2: Chain-scope and project. The registry is global; the catalog is
    // chain-scoped. We filter on the INDEXED chainId — no per-row IPFS fetch.
    //
    // Trust delta: this list path now trusts the indexer's enriched fields.
    // The on-demand detail path (getManifest) still hash-verifies the IPFS body
    // against the on-chain advertised hash, so a tampered catalog row surfaces
    // the moment an operator opens that SolverNet's detail.
    const targetChainId = networkToChainId(args.network);
    const out: SolverNetManifestSummary[] = [];
    for (const row of rawSummaries) {
      if (row.chainId !== targetChainId) continue;
      out.push(row);
    }

    return out;
  }

  async getManifest(args: { manifestCid: string }): Promise<SolverNetManifestV1> {
    const cached = this.manifestCache.get(args.manifestCid);

    // Fast path: cid was verified in this process — either we published it
    // (canonical by construction) or we previously verified its hash
    // against the on-chain advertised hash. Trust the cached body without
    // hitting the subgraph. Skipping this re-verification is what keeps
    // catalog refresh ticks from doubling subgraph load.
    if (cached !== undefined && this.verifiedCids.has(args.manifestCid)) {
      return cached;
    }

    if (cached !== undefined) {
      // Cached but not yet marked verified (shouldn't happen with the
      // current cache-population paths, which always mark verified, but
      // we keep this branch defensive). Verify hash against on-chain
      // advertised hash via discoveryApi.getLifecycleStatus.
      let advertisedHash: `0x${string}` | null = null;
      if (this.discoveryApi) {
        try {
          const lifecycleStatus = await this.discoveryApi.getLifecycleStatus(args.manifestCid);
          if (lifecycleStatus?.manifestHash && lifecycleStatus.manifestHash !== '0x') {
            advertisedHash = lifecycleStatus.manifestHash;
          }
        } catch (err) {
          warnAndRethrowDiscoveryUnavailable(args.manifestCid, err);
          console.error(
            `[solvernet] manifest ${args.manifestCid}: discoveryApi hash check unavailable; ` +
            `using IPFS CID-bound manifest (${err instanceof Error ? err.message : String(err)})`,
          );
        }
      }
      if (advertisedHash !== null) {
        const actual = manifestHash(cached);
        if (advertisedHash.toLowerCase() !== actual.toLowerCase()) {
          throw new Error(
            `manifest hash mismatch for cid ${args.manifestCid}: ipfs=${actual} chain=${advertisedHash}`,
          );
        }
      }
      this.verifiedCids.add(args.manifestCid);
      return cached;
    }

    return this.fetchAndValidateManifest(args.manifestCid);
  }

  async getManifestFromCache(args: {
    manifestCid: string;
  }): Promise<SolverNetManifestV1 | null> {
    // Cache-only: never falls through to IPFS. Used by hot-path callers
    // (e.g. the daemon's `/v1/solvernets/launched` list endpoint) that
    // would otherwise hit IPFS once per row. The cache is populated when
    // we publish a manifest or successfully read one through `getManifest`,
    // so for SolverNets the daemon launched itself the cache is always
    // warm. For records observed only via subgraph (other launchers),
    // callers see `null` here and fall back to whatever degraded surface
    // they prefer — for the launched-list endpoint, omitting `summary`
    // entirely.
    const cached = this.manifestCache.get(args.manifestCid);
    return cached ?? null;
  }

  async getLifecycleStatus(args: { manifestCid: string }): Promise<{
    status: 'launched' | 'paused' | 'retired';
    statusUpdatedAt: string;
    sourceBlock: number;
    manifestHash: `0x${string}`;
  }> {
    if (!this.discoveryApi) {
      throw new Error(
        'IdentityRegistryBackedSolverNetRegistryClient requires a DiscoveryAPI for getLifecycleStatus',
      );
    }
    const result = await this.discoveryApi.getLifecycleStatus(args.manifestCid);
    if (result === undefined) {
      throw new Error(
        `no setMetadata events for manifestCid ${args.manifestCid}`,
      );
    }
    return result;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Fetch a manifest from IPFS, validate the schema, and (when available)
   * cross-check the canonical hash against the on-chain advertised hash.
   *
   * `expectedHash`, when provided by the caller (e.g. `listLaunched` already
   * has it from the resolved row), short-circuits the per-cid subgraph
   * round-trip in `getManifest`.
   */
  private async fetchAndValidateManifest(
    manifestCid: string,
    expectedHash?: `0x${string}`,
  ): Promise<SolverNetManifestV1> {
    const raw = await this.ipfs.fetch(manifestCid);

    const validation = validateSolverNetManifest(raw);
    if (!validation.ok) {
      const issueSummary = validation.issues
        .slice(0, 3)
        .map((i) => `${i.path}: ${i.message}`)
        .join('; ');
      throw new Error(
        `IPFS body for cid ${manifestCid} is not a valid SolverNetManifestV1 (${issueSummary})`,
      );
    }
    const manifest = validation.value;

    let hash = expectedHash ?? null;
    if (hash === null && this.discoveryApi) {
      try {
        const lifecycleStatus = await this.discoveryApi.getLifecycleStatus(manifestCid);
        if (lifecycleStatus?.manifestHash && lifecycleStatus.manifestHash !== '0x') {
          hash = lifecycleStatus.manifestHash;
        }
      } catch (err) {
        warnAndRethrowDiscoveryUnavailable(manifestCid, err);
        console.error(
          `[solvernet] manifest ${manifestCid}: discoveryApi hash check unavailable; ` +
          `using IPFS CID-bound manifest (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }

    if (hash !== null) {
      const actual = manifestHash(manifest);
      if (actual.toLowerCase() !== hash.toLowerCase()) {
        throw new Error(
          `manifest hash mismatch for cid ${manifestCid}: ipfs=${actual} chain=${hash}`,
        );
      }
    }

    // Sanity: re-canonicalizing the parsed manifest should equal what the
    // hash check just verified. This is implied by the hash match above,
    // but the call also exercises the canonical-JSON path on read so a
    // canonicalization regression surfaces here, not later.
    void canonicalManifestJson(manifest);

    this.manifestCache.set(manifestCid, manifest);
    // Mark the cid verified iff we cross-checked the canonical hash
    // against an on-chain advertised hash. Without an on-chain reference
    // (no events for this cid yet) we still cache for performance, but
    // refrain from short-circuiting future hash checks.
    if (hash !== null) {
      this.verifiedCids.add(manifestCid);
    }
    return manifest;
  }

}
