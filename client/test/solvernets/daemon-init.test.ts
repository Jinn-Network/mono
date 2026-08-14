/**
 * Tests for the daemon-init scaffolding (Task 11).
 *
 * Spec: `spec/2026-05-05-solvernet-creation-and-launch.md` Task 11.
 *
 * Three things to assert:
 *
 *   1. Mocked store with a launched + paused record → `pendingGenerators`
 *      contains both; paused records are wired and gated per tick.
 *   2. Mocked store with a record in `status: 'launching'` →
 *      `recoverInFlightLaunches` is exercised; the record advances to
 *      `launched` and shows up in `pendingGenerators`.
 *   3. Mocked registry returning two summaries → catalog cache exposes both.
 *
 * Tests use a tmpdir-backed real `SolverNetStore` and hand-rolled mocks
 * for ipfs / publisher / subgraph / registryClient. The full daemon is
 * not started — Task 11's scope is the scaffolding extraction.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';

import {
  initSolverNetSubsystem,
  type InitSolverNetSubsystemDeps,
  DEFAULT_CATALOG_REFRESH_INTERVAL_MS,
} from '../../src/solvernets/daemon-init.js';
import {
  createSolverNetStore,
  type LaunchedSolverNetRecord,
  type SolverNetStore,
} from '../../src/solvernets/store.js';
import type {
  SolverNetManifestSummary,
  SolverNetRegistryClient,
  SignerWithAgentEoa,
} from '../../src/solvernets/registry-client.js';
import type {
  IpfsClient,
  MetadataPublisher,
  SetMetadataPublishResult,
} from '../../src/solvernets/registry-client-erc8004.js';
import { DiscoveryUnavailableError } from '../../src/discovery/types.js';

// ── Helpers ────────────────────────────────────────────────────────────────

const FIXED_NOW = new Date('2026-05-06T12:00:00.000Z');

const SAMPLE_LAUNCHER_AGENT_ID = '5474';
const SAMPLE_LAUNCHER_SAFE = '0x1111111111111111111111111111111111111111' as `0x${string}`;
const SAMPLE_AGENT_EOA = '0x2222222222222222222222222222222222222222' as `0x${string}`;
const SAMPLE_PK = ('0x' + '11'.repeat(32)) as `0x${string}`;

function buildLaunchedRecord(args: {
  solverNetId: string;
  status?: LaunchedSolverNetRecord['status'];
  generatorEnabled?: boolean;
  manifestCid?: string;
  inFlightLaunch?: boolean;
  inFlightLifecycleTarget?: 'launched' | 'paused' | 'retired';
}): LaunchedSolverNetRecord {
  const cid = args.manifestCid ?? `bafy-${args.solverNetId}`;
  const record: LaunchedSolverNetRecord = {
    schemaVersion: 'solvernet.launched.v1',
    solverNetId: args.solverNetId,
    manifestCid: cid,
    manifestHash: ('0x' + 'aa'.repeat(32)) as `0x${string}`,
    launcherAgentId: SAMPLE_LAUNCHER_AGENT_ID,
    launcherSafeAddress: SAMPLE_LAUNCHER_SAFE,
    launchedAt: FIXED_NOW.toISOString(),
    status: args.status ?? 'launched',
    statusUpdatedAt: FIXED_NOW.toISOString(),
    generatorEnabled: args.generatorEnabled ?? true,
    registry: {
      metadataTxHash: ('0x' + 'bb'.repeat(32)) as `0x${string}`,
      metadataBlockNumber: 100,
    },
  };
  if (args.inFlightLaunch) {
    return {
      ...record,
      // For an in-flight launch, set status to 'launching' and stash a
      // spawning-phase progress so resume only has to fire the spawn
      // (the test mocks make this a no-op).
      status: 'launching',
      launchProgress: { phase: 'spawning', attemptCount: 0 },
    };
  }
  if (args.inFlightLifecycleTarget) {
    return {
      ...record,
      lifecycleProgress: {
        phase: 'broadcasting',
        target: args.inFlightLifecycleTarget,
        attemptCount: 0,
      },
    };
  }
  return record;
}

interface MockRegistryClient extends SolverNetRegistryClient {
  listLaunchedCalls: number;
}

function makeMockRegistryClient(args: {
  summaries: SolverNetManifestSummary[];
  failNextList?: Error;
} = { summaries: [] }): MockRegistryClient {
  let listLaunchedCalls = 0;
  let failNextList = args.failNextList ?? null;
  const client: MockRegistryClient = {
    get listLaunchedCalls() { return listLaunchedCalls; },
    async listLaunched() {
      listLaunchedCalls += 1;
      if (failNextList) {
        const err = failNextList;
        failNextList = null;
        throw err;
      }
      return args.summaries;
    },
    async publishManifest() {
      throw new Error('publishManifest not used in init tests');
    },
    async publishLifecycleTransition() {
      return {
        metadataTxHash: ('0x' + 'cc'.repeat(32)) as `0x${string}`,
        metadataBlockNumber: 200,
      };
    },
    async getManifest() {
      throw new Error('getManifest not used in init tests');
    },
    async getManifestFromCache() {
      return null;
    },
    async getLifecycleStatus() {
      return {
        status: 'launched' as const,
        statusUpdatedAt: FIXED_NOW.toISOString(),
        sourceBlock: 100,
      };
    },
  };
  return client;
}

interface MockPublisher extends MetadataPublisher {
  calls: number;
}

function makeMockPublisher(): MockPublisher {
  let calls = 0;
  const publisher: MockPublisher = {
    get calls() { return calls; },
    async setMetadata(): Promise<SetMetadataPublishResult> {
      calls += 1;
      return {
        txHash: ('0x' + 'dd'.repeat(32)) as `0x${string}`,
        blockNumber: 300,
      };
    },
  };
  return publisher;
}

function makeMockIpfs(): IpfsClient {
  return {
    async upload() {
      return 'bafy-test-upload';
    },
    async fetch() {
      throw new Error('IPFS mock: fetch not used in init tests');
    },
  };
}

function makeSampleSummary(id: string): SolverNetManifestSummary {
  return {
    manifestCid: `bafy-${id}`,
    solverNetId: id,
    name: `SolverNet ${id}`,
    network: 'base-sepolia',
    launcherAgentId: SAMPLE_LAUNCHER_AGENT_ID,
    launcherSafeAddress: SAMPLE_LAUNCHER_SAFE,
    status: 'launched',
    statusUpdatedAt: FIXED_NOW.toISOString(),
    contractId: 'prediction',
    contractVersion: 'v1',
    solutionPriceWei: '1000000000000000',
    verdictPriceWei: '500000000000000',
    openRoles: ['solver', 'evaluator'],
    anchorBlock: 100,
  };
}

// ── Setup ──────────────────────────────────────────────────────────────────

let baseDir: string;
let store: SolverNetStore;
let ipfs: IpfsClient;
let publisher: MockPublisher;

function buildDeps(overrides: Partial<InitSolverNetSubsystemDeps> = {}): InitSolverNetSubsystemDeps {
  const signer: SignerWithAgentEoa = {
    agentEoaAddress: SAMPLE_AGENT_EOA,
    agentEoaPrivateKey: SAMPLE_PK,
    agentId: SAMPLE_LAUNCHER_AGENT_ID,
  };
  return {
    store,
    ipfs,
    publisher,
    registryClient: makeMockRegistryClient({ summaries: [] }),
    network: 'base-sepolia',
    resolveSigner: async () => signer,
    lifecycleSigner: signer,
    awaitTxConfirmation: async () => ({ blockNumber: 999 }),
    disableCatalogAutoRefresh: true,
    now: () => FIXED_NOW,
    ...overrides,
  };
}

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(os.tmpdir(), 'solvernet-init-'));
  store = createSolverNetStore({ baseDir });
  ipfs = makeMockIpfs();
  publisher = makeMockPublisher();
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('initSolverNetSubsystem — record loading + filtering', () => {
  it('returns launched/paused + generatorEnabled records in pendingGenerators', async () => {
    // 1 launched (eligible), 1 paused (wired but per-tick gated), 1 launched-but-disabled (ineligible),
    // 1 retired (ineligible).
    await store.writeRecord(buildLaunchedRecord({
      solverNetId: 'net-launched-enabled',
      status: 'launched',
      generatorEnabled: true,
    }));
    await store.writeRecord(buildLaunchedRecord({
      solverNetId: 'net-paused',
      status: 'paused',
      generatorEnabled: true,
    }));
    await store.writeRecord(buildLaunchedRecord({
      solverNetId: 'net-launched-disabled',
      status: 'launched',
      generatorEnabled: false,
    }));
    await store.writeRecord(buildLaunchedRecord({
      solverNetId: 'net-retired',
      status: 'retired',
      generatorEnabled: true,
    }));

      const subsystem = await initSolverNetSubsystem(buildDeps());
    try {
      expect(subsystem.records).toHaveLength(4);
      expect(subsystem.pendingGenerators).toHaveLength(2);
      expect(subsystem.pendingGenerators[0]?.record.solverNetId).toBe('net-launched-enabled');
      expect(subsystem.pendingGenerators[1]?.record.solverNetId).toBe('net-paused');
      // Refs are populated and seeded with sensible defaults so the
      // generator factory and Task 14's API endpoint share a single source
      // of truth.
      expect(subsystem.pendingGenerators[0]?.recordRef.current.solverNetId).toBe('net-launched-enabled');
      expect(subsystem.pendingGenerators[0]?.configRef.current).toEqual({});
    } finally {
      subsystem.stop();
    }
  });

  it('returns empty pendingGenerators when no records exist', async () => {
    const subsystem = await initSolverNetSubsystem(buildDeps());
    try {
      expect(subsystem.records).toHaveLength(0);
      expect(subsystem.pendingGenerators).toHaveLength(0);
      expect(subsystem.recovery.inFlightLaunches.resumed).toBe(0);
    } finally {
      subsystem.stop();
    }
  });
});
describe('initSolverNetSubsystem — in-flight recovery', () => {
  it('resumes a record stuck in status: launching via recoverInFlightLaunches', async () => {
    // Record at the spawning checkpoint — recovery only needs to fire the
    // (no-op) spawnGenerator and finalize status.
    await store.writeRecord(buildLaunchedRecord({
      solverNetId: 'net-resuming',
      inFlightLaunch: true,
    }));

    const subsystem = await initSolverNetSubsystem(buildDeps());
    try {
      expect(subsystem.recovery.inFlightLaunches.resumed).toBe(1);
      expect(subsystem.recovery.inFlightLaunches.failed).toHaveLength(0);

      // After recovery the record is on disk with status=launched.
      const finalRec = await store.loadRecord('net-resuming');
      expect(finalRec?.status).toBe('launched');
      expect(finalRec?.launchProgress).toBeUndefined();

      // And it shows up in pendingGenerators (Task 12 will spawn it).
      expect(subsystem.pendingGenerators).toHaveLength(1);
      expect(subsystem.pendingGenerators[0]?.record.solverNetId).toBe('net-resuming');
    } finally {
      subsystem.stop();
    }
  });

  it('does not crash on a corrupted in-flight launch — captures error per record', async () => {
    // A record stuck at broadcasting will need to publish via the
    // MetadataPublisher (no-op subgraph short-circuit doesn't fire); we
    // make the publisher throw so the recovery captures the failure.
    await store.writeRecord({
      ...buildLaunchedRecord({ solverNetId: 'net-broken' }),
      status: 'launching',
      launchProgress: { phase: 'broadcasting', attemptCount: 0 },
    });

    const failingPublisher: MetadataPublisher = {
      async setMetadata() {
        throw new Error('publisher boom');
      },
    };
    const subsystem = await initSolverNetSubsystem(buildDeps({
      publisher: failingPublisher,
    }));
    try {
      // Subsystem still initialised — single broken record cannot block startup.
      expect(subsystem.recovery.inFlightLaunches.failed).toHaveLength(1);
      expect(subsystem.recovery.inFlightLaunches.failed[0]?.solverNetId).toBe('net-broken');
      expect(subsystem.recovery.inFlightLaunches.failed[0]?.error.message).toContain('publisher boom');
    } finally {
      subsystem.stop();
    }
  });
});

describe('initSolverNetSubsystem — catalog cache', () => {
  it('initial refresh populates the cache with registry summaries', async () => {
    const summaries = [makeSampleSummary('cat-1'), makeSampleSummary('cat-2')];
    const registryClient = makeMockRegistryClient({ summaries });

    const subsystem = await initSolverNetSubsystem(buildDeps({ registryClient }));
    try {
      // The constructor kicks off a fire-and-forget refresh; await one tick
      // of the microtask queue so the unawaited refresh resolves before we
      // read.
      await Promise.resolve();
      await Promise.resolve();

      expect(subsystem.catalog.getCatalog()).toHaveLength(2);
      expect(subsystem.catalog.getCatalog()[0]?.solverNetId).toBe('cat-1');
      expect(subsystem.catalog.getCatalog()[1]?.solverNetId).toBe('cat-2');
      expect(subsystem.catalog.lastRefreshedAt()?.toISOString()).toBe(FIXED_NOW.toISOString());
      expect(subsystem.catalog.lastError()).toBeNull();
      expect(registryClient.listLaunchedCalls).toBe(1);
    } finally {
      subsystem.stop();
    }
  });

  it('records refresh errors without crashing', async () => {
    const registryClient = makeMockRegistryClient({
      summaries: [],
      failNextList: new Error('subgraph 503'),
    });

    const subsystem = await initSolverNetSubsystem(buildDeps({ registryClient }));
    try {
      await Promise.resolve();
      await Promise.resolve();

      expect(subsystem.catalog.getCatalog()).toEqual([]);
      expect(subsystem.catalog.lastError()?.message).toContain('subgraph 503');
      // A generic failure carries no typed code.
      expect(subsystem.catalog.lastError()?.code).toBeUndefined();
      expect(subsystem.catalog.lastRefreshedAt()).toBeNull();
    } finally {
      subsystem.stop();
    }
  });

  it('propagates an rpc_rate_limited code from a throttled RPC', async () => {
    // jinn-mono #325: when the registry refresh fails because the RPC is
    // rate-limited, the catalog cache must surface the typed code so the
    // operator UI can render an actionable message instead of "stale".
    const registryClient = makeMockRegistryClient({
      summaries: [],
      failNextList: new DiscoveryUnavailableError(
        'OnchainDiscoveryAPI: getLogs for MetadataSet failed',
        new Error('429 Too Many Requests'),
        'rpc_rate_limited',
      ),
    });

    const subsystem = await initSolverNetSubsystem(buildDeps({ registryClient }));
    try {
      await Promise.resolve();
      await Promise.resolve();

      expect(subsystem.catalog.lastError()?.code).toBe('rpc_rate_limited');
    } finally {
      subsystem.stop();
    }
  });

  it('reads rpc_rate_limited from an enrichment-layer error cause', async () => {
    // The error can arrive wrapped: the registry client's IPFS-enrichment
    // layer may surface its own Error whose `cause` is the typed
    // DiscoveryUnavailableError. The cache must still extract the code.
    const wrapped = new Error('listLaunched failed during enrichment');
    (wrapped as { cause?: unknown }).cause = new DiscoveryUnavailableError(
      'OnchainDiscoveryAPI: getLogs for MetadataSet failed',
      undefined,
      'rpc_rate_limited',
    );
    const registryClient = makeMockRegistryClient({
      summaries: [],
      failNextList: wrapped,
    });

    const subsystem = await initSolverNetSubsystem(buildDeps({ registryClient }));
    try {
      await Promise.resolve();
      await Promise.resolve();

      expect(subsystem.catalog.lastError()?.code).toBe('rpc_rate_limited');
    } finally {
      subsystem.stop();
    }
  });

  it('manual refresh updates the cache and clears prior errors', async () => {
    const registryClient = makeMockRegistryClient({
      summaries: [makeSampleSummary('post-refresh')],
      failNextList: new Error('first call fails'),
    });

    const subsystem = await initSolverNetSubsystem(buildDeps({ registryClient }));
    try {
      // Wait for the initial (failing) fire-and-forget refresh to settle.
      await Promise.resolve();
      await Promise.resolve();
      expect(subsystem.catalog.lastError()?.message).toContain('first call fails');

      // Subsequent refresh succeeds and populates the snapshot.
      await subsystem.catalog.refresh();
      expect(subsystem.catalog.getCatalog()).toHaveLength(1);
      expect(subsystem.catalog.getCatalog()[0]?.solverNetId).toBe('post-refresh');
      expect(subsystem.catalog.lastError()).toBeNull();
    } finally {
      subsystem.stop();
    }
  });

  it('honors a custom scheduler for the refresh interval', async () => {
    type IntervalCallback = () => void;
    const intervals: Array<{ cb: IntervalCallback; ms: number }> = [];
    const cleared: unknown[] = [];
    const scheduler = {
      setInterval: (cb: () => void, ms: number) => {
        intervals.push({ cb, ms });
        return intervals.length;
      },
      clearInterval: (h: unknown) => {
        cleared.push(h);
      },
    };

    const registryClient = makeMockRegistryClient({
      summaries: [makeSampleSummary('sched-1')],
    });

    const subsystem = await initSolverNetSubsystem(buildDeps({
      registryClient,
      disableCatalogAutoRefresh: false,
      scheduler,
      catalogRefreshIntervalMs: 12345,
    }));
    try {
      expect(intervals).toHaveLength(1);
      expect(intervals[0]?.ms).toBe(12345);

      // Trigger the interval callback manually to confirm it refreshes.
      intervals[0]?.cb();
      // Allow the async refresh inside the cb to land.
      await Promise.resolve();
      await Promise.resolve();
      expect(registryClient.listLaunchedCalls).toBeGreaterThanOrEqual(2);
    } finally {
      subsystem.stop();
    }
    expect(cleared).toHaveLength(1);
  });

  it('exposes DEFAULT_CATALOG_REFRESH_INTERVAL_MS as a stable constant', () => {
    // Pin the default so a refactor doesn't accidentally change it without
    // updating the catalog-refresh budget docs.
    expect(DEFAULT_CATALOG_REFRESH_INTERVAL_MS).toBe(30_000);
  });
});

describe('initSolverNetSubsystem — stop()', () => {
  it('cancels the catalog refresher (idempotent)', async () => {
    const cleared: unknown[] = [];
    const scheduler = {
      setInterval: () => 'handle-1',
      clearInterval: (h: unknown) => {
        cleared.push(h);
      },
    };
    const subsystem = await initSolverNetSubsystem(buildDeps({
      disableCatalogAutoRefresh: false,
      scheduler,
    }));
    subsystem.stop();
    subsystem.stop(); // idempotent — only one clear
    expect(cleared).toEqual(['handle-1']);
  });
});
