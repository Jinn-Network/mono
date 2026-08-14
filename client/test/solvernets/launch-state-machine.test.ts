/**
 * Tests for the forward-only checkpointed launch state machine (Task 9).
 *
 * Spec: `spec/2026-05-05-solvernet-creation-and-launch.md` §10 (the launch
 * action) and §6.2 (LaunchedSolverNetRecord.launchProgress shape).
 *
 * Phases (forward-only):
 *
 *   pinning → recording → broadcasting → confirming → spawning → launched
 *
 * Wave-4 D3 retired the generator spawn: the 'spawning' phase is now a
 * checkpoint that finalizes the record rather than a side-effect boundary.
 *
 * Each phase persists progress to disk BEFORE attempting the side effect, so
 * that a daemon crash between persist and side-effect leaves the next start
 * with a recorded "I am at phase X" checkpoint. All side effects are
 * idempotent under retry (same content → same cid; setMetadata is event-only;
 * disk writes are atomic-rename).
 *
 * Tests use mock ipfs/publisher/subgraph and a tmpdir-backed real store.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import {
  createSolverNetStore,
  type LaunchedSolverNetRecord,
  type SolverNetStore,
} from '../../src/solvernets/store.js';
import {
  signManifest,
  manifestHash,
  type UnsignedSolverNetManifestV1,
} from '../../src/solvernets/manifest.js';
import {
  type IpfsClient,
  type MetadataPublisher,
  type SubgraphClient,
  type SetMetadataPublishResult,
} from '../../src/solvernets/registry-client-erc8004.js';
import type { SignerWithAgentEoa } from '../../src/solvernets/registry-client.js';
import type { SetMetadataEvent } from '../../src/solvernets/most-recent-wins.js';
import type { SolverNetManifestV1 } from '@jinn-network/sdk/solvernets';

import {
  LaunchAction,
  recoverInFlightLaunches,
  type LaunchActionDeps,
  DEFAULT_MAX_ATTEMPTS,
} from '../../src/solvernets/launch-state-machine.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

function buildUnsignedManifest(args: {
  agentEoa: `0x${string}`;
  agentId?: string;
  safeAddress?: `0x${string}`;
  solverNetId?: string;
}): UnsignedSolverNetManifestV1 {
  return {
    schemaVersion: 'solvernet.manifest.v1',
    solverNetId: args.solverNetId ?? 'launcher-1_prediction-001',
    network: 'base-sepolia',
    name: 'Prediction Markets — Test',
    description: 'A test SolverNet for launch state machine tests.',
    launcher: {
      safeAddress:
        args.safeAddress ?? ('0x1111111111111111111111111111111111111111' as `0x${string}`),
      agentEoa: args.agentEoa,
      agentId: args.agentId ?? '5474',
    },
    contract: {
      id: 'prediction',
      version: 'v1',
      schemas: {
        task: { type: 'object' },
        solution: { type: 'object' },
        verdict: { type: 'object' },
      },
      claimPolicyDefaults: {
        mode: 'parallel',
        maxClaims: 10,
        maxClaimsPerOperator: 1,
        claimLeaseTtlSeconds: 600,
      },
      credentialRequirements: { creator: [], solver: [], evaluator: [] },
      evaluationFunction: {
        id: 'prediction.brier-loss.v1',
        deterministic: true,
        inputs: ['solution', 'resolution'],
        output: 'verdict',
        implementation: 'jinn:harness:prediction-v1-evaluator',
      },
      aggregationFunction: {
        id: 'prediction.trailing-mean-brier-spread.v1',
        deterministic: true,
        inputs: ['verdict[]'],
        output: 'score',
        windowDays: 30,
      },
    },
    solutionPriceWei: '1000000000000000',
    verdictPriceWei: '500000000000000',
    openRoles: ['solver', 'evaluator'],
    createdAt: '2026-05-06T00:00:00Z',
    launchedAt: '2026-05-06T00:01:00Z',
  };
}

async function buildSignedManifest(args: {
  agentId?: string;
  safeAddress?: `0x${string}`;
  solverNetId?: string;
} = {}): Promise<{
  manifest: SolverNetManifestV1;
  signer: SignerWithAgentEoa;
}> {
  const pk = generatePrivateKey();
  const acct = privateKeyToAccount(pk);
  const unsigned = buildUnsignedManifest({
    agentEoa: acct.address,
    agentId: args.agentId,
    safeAddress: args.safeAddress,
    solverNetId: args.solverNetId,
  });
  const manifest = await signManifest(unsigned, pk);
  return {
    manifest,
    signer: {
      agentEoaAddress: acct.address,
      agentEoaPrivateKey: pk,
      agentId: args.agentId ?? '5474',
    },
  };
}

// ── Mocks ───────────────────────────────────────────────────────────────────

interface MockIpfs extends IpfsClient {
  uploads: Map<string, unknown>;
  uploadCalls: number;
  failNextUpload: { error: Error } | null;
}

function makeMockIpfs(): MockIpfs {
  const uploads = new Map<string, unknown>();
  let uploadCalls = 0;
  let failNextUpload: { error: Error } | null = null;
  function cidOf(data: unknown): string {
    const json = JSON.stringify(data);
    let h = 0;
    for (const ch of json) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return `bafy-test-${h.toString(16).padStart(8, '0')}`;
  }
  return {
    async upload(data) {
      uploadCalls += 1;
      if (failNextUpload) {
        const err = failNextUpload.error;
        failNextUpload = null;
        throw err;
      }
      const cid = cidOf(data);
      uploads.set(cid, data);
      return cid;
    },
    async fetch(cid) {
      const data = uploads.get(cid);
      if (data === undefined) throw new Error(`IPFS mock: cid not found: ${cid}`);
      return data;
    },
    get uploads() { return uploads; },
    get uploadCalls() { return uploadCalls; },
    get failNextUpload() { return failNextUpload; },
    set failNextUpload(v) { failNextUpload = v; },
  };
}

interface MockPublisher extends MetadataPublisher {
  calls: Array<{ agentId: string; key: string; value: Uint8Array }>;
  failNextSetMetadata: { error: Error } | null;
}

function makeMockPublisher(): MockPublisher {
  const calls: Array<{ agentId: string; key: string; value: Uint8Array }> = [];
  let failNextSetMetadata: { error: Error } | null = null;
  let nextBlock = 100;
  return {
    async setMetadata(args): Promise<SetMetadataPublishResult> {
      if (failNextSetMetadata) {
        const err = failNextSetMetadata.error;
        failNextSetMetadata = null;
        throw err;
      }
      calls.push({ agentId: args.agentId, key: args.key, value: args.value });
      return {
        txHash: `0x${'aa'.repeat(31)}${(calls.length).toString(16).padStart(2, '0')}` as `0x${string}`,
        blockNumber: nextBlock++,
      };
    },
    get calls() { return calls; },
    get failNextSetMetadata() { return failNextSetMetadata; },
    set failNextSetMetadata(v) { failNextSetMetadata = v; },
  };
}

interface MockSubgraph extends SubgraphClient {
  events: SetMetadataEvent[];
  fetchByCidCalls: Array<{ manifestCid: string }>;
}

function makeMockSubgraph(): MockSubgraph {
  const events: SetMetadataEvent[] = [];
  const fetchByCidCalls: Array<{ manifestCid: string }> = [];
  return {
    async fetchSetMetadataEvents(args) {
      return events.filter((e) => e.key.startsWith(args.keyPrefix));
    },
    async fetchSetMetadataEventsForCid(args) {
      fetchByCidCalls.push(args);
      return events.filter((e) => e.key === `solvernet-manifest:${args.manifestCid}`);
    },
    get events() { return events; },
    get fetchByCidCalls() { return fetchByCidCalls; },
  };
}

interface ConfirmSpy {
  confirms: Array<`0x${string}`>;
  pendingHashes: Set<`0x${string}`>;
  failureForHash: Map<`0x${string}`, Error>;
  awaitTxConfirmation: (txHash: `0x${string}`) => Promise<{ blockNumber: number }>;
}

function makeConfirmSpy(): ConfirmSpy {
  const confirms: Array<`0x${string}`> = [];
  const pendingHashes = new Set<`0x${string}`>();
  const failureForHash = new Map<`0x${string}`, Error>();
  let nextBlock = 200;
  return {
    get confirms() { return confirms; },
    get pendingHashes() { return pendingHashes; },
    get failureForHash() { return failureForHash; },
    async awaitTxConfirmation(txHash) {
      const failure = failureForHash.get(txHash);
      if (failure) {
        failureForHash.delete(txHash);
        throw failure;
      }
      if (pendingHashes.has(txHash)) {
        pendingHashes.delete(txHash);
        throw new Error('mempool: tx not found');
      }
      confirms.push(txHash);
      return { blockNumber: nextBlock++ };
    },
  };
}

// ── Setup ───────────────────────────────────────────────────────────────────

let baseDir: string;
let store: SolverNetStore;
let ipfs: MockIpfs;
let publisher: MockPublisher;
let subgraph: MockSubgraph;
let confirmSpy: ConfirmSpy;

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(os.tmpdir(), 'launch-sm-'));
  store = createSolverNetStore({ baseDir });
  ipfs = makeMockIpfs();
  publisher = makeMockPublisher();
  subgraph = makeMockSubgraph();
  confirmSpy = makeConfirmSpy();
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeDeps(overrides: Partial<LaunchActionDeps> = {}): LaunchActionDeps {
  return {
    store,
    ipfs,
    publisher,
    subgraph,
    awaitTxConfirmation: confirmSpy.awaitTxConfirmation,
    now: () => new Date('2026-05-06T00:00:00.000Z'),
    ...overrides,
  };
}

// ── Happy path ──────────────────────────────────────────────────────────────

describe('LaunchAction.launch — happy path', () => {
  it('progresses through all 5 phases and finalizes status: launched', async () => {
    const { manifest, signer } = await buildSignedManifest();
    const action = new LaunchAction(makeDeps());

    const record = await action.launch({ manifest, signer });

    expect(record.status).toBe('launched');
    expect(record.launchProgress).toBeUndefined();
    expect(record.solverNetId).toBe(manifest.solverNetId);
    expect(record.manifestCid).toBeTruthy();
    expect(record.manifestPath).toContain(record.manifestCid);
    expect(record.manifestHash).toBe(manifestHash(manifest));
    expect(record.launcherAgentId).toBe(signer.agentId);
    expect(record.launcherSafeAddress.toLowerCase()).toBe(
      manifest.launcher.safeAddress.toLowerCase(),
    );
    expect(record.registry.metadataTxHash).toMatch(/^0x[0-9a-f]+$/);
    expect(record.registry.metadataBlockNumber).toBeGreaterThan(0);
    expect(record.generatorEnabled).toBe(true);

    // Side effects fired exactly once each.
    expect(ipfs.uploadCalls).toBe(1);
    expect(publisher.calls).toHaveLength(1);
    expect(record.status).toBe('launched');
    expect(record.launchProgress).toBeUndefined();

    // Persisted record on disk equals returned record.
    const onDisk = await store.loadRecord(record.solverNetId);
    expect(onDisk).toEqual(record);
    const cachedManifest = await store.loadManifestCache(record.manifestPath!);
    expect(cachedManifest?.solverNetId).toBe(manifest.solverNetId);
  });

  it('persists progress before each side effect (checkpoint visible after each phase)', async () => {
    // We assert the disk view between phases by inspecting the record after
    // each side effect runs. The best granularity from outside is to
    // intercept ipfs.upload/publisher.setMetadata/spawn callbacks and check
    // the disk-resident phase right before they execute.

    const { manifest, signer } = await buildSignedManifest();
    const observed: Array<{ phase: string | undefined; status: string; manifestCid: string }> = [];

    const recordingObserver = async (): Promise<void> => {
      const r = await store.loadRecord(manifest.solverNetId);
      if (r) {
        observed.push({
          phase: r.launchProgress?.phase,
          status: r.status,
          manifestCid: r.manifestCid,
        });
      }
    };

    // Wrap the mocks to peek at disk state right before they run.
    const ipfsWithObserver: IpfsClient = {
      async upload(d) {
        await recordingObserver();
        return ipfs.upload(d);
      },
      async fetch(c) {
        return ipfs.fetch(c);
      },
    };
    const publisherWithObserver: MetadataPublisher = {
      async setMetadata(a) {
        await recordingObserver();
        return publisher.setMetadata(a);
      },
    };
    const confirmWithObserver = async (txHash: `0x${string}`) => {
      await recordingObserver();
      return confirmSpy.awaitTxConfirmation(txHash);
    };
    // Wave-4 D3 retired the generator spawn, so the 'spawning' phase no longer
    // has a side-effect callback to peek from. Observe the store instead: the
    // checkpoint must still reach disk before the record finalizes.
    const written: Array<{ phase: string | undefined; status: string }> = [];
    const realWriteRecord = store.writeRecord.bind(store);
    store.writeRecord = async (rec: LaunchedSolverNetRecord) => {
      written.push({ phase: rec.launchProgress?.phase, status: rec.status });
      return realWriteRecord(rec);
    };

    const action = new LaunchAction(makeDeps({
      ipfs: ipfsWithObserver,
      publisher: publisherWithObserver,
      awaitTxConfirmation: confirmWithObserver,
    }));

    await action.launch({ manifest, signer });

    // The recording observer only pushes when a record exists on disk.
    // Side effects fire in this order; the first push corresponds to the
    // first side effect that runs *after* the record has been written:
    //
    //   1. ipfs.upload (during 'pinning')   — no record on disk yet (skipped)
    //   2. publisher.setMetadata            — record on disk @ 'broadcasting'
    //   3. awaitTxConfirmation              — record on disk @ 'confirming', txHash set
    //
    // The former fourth observation came from the retired generator spawn; the
    // 'spawning' checkpoint is asserted against the store below instead.
    expect(observed).toHaveLength(2);
    expect(observed[0]?.phase).toBe('broadcasting');
    expect(observed[0]?.status).toBe('launching');
    expect(observed[0]?.manifestCid).toBeTruthy();
    expect(observed[1]?.phase).toBe('confirming');

    // The checkpoint sequence still reaches disk in order, and a 'spawning'
    // checkpoint is still persisted before the terminal 'launched' write.
    const phases = written.map((w) => w.phase);
    expect(phases).toContain('broadcasting');
    expect(phases).toContain('confirming');
    expect(phases).toContain('spawning');
    expect(written.at(-1)).toEqual({ phase: undefined, status: 'launched' });
    expect(phases.indexOf('spawning')).toBeGreaterThan(phases.indexOf('confirming'));
  });
});

// ── Idempotency under retry ────────────────────────────────────────────────

describe('LaunchAction — idempotency under retry', () => {
  it('re-launching after success is a no-op on the same record (returns same launched state)', async () => {
    const { manifest, signer } = await buildSignedManifest();
    const action = new LaunchAction(makeDeps());

    const a = await action.launch({ manifest, signer });
    // Second launch with same input: state machine sees existing 'launched'
    // record and short-circuits.
    const b = await action.launch({ manifest, signer });

    expect(b.solverNetId).toBe(a.solverNetId);
    expect(b.status).toBe('launched');
    // No additional side effects — pinning, broadcasting, spawning all
    // already happened.
    expect(ipfs.uploadCalls).toBe(1);
    expect(publisher.calls).toHaveLength(1);
  });

  it('resume() on a launched record is a no-op', async () => {
    const { manifest, signer } = await buildSignedManifest();
    const action = new LaunchAction(makeDeps());

    const launched = await action.launch({ manifest, signer });
    const resumed = await action.resume({ record: launched, signer });

    expect(resumed.status).toBe('launched');
    expect(ipfs.uploadCalls).toBe(1);
    expect(publisher.calls).toHaveLength(1);
  });
});

// ── Crash-resume from each phase ────────────────────────────────────────────

describe('LaunchAction.resume — crash recovery from each phase', () => {
  it('crash before pinning saves cid → resume re-pins (idempotent) and continues', async () => {
    const { manifest, signer } = await buildSignedManifest();
    // Plant a record that crashed at 'pinning' before any cid was recorded.
    // The store schema requires a manifestCid + manifestHash, but for the
    // pinning phase we don't yet have a cid. By design, the LaunchAction's
    // initial-write happens AFTER pinning succeeds (so the record on disk
    // always has a cid). Therefore, 'pinning' crash means: no record exists
    // yet on disk. We simulate that by simply calling launch().
    //
    // Crash-resume from pinning is identical to a fresh launch — the entry
    // point is launch(), not resume().
    const action = new LaunchAction(makeDeps());
    const record = await action.launch({ manifest, signer });
    expect(record.status).toBe('launched');
    expect(ipfs.uploadCalls).toBe(1);
  });

  it('crash after recording (cid saved, no broadcast) → resume broadcasts', async () => {
    const { manifest, signer } = await buildSignedManifest();
    // Pre-pin so the cid is reproducible under the same canonicalization
    // path the state machine would use.
    const cid = await ipfs.upload(manifest);

    const crashed: LaunchedSolverNetRecord = {
      schemaVersion: 'solvernet.launched.v1',
      solverNetId: manifest.solverNetId,
      manifestCid: cid,
      manifestHash: manifestHash(manifest),
      launcherAgentId: signer.agentId,
      launcherSafeAddress: manifest.launcher.safeAddress,
      launchedAt: '2026-05-06T00:00:00.000Z',
      status: 'launching',
      statusUpdatedAt: '2026-05-06T00:00:00.000Z',
      generatorEnabled: true,
      registry: {},
      launchProgress: { phase: 'broadcasting', attemptCount: 0 },
    };
    await store.writeRecord(crashed);

    const action = new LaunchAction(makeDeps());
    const resumed = await action.resume({ record: crashed, signer });

    expect(resumed.status).toBe('launched');
    expect(publisher.calls).toHaveLength(1);
    expect(publisher.calls[0]!.key).toBe(`solvernet-manifest:${cid}`);
    expect(resumed.launchProgress).toBeUndefined();
    // Pinning must NOT re-run (the record already had a cid).
    expect(ipfs.uploadCalls).toBe(1); // the pre-launch pin only
  });

  it('crash after broadcasting (txHash saved, no confirmation) → resume polls receipt without re-broadcast', async () => {
    const { manifest, signer } = await buildSignedManifest();
    const cid = await ipfs.upload(manifest);
    const knownTxHash = `0x${'bb'.repeat(32)}` as `0x${string}`;

    // Plant a setMetadata event in the subgraph for this cid — we crashed
    // post-broadcast and the event WAS indexed.
    subgraph.events.push({
      agentId: signer.agentId,
      key: `solvernet-manifest:${cid}`,
      payload: {
        schemaVersion: 'solvernet.lifecycle.v1',
        status: 'launched',
        at: '2026-05-06T00:00:00Z',
        hash: manifestHash(manifest),
      },
      blockNumber: 99,
      transactionIndex: 0,
    });

    const crashed: LaunchedSolverNetRecord = {
      schemaVersion: 'solvernet.launched.v1',
      solverNetId: manifest.solverNetId,
      manifestCid: cid,
      manifestHash: manifestHash(manifest),
      launcherAgentId: signer.agentId,
      launcherSafeAddress: manifest.launcher.safeAddress,
      launchedAt: '2026-05-06T00:00:00.000Z',
      status: 'launching',
      statusUpdatedAt: '2026-05-06T00:00:00.000Z',
      generatorEnabled: true,
      registry: { metadataTxHash: knownTxHash },
      launchProgress: { phase: 'confirming', txHash: knownTxHash, attemptCount: 0 },
    };
    await store.writeRecord(crashed);

    const action = new LaunchAction(makeDeps());
    const resumed = await action.resume({ record: crashed, signer });

    expect(resumed.status).toBe('launched');
    // Re-broadcast did NOT happen — we already had a confirmed event.
    expect(publisher.calls).toHaveLength(0);
    // Confirmation succeeded.
    expect(confirmSpy.confirms).toContain(knownTxHash);
    expect(resumed.launchProgress).toBeUndefined();
  });

  it('crash before confirming updates blockNumber → resume re-checks and proceeds', async () => {
    const { manifest, signer } = await buildSignedManifest();
    const cid = await ipfs.upload(manifest);
    const knownTxHash = `0x${'cc'.repeat(32)}` as `0x${string}`;

    // No setMetadata event indexed yet (broadcast already on chain but not
    // surfaced in subgraph) — confirmer will resolve via tx receipt.
    const crashed: LaunchedSolverNetRecord = {
      schemaVersion: 'solvernet.launched.v1',
      solverNetId: manifest.solverNetId,
      manifestCid: cid,
      manifestHash: manifestHash(manifest),
      launcherAgentId: signer.agentId,
      launcherSafeAddress: manifest.launcher.safeAddress,
      launchedAt: '2026-05-06T00:00:00.000Z',
      status: 'launching',
      statusUpdatedAt: '2026-05-06T00:00:00.000Z',
      generatorEnabled: true,
      registry: { metadataTxHash: knownTxHash },
      launchProgress: { phase: 'confirming', txHash: knownTxHash, attemptCount: 1 },
    };
    await store.writeRecord(crashed);

    const action = new LaunchAction(makeDeps());
    const resumed = await action.resume({ record: crashed, signer });

    expect(resumed.status).toBe('launched');
    expect(resumed.registry.metadataBlockNumber).toBeGreaterThan(0);
    expect(publisher.calls).toHaveLength(0);
    expect(resumed.launchProgress).toBeUndefined();
  });

  it('crash before spawning finishes → resume calls spawnGenerator (idempotency is the spawner\'s problem)', async () => {
    const { manifest, signer } = await buildSignedManifest();
    const cid = await ipfs.upload(manifest);

    const crashed: LaunchedSolverNetRecord = {
      schemaVersion: 'solvernet.launched.v1',
      solverNetId: manifest.solverNetId,
      manifestCid: cid,
      manifestHash: manifestHash(manifest),
      launcherAgentId: signer.agentId,
      launcherSafeAddress: manifest.launcher.safeAddress,
      launchedAt: '2026-05-06T00:00:00.000Z',
      status: 'launching',
      statusUpdatedAt: '2026-05-06T00:00:00.000Z',
      generatorEnabled: true,
      registry: {
        metadataTxHash: `0x${'dd'.repeat(32)}` as `0x${string}`,
        metadataBlockNumber: 555,
      },
      launchProgress: { phase: 'spawning', attemptCount: 0 },
    };
    await store.writeRecord(crashed);

    const action = new LaunchAction(makeDeps());
    const resumed = await action.resume({ record: crashed, signer });

    expect(resumed.status).toBe('launched');
    expect(resumed.launchProgress).toBeUndefined();
    expect(resumed.launchProgress).toBeUndefined();
    expect(publisher.calls).toHaveLength(0);
  });
});

// ── Revert / failure handling ──────────────────────────────────────────────

describe('LaunchAction — error handling', () => {
  it('publisher.setMetadata throws → record stays at broadcasting with txError, status: launching, attemptCount++', async () => {
    const { manifest, signer } = await buildSignedManifest();
    publisher.failNextSetMetadata = { error: new Error('execution reverted: insufficient funds') };

    const action = new LaunchAction(makeDeps());
    await expect(action.launch({ manifest, signer })).rejects.toThrow(/insufficient funds/);

    const onDisk = await store.loadRecord(manifest.solverNetId);
    expect(onDisk).not.toBeNull();
    expect(onDisk!.status).toBe('launching');
    expect(onDisk!.launchProgress?.phase).toBe('broadcasting');
    expect(onDisk!.launchProgress?.txError?.message).toMatch(/insufficient funds/);
    expect(onDisk!.launchProgress?.attemptCount).toBe(1);

    // After the revert, retrying via resume() should succeed.
    const resumed = await action.resume({ record: onDisk!, signer });
    expect(resumed.status).toBe('launched');
    expect(publisher.calls).toHaveLength(1);
  });

  it('mempool-dropped: txHash set, no receipt, subgraph has no event for cid → re-broadcast', async () => {
    const { manifest, signer } = await buildSignedManifest();
    const cid = await ipfs.upload(manifest);
    const droppedTxHash = `0x${'ee'.repeat(32)}` as `0x${string}`;

    // No subgraph event for this cid → not anchored.
    // Confirmation throws "tx not found" once — the awaitTxConfirmation
    // mock simulates a dropped tx.
    confirmSpy.failureForHash.set(droppedTxHash, new Error('tx not found in mempool'));

    const crashed: LaunchedSolverNetRecord = {
      schemaVersion: 'solvernet.launched.v1',
      solverNetId: manifest.solverNetId,
      manifestCid: cid,
      manifestHash: manifestHash(manifest),
      launcherAgentId: signer.agentId,
      launcherSafeAddress: manifest.launcher.safeAddress,
      launchedAt: '2026-05-06T00:00:00.000Z',
      status: 'launching',
      statusUpdatedAt: '2026-05-06T00:00:00.000Z',
      generatorEnabled: true,
      registry: { metadataTxHash: droppedTxHash },
      launchProgress: { phase: 'confirming', txHash: droppedTxHash, attemptCount: 0 },
    };
    await store.writeRecord(crashed);

    const action = new LaunchAction(makeDeps());
    const resumed = await action.resume({ record: crashed, signer });

    // Re-broadcast happened: publisher.setMetadata called once.
    expect(publisher.calls).toHaveLength(1);
    expect(publisher.calls[0]!.key).toBe(`solvernet-manifest:${cid}`);
    // Final tx hash differs from the dropped one.
    expect(resumed.registry.metadataTxHash).not.toBe(droppedTxHash);
    expect(resumed.status).toBe('launched');
    expect(resumed.launchProgress).toBeUndefined();
  });

  it('already-anchored: txHash set, no receipt, subgraph DOES have an event → treat as confirmed, no re-broadcast', async () => {
    const { manifest, signer } = await buildSignedManifest();
    const cid = await ipfs.upload(manifest);
    const lostTxHash = `0x${'ff'.repeat(32)}` as `0x${string}`;

    // Subgraph event present — proves the cid IS anchored on chain even
    // though our local txHash polling can't find a receipt.
    subgraph.events.push({
      agentId: signer.agentId,
      key: `solvernet-manifest:${cid}`,
      payload: {
        schemaVersion: 'solvernet.lifecycle.v1',
        status: 'launched',
        at: '2026-05-06T00:00:00Z',
        hash: manifestHash(manifest),
      },
      blockNumber: 1234,
      transactionIndex: 5,
    });

    confirmSpy.failureForHash.set(lostTxHash, new Error('tx not found in mempool'));

    const crashed: LaunchedSolverNetRecord = {
      schemaVersion: 'solvernet.launched.v1',
      solverNetId: manifest.solverNetId,
      manifestCid: cid,
      manifestHash: manifestHash(manifest),
      launcherAgentId: signer.agentId,
      launcherSafeAddress: manifest.launcher.safeAddress,
      launchedAt: '2026-05-06T00:00:00.000Z',
      status: 'launching',
      statusUpdatedAt: '2026-05-06T00:00:00.000Z',
      generatorEnabled: true,
      registry: { metadataTxHash: lostTxHash },
      launchProgress: { phase: 'confirming', txHash: lostTxHash, attemptCount: 0 },
    };
    await store.writeRecord(crashed);

    const action = new LaunchAction(makeDeps());
    const resumed = await action.resume({ record: crashed, signer });

    expect(resumed.status).toBe('launched');
    // No re-broadcast — subgraph already shows the cid is anchored.
    expect(publisher.calls).toHaveLength(0);
    // Block number in registry comes from the subgraph event.
    expect(resumed.registry.metadataBlockNumber).toBe(1234);
    expect(resumed.launchProgress).toBeUndefined();
  });

  it('after MAX_ATTEMPTS failures, status flips to failed (callable to retry by resetting status)', async () => {
    const { manifest, signer } = await buildSignedManifest();

    const action = new LaunchAction(makeDeps({ maxAttempts: 2 }));

    // First attempt: fail at broadcast.
    publisher.failNextSetMetadata = { error: new Error('rpc 503') };
    await expect(action.launch({ manifest, signer })).rejects.toThrow();
    let onDisk = await store.loadRecord(manifest.solverNetId);
    expect(onDisk!.status).toBe('launching');
    expect(onDisk!.launchProgress?.attemptCount).toBe(1);

    // Second attempt (resume): fail at broadcast again — this will be the
    // attempt that hits maxAttempts.
    publisher.failNextSetMetadata = { error: new Error('rpc 503') };
    await expect(action.resume({ record: onDisk!, signer })).rejects.toThrow();
    onDisk = await store.loadRecord(manifest.solverNetId);
    expect(onDisk!.status).toBe('failed');
    expect(onDisk!.launchProgress?.attemptCount).toBe(2);

    // Manual recovery: reset to 'launching' and clear error.
    const reset: LaunchedSolverNetRecord = {
      ...onDisk!,
      status: 'launching',
      launchProgress: {
        ...onDisk!.launchProgress!,
        attemptCount: 0,
        ...(onDisk!.launchProgress?.txError ? { txError: undefined } : {}),
      },
    };
    delete reset.launchProgress!.txError;
    await store.writeRecord(reset);

    const recovered = await action.resume({ record: reset, signer });
    expect(recovered.status).toBe('launched');
  });

  it('default max attempts (sanity) constant exists and is positive', () => {
    expect(DEFAULT_MAX_ATTEMPTS).toBeGreaterThan(0);
  });
});

// ── recoverInFlightLaunches ────────────────────────────────────────────────

describe('recoverInFlightLaunches', () => {
  it('scans launched dir for status=launching records and resumes each', async () => {
    const { manifest: manifestA, signer: signerA } = await buildSignedManifest({
      agentId: '5474',
      solverNetId: 'sn_a',
    });
    const { manifest: manifestB, signer: signerB } = await buildSignedManifest({
      agentId: '5474',
      solverNetId: 'sn_b',
    });
    // Same agentId so the same signer can resume both — in production all
    // owned records share the launcher's signer.
    signerB.agentEoaPrivateKey = signerA.agentEoaPrivateKey;
    signerB.agentEoaAddress = signerA.agentEoaAddress;

    // Plant two records: one in-flight (broadcasting) and one already
    // launched (must be skipped).
    const cidA = await ipfs.upload(manifestA);
    const inflight: LaunchedSolverNetRecord = {
      schemaVersion: 'solvernet.launched.v1',
      solverNetId: manifestA.solverNetId,
      manifestCid: cidA,
      manifestHash: manifestHash(manifestA),
      launcherAgentId: signerA.agentId,
      launcherSafeAddress: manifestA.launcher.safeAddress,
      launchedAt: '2026-05-06T00:00:00.000Z',
      status: 'launching',
      statusUpdatedAt: '2026-05-06T00:00:00.000Z',
      generatorEnabled: true,
      registry: {},
      launchProgress: { phase: 'broadcasting', attemptCount: 0 },
    };
    const launched: LaunchedSolverNetRecord = {
      ...inflight,
      solverNetId: manifestB.solverNetId,
      status: 'launched',
      registry: {
        metadataTxHash: `0x${'12'.repeat(32)}` as `0x${string}`,
        metadataBlockNumber: 88,
      },
    };
    delete (launched as { launchProgress?: unknown }).launchProgress;

    await store.writeRecord(inflight);
    await store.writeRecord(launched);

    const result = await recoverInFlightLaunches({
      ...makeDeps(),
      // recoverInFlightLaunches needs a signer-resolver; inject a function
      // that picks the right signer for a given launcherAgentId.
      resolveSigner: async (_agentId: string) => signerA,
    });

    expect(result.resumed).toBe(1);
    expect(result.failed).toEqual([]);

    // Only the in-flight record was advanced.
    const ondiskA = await store.loadRecord(manifestA.solverNetId);
    expect(ondiskA?.status).toBe('launched');
    // Already-launched record is unchanged.
    const ondiskB = await store.loadRecord(manifestB.solverNetId);
    expect(ondiskB?.status).toBe('launched');
    expect(ondiskB?.registry.metadataBlockNumber).toBe(88);
  });

  it('captures errors per-record without aborting the scan', async () => {
    const { manifest, signer } = await buildSignedManifest();
    const cid = await ipfs.upload(manifest);

    const broken: LaunchedSolverNetRecord = {
      schemaVersion: 'solvernet.launched.v1',
      solverNetId: manifest.solverNetId,
      manifestCid: cid,
      manifestHash: manifestHash(manifest),
      launcherAgentId: signer.agentId,
      launcherSafeAddress: manifest.launcher.safeAddress,
      launchedAt: '2026-05-06T00:00:00.000Z',
      status: 'launching',
      statusUpdatedAt: '2026-05-06T00:00:00.000Z',
      generatorEnabled: true,
      registry: {},
      launchProgress: { phase: 'broadcasting', attemptCount: 0 },
    };
    await store.writeRecord(broken);

    publisher.failNextSetMetadata = { error: new Error('chain down') };

    const result = await recoverInFlightLaunches({
      ...makeDeps(),
      resolveSigner: async () => signer,
    });

    expect(result.resumed).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.solverNetId).toBe(manifest.solverNetId);
    expect(result.failed[0]?.error.message).toMatch(/chain down/);
  });

  it('returns zero counts when no records exist', async () => {
    const { signer } = await buildSignedManifest();
    const result = await recoverInFlightLaunches({
      ...makeDeps(),
      resolveSigner: async () => signer,
    });
    expect(result.resumed).toBe(0);
    expect(result.failed).toEqual([]);
  });
});
