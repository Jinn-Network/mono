/**
 * Daemon-side bootstrap of the SolverNet subsystem.
 *
 * Spec: `spec/2026-05-05-solvernet-creation-and-launch.md` Task 11 (daemon
 * startup integration). Wires the persistence, recovery, and operator
 * catalog surfaces so the daemon can resume in-flight launches and serve the
 * operator catalog UI.
 *
 * This module is intentionally THIN: it composes existing pieces (`SolverNetStore`,
 * `recoverInFlightLaunches`, and the
 * `IdentityRegistryBackedSolverNetRegistryClient`) into a single
 * `initSolverNetSubsystem(deps)` call that `main.ts` invokes once after the
 * `FleetBootstrapper` finishes. Task 11 sets up the SCAFFOLDING; Task 12
 * is responsible for the gating refactor that swaps out the legacy
 * `collectTestnetAutoTaskGenerators` path for owned launched-record-driven
 * generator construction.
 *
 * Order of operations (mirrors the per-section ordering in
 * `launch-state-machine.ts`):
 *
 *   1. Resume any record stuck in `status: 'launching'` →
 *      `recoverInFlightLaunches`. Safe to call when no records are in flight.
 *   2. Load owned records → identify which ones have
 *      `status in {'launched','paused'} && generatorEnabled`; those carry the
 *      live record/config refs the SolverNet endpoints read and mutate.
 *   3. Start the operator catalog refresher loop (interval-driven) so the
 *      daemon API can hand SPA reads without a synchronous subgraph round
 *      trip on every poll.
 *
 * The lifecycle-transition resume scan retired with Wave-4 D3 (Task 18 of the
 * cutover stage-3 plan, DR-2026-08-05 decision 1): the transition PRODUCER is
 * gone, so no record can be left mid-transition by this daemon generation. A
 * record persisted with `lifecycleProgress` by an older generation still
 * parses — the wire vocabulary stays — it is simply never resumed.
 *
 * Out of scope for Task 11 (do NOT add here):
 *
 *   - Actually constructing `prediction.v1` generators per launched record
 *     (Task 12).
 *   - Wiring the catalog cache into the API server's `/v1/solvernets/*`
 *     endpoints (Task 14/15).
 *   - Removing the legacy `collectTestnetAutoTaskGenerators` path
 *     (Task 12).
 *
 * Note: the launch state machine uses a noop subgraph client
 * internally for the mempool-drop recovery path. A real subgraph extension
 * (Task 25) will replace the noop; until then recovery falls back to
 * re-broadcasting dropped transactions, which is safe and idempotent.
 */

import {
  uploadToIpfs,
  fetchFromIpfs,
} from '../adapters/mech/ipfs.js';
import {
  IDENTITY_REGISTRY_SET_METADATA_ABI,
} from '../erc8004/abis.js';
import {
  IdentityRegistryBackedSolverNetRegistryClient,
  type IpfsClient,
  type MetadataPublisher,
  type SetMetadataPublishResult,
  type SubgraphClient,
} from './registry-client-erc8004.js';
import type {
  SetMetadataEvent,
  SetMetadataLifecyclePayload,
} from './most-recent-wins.js';
import {
  recoverInFlightLaunches,
  type LaunchActionDeps,
  type ResolveSigner,
} from './launch-state-machine.js';
import type { SolverNetRegistryClient, SolverNetManifestSummary } from './registry-client.js';
import type { DiscoveryAPI, DiscoveryUnavailableCode } from '../discovery/types.js';
import { DiscoveryUnavailableError } from '../discovery/types.js';
import type { LaunchedSolverNetRecord, SolverNetStore } from './store.js';

// Import viem types lazily-named — keep the runtime import scoped so unit
// tests don't pay viem startup cost when they pass mocked publishers.
import { encodeFunctionData, type PublicClient, type WalletClient } from 'viem';
import {
  viemSendTransactionWithRetry,
  type TxRetryWalletClient,
} from '../tx-retry.js';

// Noop SubgraphClient used by the launch state-machine recovery path
// (mempool-drop detection) until a real subgraph extension is wired (Task 25).
// Not exported — callers should not depend on this implementation.
const NOOP_SUBGRAPH_CLIENT: SubgraphClient = {
  async fetchSetMetadataEvents() { return []; },
  async fetchSetMetadataEventsForCid() { return []; },
};

// ── Catalog refresh defaults ────────────────────────────────────────────────

/**
 * How often the operator catalog cache is refreshed against the registry
 * client. 30 seconds is conservative — operators rarely launch multiple
 * SolverNets per minute, and the SPA's join-flow polling is on a similar
 * cadence. Tunable via `initSolverNetSubsystem.catalogRefreshIntervalMs`.
 */
export const DEFAULT_CATALOG_REFRESH_INTERVAL_MS = 30_000;

// ── Public types ────────────────────────────────────────────────────────────

/**
 * Catalog-cache surface — what the daemon API will read in Task 14/15.
 *
 * `getCatalog()` returns the most recently fetched summaries (or an empty
 * array before the first refresh succeeds). `refresh()` forces an immediate
 * fetch outside the periodic interval — useful for tests and for
 * post-action UI invalidation. `stop()` cancels the periodic interval.
 */
export interface SolverNetCatalogCache {
  getCatalog(): SolverNetManifestSummary[];
  refresh(): Promise<void>;
  stop(): void;
  /** Last successful refresh. `null` until the first refresh lands. */
  lastRefreshedAt(): Date | null;
  /**
   * Last refresh error, if any. Cleared on the next successful refresh.
   *
   * `code` carries a typed reason when one can be classified — currently only
   * `rpc_rate_limited` (the configured RPC returned a 429). The operator UI
   * branches on this to render a distinct, actionable message instead of a
   * generic "catalog failed to load". See jinn-mono #325.
   */
  lastError(): { message: string; at: Date; code?: DiscoveryUnavailableCode } | null;
}

/**
 * One spawn-ready entry surfaced to `main.ts`. The daemon constructs a
 * generator per entry using `makePredictionV1GeneratorForLaunchedRecord`
 * (Task 12 of spec/2026-05-05-solvernet-creation-and-launch.md §11) and
 * passes the same `recordRef` and `configRef` so:
 *
 *   - The record ref carries the record's live status for the read surfaces.
 *   - The SolverNet config API endpoint (Task 14) mutates `configRef.current`
 *     and the per-tick reads the new cadence / allowlist / caps within one
 *     cadence — no daemon restart, no generator recreation.
 *
 * The same refs are also the source of truth that the catalog/status
 * endpoints read so SPA reads always match what the generator is actually
 * doing. Task 12 wires the generator construction; Tasks 14/15 hand these
 * refs to the API server.
 */
export interface PendingGeneratorSpawn {
  /** Snapshot of the launched record at subsystem-init time. */
  record: LaunchedSolverNetRecord;
 /**
   * Live mirror of the launched record. The SolverNet generator-config
   * endpoint mutates `recordRef.current` immediately after persisting to
   * disk, so subsequent reads do not wait for a reload.
   */
  recordRef: { current: LaunchedSolverNetRecord };
  /**
   * Live mirror of the hot-applyable runtime generator config. The
   * subsystem seeds it with the record's last-saved config (or all-default
   * empty config when no per-record overrides are set yet). Task 14 mutates
   * this when the operator edits the generator config.
   */
  configRef: { current: unknown };
}

/**
 * What `initSolverNetSubsystem` returns. Tasks 14/15 hand
 * `pendingGenerators` and the catalog cache to the API server; `main.ts`
 * iterates `pendingGenerators` to actually construct generators (Task 12
 * wires the generator factory).
 */
export interface SolverNetSubsystem {
  /** All launched records currently on disk (post-recovery). */
  records: LaunchedSolverNetRecord[];
  /**
   * Subset of `records` where `status` is `launched` or `paused` and
   * `generatorEnabled === true`, paired with the live refs the generator
   * factory and the API endpoints share. Paused records are intentionally
   * wired so a read of `recordRef.current` reflects the persisted status.
   */
  pendingGenerators: PendingGeneratorSpawn[];
  /** Operator catalog cache, populated on first refresh. */
  catalog: SolverNetCatalogCache;
  /** The registry client (for reuse by the daemon API). */
  registryClient: SolverNetRegistryClient;
  /** Outcome of the launch recovery scan. Useful for test assertions and logging. */
  recovery: {
    inFlightLaunches: { resumed: number; failed: Array<{ solverNetId: string; error: Error }> };
  };
  /** Stop the catalog refresher and any future timers. Idempotent. */
  stop(): void;
}

/**
 * Required inputs. The store / clients can be the production
 * implementations or test mocks — the module is dep-injected end to end
 * so unit tests don't have to mock viem.
 *
 * `network` is the chain the catalog cache filters on (per
 * `IdentityRegistryBackedSolverNetRegistryClient.listLaunched`).
 *
 * `resolveSigner` is required for the launch-recovery branch (the launch
 * state machine signs re-broadcasts on resume).
 */
export interface InitSolverNetSubsystemDeps {
  store: SolverNetStore;
  ipfs: IpfsClient;
  publisher: MetadataPublisher;
  registryClient: SolverNetRegistryClient;
  network: 'base-sepolia' | 'base';
  resolveSigner: ResolveSigner;
  /** Resolves a tx hash to a confirmed receipt. Same as the state machines. */
  awaitTxConfirmation: LaunchActionDeps['awaitTxConfirmation'];
  /** Optional override for `setInterval` / `clearInterval` (tests). */
  scheduler?: {
    setInterval: (cb: () => void, ms: number) => unknown;
    clearInterval: (handle: unknown) => void;
  };
  /** Period (ms) for the catalog refresher. */
  catalogRefreshIntervalMs?: number;
  /**
   * If `true`, skip starting the catalog refresher interval — useful for
   * tests that only assert the load+recover flow. The catalog is still
   * exposed; tests call `catalog.refresh()` manually.
   */
  disableCatalogAutoRefresh?: boolean;
  /**
   * Optional logger for catalog-refresh errors and recovery summaries.
   * Defaults to `console`.
   */
  logger?: { warn: (msg: string) => void; info: (msg: string) => void };
  /** Override the wall clock for deterministic tests. */
  now?: () => Date;
}

// ── Implementation ──────────────────────────────────────────────────────────

/**
 * Initialise the SolverNet subsystem at daemon startup.
 *
 * Call after `FleetBootstrapper` resolves (so the master Safe + agent EOA
 * referenced by launched records are available) and before any task
 * generators are constructed.
 *
 * Errors during the recovery scans are captured per-record into
 * `recovery.inFlightLaunches.failed` so a single broken record cannot block
 * daemon startup. Errors during
 * the initial catalog refresh are logged and stored on the cache; the
 * refresher continues ticking.
 */
export async function initSolverNetSubsystem(
  deps: InitSolverNetSubsystemDeps,
): Promise<SolverNetSubsystem> {
  const logger = deps.logger ?? {
    warn: (msg: string) => console.warn(msg),
    info: (msg: string) => console.log(msg),
  };

  // Step 1 — resume in-flight launches. The state machine is forward-only
  // and idempotent under retry, so this is safe even when no records are
  // in flight.
  const inFlightLaunches = await recoverInFlightLaunches({
    store: deps.store,
    ipfs: deps.ipfs,
    publisher: deps.publisher,
    subgraph: NOOP_SUBGRAPH_CLIENT,
    awaitTxConfirmation: deps.awaitTxConfirmation,
    resolveSigner: deps.resolveSigner,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  if (inFlightLaunches.failed.length > 0) {
    logger.warn(
      `[solvernet] launch recovery: ${inFlightLaunches.resumed} resumed, ` +
        `${inFlightLaunches.failed.length} failed`,
    );
  } else if (inFlightLaunches.resumed > 0) {
    logger.info(`[solvernet] launch recovery: ${inFlightLaunches.resumed} resumed`);
  }

  // Step 2 — load post-recovery records and split into the spawn-ready set.
  // Each spawn-ready entry carries a `recordRef` and a `configRef` that the
  // generator factories close
  // over. The SolverNet config API endpoint mutates these refs at runtime so
  // the read surfaces reflect the change without a disk reload. Defaults for the runtime config
  // are an empty object: the generator falls back to its built-in defaults
  // until the operator edits config via Task 14.
  const records = await deps.store.loadOwnedRecords();
  const pendingGenerators: PendingGeneratorSpawn[] = records
    .filter((r) => (r.status === 'launched' || r.status === 'paused') && r.generatorEnabled)
    .map((record) => ({
      record,
      recordRef: { current: record },
      // Seed configRef from the record's persisted generatorConfig if present
      // (set by Task 14's `PATCH /v1/solvernets/launched/:id/generator-config`
      // endpoint), otherwise use an empty config so the generator falls back
      // to its built-in defaults.
      configRef: {
        current: record.generatorConfig ?? {},
      },
    }));
  logger.info(
    `[solvernet] loaded ${records.length} owned record(s); ` +
      `${pendingGenerators.length} ready for generator spawn`,
  );

  // Step 3 — start the catalog refresher.
  const catalog = createCatalogCache({
    registryClient: deps.registryClient,
    network: deps.network,
    intervalMs: deps.catalogRefreshIntervalMs ?? DEFAULT_CATALOG_REFRESH_INTERVAL_MS,
    scheduler: deps.scheduler,
    autoRefresh: !deps.disableCatalogAutoRefresh,
    logger,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  // Best-effort initial refresh so the API has something to serve as soon as
  // the SPA polls. We do not block startup on the result — a registry that
  // can't be reached should not gate the daemon coming up.
  catalog.refresh().catch(() => {
    // Already captured into catalog.lastError; nothing to do here.
  });

  return {
    records,
    pendingGenerators,
    catalog,
    registryClient: deps.registryClient,
    recovery: {
      inFlightLaunches,
    },
    stop() {
      catalog.stop();
    },
  };
}

// ── Catalog cache ───────────────────────────────────────────────────────────

/**
 * Recover the typed `DiscoveryUnavailableError.code` from a refresh failure.
 * In every current production path the on-chain floor throws the
 * DiscoveryUnavailableError directly; the `cause` lookup is defensive — should
 * an enrichment layer ever wrap the error, the typed signal is still recovered
 * rather than collapsed to a generic failure. See jinn-mono #325.
 */
function discoveryCodeOf(err: unknown): DiscoveryUnavailableCode | undefined {
  if (err instanceof DiscoveryUnavailableError) return err.code;
  const cause = err instanceof Error ? (err as { cause?: unknown }).cause : undefined;
  if (cause instanceof DiscoveryUnavailableError) return cause.code;
  return undefined;
}

interface CatalogCacheConfig {
  registryClient: SolverNetRegistryClient;
  network: 'base-sepolia' | 'base';
  intervalMs: number;
  scheduler?: InitSolverNetSubsystemDeps['scheduler'];
  autoRefresh: boolean;
  logger: { warn: (msg: string) => void; info: (msg: string) => void };
  now?: () => Date;
}

function createCatalogCache(config: CatalogCacheConfig): SolverNetCatalogCache {
  let snapshot: SolverNetManifestSummary[] = [];
  let lastRefreshedAt: Date | null = null;
  let lastError: { message: string; at: Date; code?: DiscoveryUnavailableCode } | null = null;
  const now = config.now ?? (() => new Date());

  const setInt = config.scheduler?.setInterval ?? ((cb, ms) => setInterval(cb, ms));
  const clearInt = config.scheduler?.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));

  let handle: unknown = null;

  async function refresh(): Promise<void> {
    try {
      const summaries = await config.registryClient.listLaunched({ network: config.network });
      snapshot = summaries;
      lastRefreshedAt = now();
      lastError = null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Preserve the typed `rpc_rate_limited` signal so the operator UI can
      // tell a throttled RPC apart from a generic catalog failure.
      const code = discoveryCodeOf(err);
      lastError = { message, at: now(), ...(code !== undefined ? { code } : {}) };
      config.logger.warn(
        `[solvernet] catalog refresh failed${code ? ` (${code})` : ''}: ${message}`,
      );
    }
  }

  if (config.autoRefresh) {
    handle = setInt(() => {
      void refresh();
    }, config.intervalMs);
  }

  return {
    getCatalog: () => snapshot,
    refresh,
    stop() {
      if (handle !== null) {
        clearInt(handle);
        handle = null;
      }
    },
    lastRefreshedAt: () => lastRefreshedAt,
    lastError: () => lastError,
  };
}

// ── Adapter helpers ─────────────────────────────────────────────────────────
//
// `main.ts` will use these to build the production deps for
// `initSolverNetSubsystem`. They are exported here so a future test that
// wants the production adapter (rather than a hand-rolled mock) can opt in.

/**
 * Wrap the existing global `uploadToIpfs` / `fetchFromIpfs` helpers in the
 * `IpfsClient` interface used by the SolverNet registry client. Same
 * canonical-JSON semantics as the rest of the daemon.
 */
export function createIpfsClientAdapter(args: {
  registryUrl: string;
  gatewayUrl: string;
}): IpfsClient {
  return {
    upload: (data) => uploadToIpfs(args.registryUrl, data),
    fetch: (cid) => fetchFromIpfs(args.gatewayUrl, cid),
  };
}

/**
 * Adapter that turns a viem (walletClient, publicClient, identityRegistryAddress)
 * triple into a `MetadataPublisher` whose `value` is treated as raw bytes
 * (the JCS-encoded SolverNet lifecycle payload), bypassing the
 * `IdentityPublisher`'s ABI-encoded execution-payload tuple. Production
 * `main.ts` constructs one of these alongside the existing `IdentityPublisher`
 * — they share the same on-chain `setMetadata` ABI but encode different
 * payload schemas under different `metadataKey` prefixes.
 *
 * `signer` from the call site is passed through but unused here — the
 * walletClient is bound at construction time. The interface keeps it so
 * tests can swap in a mock that does inspect it.
 */
export function createMetadataPublisherFromViem(args: {
  identityRegistryAddress: `0x${string}`;
  walletClient: WalletClient;
  publicClient: PublicClient;
}): MetadataPublisher {
  return {
    async setMetadata({ agentId, key, value }): Promise<SetMetadataPublishResult> {
      const account = args.walletClient.account;
      if (!account) {
        throw new Error('createMetadataPublisherFromViem: walletClient has no account configured');
      }
      const chain = args.walletClient.chain;
      if (!chain) {
        throw new Error('createMetadataPublisherFromViem: walletClient has no chain configured');
      }
      // Route through viemSendTransactionWithRetry so this launch/lifecycle
      // setMetadata shares the per-EOA broadcast lock + nonce ledger + retry
      // with the Safe-mediated loops (creator / claim / deliver) and
      // eviction-recovery that broadcast from the SAME agent EOA. A raw
      // writeContract here let viem auto-fill the nonce from the pending count,
      // which raced those loops and reverted "nonce too low" — the #525 launch
      // stall. (Sibling to the IdentityPublisher fix in a4a52ca2;
      // encodeFunctionData reproduces the exact calldata writeContract built.)
      const data = encodeFunctionData({
        abi: IDENTITY_REGISTRY_SET_METADATA_ABI,
        functionName: 'setMetadata',
        // viem's bytes input accepts `0x`-prefixed hex; convert from Uint8Array.
        args: [BigInt(agentId), key, uint8ArrayToHex(value)],
      });
      const txHash = await viemSendTransactionWithRetry(
        args.walletClient as unknown as TxRetryWalletClient,
        args.publicClient,
        {
          account,
          to: args.identityRegistryAddress,
          data,
          value: 0n,
        },
        { logicalTx: 'solvernet.setMetadata' },
      );
      const receipt = await args.publicClient.waitForTransactionReceipt({ hash: txHash });
      return {
        txHash,
        blockNumber: Number(receipt.blockNumber),
      };
    },
  };
}

/**
 * Build a production `IdentityRegistryBackedSolverNetRegistryClient` from a
 * pre-built deps bundle. Convenience wrapper kept here so `main.ts` only
 * imports from `./solvernets/daemon-init.js` for the whole subsystem.
 */
export function createDefaultRegistryClient(args: {
  ipfs: IpfsClient;
  publisher: MetadataPublisher;
  discoveryApi: DiscoveryAPI;
  network: 'base-sepolia' | 'base';
}): SolverNetRegistryClient {
  return new IdentityRegistryBackedSolverNetRegistryClient({
    ipfs: args.ipfs,
    publisher: args.publisher,
    discoveryApi: args.discoveryApi,
    network: args.network,
  });
}

// ── Internals ───────────────────────────────────────────────────────────────

function uint8ArrayToHex(bytes: Uint8Array): `0x${string}` {
  let hex = '0x';
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0');
  }
  return hex as `0x${string}`;
}
