/**
 * Daemon-side bootstrap of the SolverNet subsystem.
 *
 * Spec: `spec/2026-05-05-solvernet-creation-and-launch.md` Task 11 (daemon
 * startup integration). Wires the persistence, recovery, and operator
 * catalog surfaces so the daemon can resume in-flight launches/lifecycle
 * transitions and serve the operator catalog UI.
 *
 * This module is intentionally THIN: it composes existing pieces (`SolverNetStore`,
 * `recoverInFlightLaunches`, `recoverInFlightLifecycleTransitions`, and the
 * `IdentityRegistryBackedSolverNetRegistryClient`) into a single
 * `initSolverNetSubsystem(deps)` call that `main.ts` invokes once after the
 * `FleetBootstrapper` finishes. Task 11 sets up the SCAFFOLDING; Task 12
 * is responsible for the gating refactor that swaps out the legacy
 * `collectTestnetAutoTaskGenerators` path for owned launched-record-driven
 * generator construction.
 *
 * Order of operations (mirrors the per-section ordering in
 * `launch-state-machine.ts` and `lifecycle-transitions.ts`):
 *
 *   1. Resume any record stuck in `status: 'launching'` →
 *      `recoverInFlightLaunches`. Safe to call when no records are in flight.
 *   2. Resume any record with `lifecycleProgress` set →
 *      `recoverInFlightLifecycleTransitions`. Same safety property.
 *   3. Load owned records → identify which ones have
 *      `status === 'launched' && generatorEnabled`; those are the
 *      "ready-to-spawn" set the next-task generator wiring will iterate.
 *   4. Start the operator catalog refresher loop (interval-driven) so the
 *      daemon API can hand SPA reads without a synchronous subgraph round
 *      trip on every poll.
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
 * Day-1 SubgraphClient note: the canonical Jinn subgraph has not yet
 * surfaced the `solvernet-manifest:` setMetadata index (Task 25 wires the
 * extension). Until then, callers may pass `createNoopSubgraphClient()` so
 * `recoverInFlightLaunches` and `listLaunched` return empty arrays
 * gracefully — recovery only short-circuits via subgraph events on
 * mempool-drop (rare); the catalog refresher logs a one-line warning when
 * it observes the no-op path so the operator can see the wiring is
 * incomplete. Production wiring happens in Task 25.
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
import {
  recoverInFlightLifecycleTransitions,
  type LifecycleTransitionDeps,
} from './lifecycle-transitions.js';
import type { SolverNetRegistryClient, SolverNetManifestSummary } from './registry-client.js';
import type { LaunchedSolverNetRecord, SolverNetStore } from './store.js';
import type { PredictionV1GeneratorRuntimeConfig } from '../solver-types/prediction-v1-auto.js';

// Import viem types lazily-named — keep the runtime import scoped so unit
// tests don't pay viem startup cost when they pass mocked publishers.
import type { PublicClient, WalletClient } from 'viem';

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
  /** Last refresh error, if any. Cleared on the next successful refresh. */
  lastError(): { message: string; at: Date } | null;
}

/**
 * One spawn-ready entry surfaced to `main.ts`. The daemon constructs a
 * generator per entry using `makePredictionV1GeneratorForLaunchedRecord`
 * (Task 12 of spec/2026-05-05-solvernet-creation-and-launch.md §11) and
 * passes the same `recordRef` and `configRef` so:
 *
 *   - Lifecycle transitions (pause/resume/retire) update `recordRef.current`
 *     and the per-tick gate sees the new status within one cadence.
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
   * Live mirror of the launched record. The lifecycle-transition path
   * mutates `recordRef.current` immediately after persisting status changes
   * to disk (and Task 12 also wires lifecycle resume to mutate it on
   * recovery).
   */
  recordRef: { current: LaunchedSolverNetRecord };
  /**
   * Live mirror of the hot-applyable runtime generator config. The
   * subsystem seeds it with the record's last-saved config (or all-default
   * empty config when no per-record overrides are set yet). Task 14 mutates
   * this when the operator edits cadence / allow-block-lists / caps.
   */
  configRef: { current: PredictionV1GeneratorRuntimeConfig };
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
   * Subset of `records` where `status === 'launched'` and
   * `generatorEnabled === true`, paired with the live refs the generator
   * factory and the API endpoints share.
   */
  pendingGenerators: PendingGeneratorSpawn[];
  /** Operator catalog cache, populated on first refresh. */
  catalog: SolverNetCatalogCache;
  /** The registry client (for reuse by the daemon API). */
  registryClient: SolverNetRegistryClient;
  /** Outcomes of the recovery scans. Useful for test assertions and logging. */
  recovery: {
    inFlightLaunches: { resumed: number; failed: Array<{ solverNetId: string; error: Error }> };
    inFlightLifecycle: { resumed: number; failed: Array<{ solverNetId: string; error: Error }> };
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
 * state machine signs re-broadcasts on resume). Lifecycle resume takes
 * a single `signer` directly — production passes the same signer for
 * both, since one daemon owns one launcher.
 */
export interface InitSolverNetSubsystemDeps {
  store: SolverNetStore;
  ipfs: IpfsClient;
  publisher: MetadataPublisher;
  subgraph: SubgraphClient;
  registryClient: SolverNetRegistryClient;
  network: 'base-sepolia' | 'base';
  resolveSigner: ResolveSigner;
  /**
   * Single signer used by the lifecycle-resume scan. Production owns one
   * launcher per daemon; multi-launcher recovery is out of scope.
   */
  lifecycleSigner: LifecycleTransitionDeps['signer'];
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
 * `recovery.inFlightLaunches.failed` / `recovery.inFlightLifecycle.failed`
 * so a single broken record cannot block daemon startup. Errors during
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
    subgraph: deps.subgraph,
    awaitTxConfirmation: deps.awaitTxConfirmation,
    resolveSigner: deps.resolveSigner,
    // The launch-recovery path needs a generator spawner. Task 11 leaves
    // it as a no-op — Task 12 wires the real spawner. Recovery only fires
    // it on a record that crashed mid-spawn-phase; in that case advancing
    // to `status: 'launched'` without an active generator is the
    // recoverable state, and Task 12's startup code will spawn it from
    // the `pendingGenerators` list below.
    spawnGenerator: async () => undefined,
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

  // Step 2 — resume in-flight lifecycle transitions.
  const inFlightLifecycle = await recoverInFlightLifecycleTransitions({
    store: deps.store,
    registry: deps.registryClient,
    signer: deps.lifecycleSigner,
    subgraph: deps.subgraph,
    awaitTxConfirmation: deps.awaitTxConfirmation,
    // Task 12 will wire real start/stop generator callbacks (the
    // counterparts to the launch spawner above). Until then, lifecycle
    // resume only flips on-disk status — Task 12's per-record generator
    // construction runs after this return.
    startGenerator: async () => undefined,
    stopGenerator: async () => undefined,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  if (inFlightLifecycle.failed.length > 0) {
    logger.warn(
      `[solvernet] lifecycle recovery: ${inFlightLifecycle.resumed} resumed, ` +
        `${inFlightLifecycle.failed.length} failed`,
    );
  } else if (inFlightLifecycle.resumed > 0) {
    logger.info(`[solvernet] lifecycle recovery: ${inFlightLifecycle.resumed} resumed`);
  }

  // Step 3 — load post-recovery records and split into the spawn-ready set.
  // Each spawn-ready entry carries a `recordRef` and a `configRef` that the
  // generator factory (`makePredictionV1GeneratorForLaunchedRecord`) closes
  // over. Lifecycle transitions and the SolverNet config API endpoint mutate
  // these refs at runtime so the per-tick gate and runtime config update
  // within one cadence — no daemon restart. Defaults for the runtime config
  // are an empty object: the generator falls back to its built-in defaults
  // until the operator edits cadence / allowlist / caps via Task 14.
  const records = await deps.store.loadOwnedRecords();
  const pendingGenerators: PendingGeneratorSpawn[] = records
    .filter((r) => r.status === 'launched' && r.generatorEnabled)
    .map((record) => ({
      record,
      recordRef: { current: record },
      // Seed configRef from the record's persisted generatorConfig if present
      // (set by Task 14's `PATCH /v1/solvernets/launched/:id/generator-config`
      // endpoint), otherwise use an empty config so the generator falls back
      // to its built-in defaults.
      configRef: {
        current: ((record.generatorConfig ?? {}) as PredictionV1GeneratorRuntimeConfig),
      },
    }));
  logger.info(
    `[solvernet] loaded ${records.length} owned record(s); ` +
      `${pendingGenerators.length} ready for generator spawn`,
  );

  // Step 4 — start the catalog refresher.
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
      inFlightLifecycle,
    },
    stop() {
      catalog.stop();
    },
  };
}

// ── Catalog cache ───────────────────────────────────────────────────────────

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
  let lastError: { message: string; at: Date } | null = null;
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
      lastError = { message, at: now() };
      config.logger.warn(`[solvernet] catalog refresh failed: ${message}`);
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
 * Day-1 stub `SubgraphClient` returning empty arrays for both queries. The
 * real subgraph extension lands in Task 25; until then the launch state
 * machine and registry catalog still function (recovery only consults
 * the subgraph on mempool-drop, which is rare; catalog refresh produces an
 * empty list, which the SPA renders as "no SolverNets launched yet" — a
 * truthful zero state until Task 25 indexes the events).
 *
 * Exported so tests can pin a deterministic baseline.
 */
export function createNoopSubgraphClient(): SubgraphClient {
  return {
    async fetchSetMetadataEvents() {
      return [];
    },
    async fetchSetMetadataEventsForCid() {
      return [];
    },
  };
}

/**
 * jinn-mono-{follow-up}: real subgraph adapter that queries the deployed
 * Jinn subgraph (e.g. https://api.studio.thegraph.com/query/.../jinn-testnet/...)
 * for `SolverNetManifestEvent` rows and JCS-decodes each event's payload
 * bytes into the typed lifecycle payload. Replaces `createNoopSubgraphClient`
 * for any daemon that reads `JINN_SUBGRAPH_URL`.
 *
 * The schema only stores `solvernet-manifest:<cid>` events (lifecycle and
 * launch share the prefix). `keyPrefix` is therefore an effective filter:
 * the entity itself encodes that constraint, so we do not pass it to the
 * GraphQL query. Callers passing a different prefix get an empty list.
 */
export function createGraphqlSubgraphClient(args: { url: string }): SubgraphClient {
  const url = args.url;

  async function runQuery(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<{ solverNetManifestEvents: Array<Record<string, unknown>> }> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
      throw new Error(`subgraph query failed: ${response.status} ${response.statusText}`);
    }
    const json = (await response.json()) as {
      data?: { solverNetManifestEvents?: Array<Record<string, unknown>> };
      errors?: Array<{ message: string }>;
    };
    if (json.errors && json.errors.length > 0) {
      throw new Error(
        `subgraph errors: ${json.errors.map((e) => e.message).join('; ')}`,
      );
    }
    return {
      solverNetManifestEvents: json.data?.solverNetManifestEvents ?? [],
    };
  }

  function decodePayload(rowPayloadHex: string): SetMetadataLifecyclePayload {
    const bytes = hexToBytes(rowPayloadHex);
    const json = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(json) as SetMetadataLifecyclePayload;
    return parsed;
  }

  function rowToEvent(row: Record<string, unknown>): SetMetadataEvent {
    return {
      agentId: String(row.agentId),
      key: String(row.metadataKey),
      payload: decodePayload(String(row.payload)),
      blockNumber: Number(row.blockNumber),
      transactionIndex: Number(row.transactionIndex ?? 0),
    };
  }

  return {
    async fetchSetMetadataEvents(opts) {
      if (opts.keyPrefix !== 'solvernet-manifest:') {
        // The schema entity is hardcoded to this prefix; any other prefix
        // would yield zero rows. Keep behaviour consistent with the noop.
        return [];
      }
      const sinceBlock = typeof opts.sinceBlock === 'number' ? opts.sinceBlock : 0;
      const query = `
        query MetadataEventsSince($sinceBlock: BigInt!) {
          solverNetManifestEvents(
            where: { blockNumber_gte: $sinceBlock }
            orderBy: blockNumber
            orderDirection: asc
            first: 1000
          ) {
            agentId
            metadataKey
            payload
            blockNumber
            transactionIndex
          }
        }
      `;
      const { solverNetManifestEvents } = await runQuery(query, {
        sinceBlock: String(sinceBlock),
      });
      return solverNetManifestEvents.map(rowToEvent);
    },

    async fetchSetMetadataEventsForCid(opts) {
      const query = `
        query MetadataEventsForCid($manifestCid: String!) {
          solverNetManifestEvents(
            where: { manifestCid: $manifestCid }
            orderBy: blockNumber
            orderDirection: asc
            first: 1000
          ) {
            agentId
            metadataKey
            payload
            blockNumber
            transactionIndex
          }
        }
      `;
      const { solverNetManifestEvents } = await runQuery(query, {
        manifestCid: opts.manifestCid,
      });
      return solverNetManifestEvents.map(rowToEvent);
    },
  };
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error(`invalid hex payload length: ${clean.length}`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
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
      const txHash = await args.walletClient.writeContract({
        address: args.identityRegistryAddress,
        abi: IDENTITY_REGISTRY_SET_METADATA_ABI,
        functionName: 'setMetadata',
        // viem's bytes input accepts `0x`-prefixed hex; convert from Uint8Array.
        args: [BigInt(agentId), key, uint8ArrayToHex(value)],
        account,
        chain,
      });
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
  subgraph: SubgraphClient;
  network: 'base-sepolia' | 'base';
}): SolverNetRegistryClient {
  return new IdentityRegistryBackedSolverNetRegistryClient({
    ipfs: args.ipfs,
    publisher: args.publisher,
    subgraph: args.subgraph,
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
