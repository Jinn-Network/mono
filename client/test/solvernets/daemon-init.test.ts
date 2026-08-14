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
 * Wave-4 D4 retired the ERC-8004 registry client and catalog refresher.
 *
 * Tests use a tmpdir-backed real `SolverNetStore` and hand-rolled mocks
 * for ipfs / publisher. The full daemon is not started — Task 11's scope
 * is the scaffolding extraction.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';

import {
  initSolverNetSubsystem,
  type InitSolverNetSubsystemDeps,
} from '../../src/solvernets/daemon-init.js';
import {
  createSolverNetStore,
  type LaunchedSolverNetRecord,
  type SolverNetStore,
} from '../../src/solvernets/store.js';
import type {
  IpfsClient,
  MetadataPublisher,
  SetMetadataPublishResult,
  SignerWithAgentEoa,
} from '../../src/solvernets/launch-publisher.js';

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
    resolveSigner: async () => signer,
    awaitTxConfirmation: async () => ({ blockNumber: 999 }),
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

describe('initSolverNetSubsystem — stop()', () => {
  it('is idempotent after catalog refresher retirement', async () => {
    const subsystem = await initSolverNetSubsystem(buildDeps());
    subsystem.stop();
    subsystem.stop();
    expect(subsystem.records).toEqual([]);
  });
});
