// #1037 — Integration proof: a SolverNet join applied to a RUNNING daemon
// takes effect within one claim poll, no restart.
//
// This exercises the REAL MechAdapter discovery path, the REAL
// HarnessReadinessRegistry, the REAL SolverNetRegistry, the REAL mutable
// engine view, and the REAL applyJoin together — only the DiscoveryAPI, the
// IPFS/contracts I/O leaves and the Safe RPC client are stubbed (the same
// boundary test/adapters/mech/adapter.test.ts uses). It proves the AC without
// spinning Anvil.
//
// The discoverability assertion is at the `findClaimableTasks` boundary: with
// an empty cid set, `discoverSubgraphRestorationTasks` early-returns and
// `findClaimableTasks` is never called; after `applyJoin`, the SAME adapter
// instance calls `findClaimableTasks` with the new cid.

import { describe, expect, it, vi } from 'vitest';
import type { DiscoveryAPI, ClaimableTaskCandidate } from '../../src/discovery/types.js';
import type { SignedTaskV1 } from '../../src/types/task-document.js';
import { SolverNetRegistry } from '../../src/solver-nets/registry.js';
import { HarnessReadinessRegistry } from '../../src/harnesses/readiness-registry.js';
import { createMutableJoinedSolverNetsView } from '../../src/harnesses/engine/joined-solver-nets-view.js';
import { createJoinApplier } from '../../src/daemon/join-applier.js';
import type { JoinedSolverNetConfig } from '../../src/solver-nets/registry.js';
import type { Harness } from '../../src/harnesses/types.js';
import type { MechAdapterConfig } from '../../src/adapters/mech/types.js';

// The joined CID matches the signedTask fixture's solverNetManifestCid so the
// resolved task body carries the joined cid (explicit-cid path; no keccak
// digest fixture needed).
const CID = 'bafyfixturecid';

const HOISTED = vi.hoisted(() => {
  const REQUEST_ID = ('0x' + 'aa'.repeat(32)) as `0x${string}`;
  const TASK_CID_DIGEST = ('0x' + 'cc'.repeat(32)) as `0x${string}`;
  const MANIFEST_DIGEST = ('0x' + '99'.repeat(32)) as `0x${string}`;
  const TX_HASH = ('0x' + '12'.repeat(32)) as `0x${string}`;
  const signedTask = (overrides: Partial<SignedTaskV1> = {}): SignedTaskV1 => ({
    schemaVersion: 'task.v1',
    id: 'hot-apply-task',
    solverType: 'swe-rebench-v2.v1',
    contractId: 'swe-rebench-v2',
    contractVersion: 'v1',
    solverNetManifestCid: 'bafyfixturecid',
    role: 'restoration',
    description: 'SWE-rebench v2 hot-apply task.',
    window: { startTs: 1_775_000_000_000, endTs: 1_775_000_600_000 },
    spec: {},
    eligibility: {},
    claimPolicy: {
      mode: 'parallel',
      maxClaims: 25,
      maxClaimsPerOperator: 1,
      claimLeaseTtlSeconds: 600,
    },
    creator: {
      safeAddress: '0x1111111111111111111111111111111111111111',
      agentEoa: '0x2222222222222222222222222222222222222222',
    },
    createdAt: 1_775_000_000_000,
    signature: {
      algo: 'secp256k1',
      signer: '0x2222222222222222222222222222222222222222',
      hash: '0x' + 'ab'.repeat(32),
      sig: '0x' + 'cd'.repeat(65),
    },
    ...overrides,
  });
  return { REQUEST_ID, TASK_CID_DIGEST, MANIFEST_DIGEST, TX_HASH, signedTask };
});

const { TASK_CID_DIGEST, MANIFEST_DIGEST, TX_HASH, signedTask } = HOISTED;

// MOCK_JUSTIFICATION: src/adapters/mech/contracts.js is the I/O leaf for chain RPC calls; mocking it is mocking the boundary.
vi.mock('../../src/adapters/mech/contracts.js', () => ({
  submitTask: vi.fn().mockResolvedValue({ taskId: '1', txHash: HOISTED.TX_HASH, receiptLogCount: 1, blockNumber: 123 }),
  claimTask: vi.fn().mockResolvedValue({ taskId: '1', attemptIndex: 0, requestId: HOISTED.REQUEST_ID, txHash: HOISTED.TX_HASH, blockNumber: 124 }),
  canClaimTask: vi.fn().mockResolvedValue({ ok: true }),
  canClaimEvaluation: vi.fn().mockResolvedValue({ ok: true }),
  claimEvaluation: vi.fn().mockResolvedValue({ taskId: '1', attemptIndex: 0, verdictIndex: 0, requestId: ('0x' + 'bb'.repeat(32)) as `0x${string}`, txHash: HOISTED.TX_HASH, blockNumber: 125 }),
  claimDelivery: vi.fn().mockResolvedValue('0x1234'),
  getMechDeliveryRate: vi.fn().mockResolvedValue(1000000n),
  getTimeoutBounds: vi.fn().mockResolvedValue({ min: 60n, max: 300n }),
  decodeTaskCreatedLogs: vi.fn().mockReturnValue([]),
  decodeSolutionDeliveryClaimedLogs: vi.fn().mockReturnValue([]),
  decodeDeliverLogs: vi.fn().mockReturnValue([]),
  findLatestDeliveryDataHexForRequest: vi.fn().mockResolvedValue(HOISTED.TASK_CID_DIGEST),
  getMarketplaceRequestDeliveryMech: vi.fn().mockResolvedValue(('0x' + '77'.repeat(20)) as `0x${string}`),
  getTaskCidDigest: vi.fn().mockResolvedValue(HOISTED.TASK_CID_DIGEST),
  callDeliverToMarketplace: vi.fn().mockResolvedValue('0x5678'),
}));

// MOCK_JUSTIFICATION: src/adapters/mech/ipfs.js is the I/O leaf for IPFS gateway HTTP calls; mocking it is mocking the boundary.
vi.mock('../../src/adapters/mech/ipfs.js', () => ({
  buildResultPayload: vi.fn((requestId: string, result: unknown) => ({ requestId, ...(result as Record<string, unknown>) })),
  uploadToIpfs: vi.fn().mockResolvedValue('QmFakeCid'),
  cidToDigestHex: vi.fn().mockReturnValue(HOISTED.TASK_CID_DIGEST),
  fetchFromIpfs: vi.fn().mockResolvedValue({ data: 'result' }),
  fetchSignedTaskFromIpfs: vi.fn().mockResolvedValue(HOISTED.signedTask()),
  fetchSignedEnvelopeFromIpfs: vi.fn().mockResolvedValue(null),
  digestHexToGatewayUrl: vi.fn(),
}));

// MOCK_JUSTIFICATION: digest.js is a pure CID-to-digest transform; mocking it pins the output so manifest-filter assertions use a deterministic digest.
vi.mock('../../src/adapters/mech/digest.js', () => ({
  manifestDigestForCid: vi.fn().mockReturnValue(HOISTED.MANIFEST_DIGEST),
}));

// MOCK_JUSTIFICATION: canonical-json is a pure transform; mocking it fixes the output for deterministic evidence hash assertions.
vi.mock('../../src/harnesses/engine/canonical-json.js', () => ({
  canonicalJson: vi.fn().mockReturnValue('{"mocked":"jcs"}'),
}));

// MOCK_JUSTIFICATION: envelope schema validation is covered in envelope tests; here we isolate adapter routing logic.
vi.mock('../../src/types/envelope.js', () => ({
  normalizeEnvelopeRole: vi.fn((role: unknown) => role === 'restoration' ? 'solution' : role),
  SignedEnvelopeSchema: { parse: vi.fn() },
}));

// MOCK_JUSTIFICATION: src/adapters/mech/safe.js is the Safe/RPC I/O leaf; mocking it is mocking the boundary.
vi.mock('../../src/adapters/mech/safe.js', () => ({
  createClients: vi.fn().mockReturnValue({
    publicClient: {
      getBlockNumber: vi.fn().mockResolvedValue(100n),
      getLogs: vi.fn().mockResolvedValue([]),
      readContract: vi.fn().mockResolvedValue(false),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ logs: [] }),
    },
    walletClient: {},
    account: {},
  }),
}));

const TEST_CONFIG: MechAdapterConfig = {
  rpcUrl: 'http://localhost:8545',
  mechMarketplaceAddress: ('0x' + '11'.repeat(20)) as `0x${string}`,
  routerAddress: ('0x' + '22'.repeat(20)) as `0x${string}`,
  mechContractAddress: ('0x' + '33'.repeat(20)) as `0x${string}`,
  safeAddress: ('0x' + '44'.repeat(20)) as `0x${string}`,
  agentEoaPrivateKey: ('0x' + '55'.repeat(32)) as `0x${string}`,
  ipfsRegistryUrl: 'http://localhost:5001',
  ipfsGatewayUrl: 'http://localhost:8080',
  pollIntervalMs: 1000,
  chainId: 8453,
  routerClaimDeliveryVariant: 'v1',
};

const joined: JoinedSolverNetConfig = {
  manifestCid: CID,
  name: 'swe-isolated',
  contract: { id: 'swe-rebench-v2', version: 'v1' },
  roles: ['solver'],
  harness: 'codex',
  plugins: [],
  disabledDefaultPlugins: [],
};

describe('hot-apply join takes effect within one poll, no restart (#1037)', () => {
  it('zero joins → apply → discovery + readiness + registry + engine view all live', async () => {
    const { MechAdapter } = await import('../../src/adapters/mech/adapter.js');

    const candidate: ClaimableTaskCandidate = {
      taskId: '7',
      taskCidDigest: TASK_CID_DIGEST,
      manifestDigest: MANIFEST_DIGEST,
      createdAtBlock: 80,
      createdAtTx: TX_HASH,
      attemptCount: 0,
      operatorAttemptCount: 0,
    };
    const findClaimableTasks = vi.fn().mockResolvedValue([candidate]);
    const discoveryApi: DiscoveryAPI = {
      findClaimableTasks,
      listLaunchedSolverNets: vi.fn().mockResolvedValue([]),
      getLifecycleStatus: vi.fn().mockResolvedValue(undefined),
      queryEnvelopes: vi.fn().mockResolvedValue([]),
    };

    // The live taskDiscovery object — same reference passed to the adapter and
    // the applier (the local-capture form main.ts uses).
    const taskDiscovery = {
      discoveryApi,
      solverNetManifestCids: [] as string[],
      // Opt out of the ghost-task floor (fixture uses tiny block numbers).
      onchainFromBlock: 0,
    };
    const adapter = new MechAdapter({ ...TEST_CONFIG, taskDiscovery });
    await adapter.initialize();
    (adapter as any).publicClient.getBlockNumber = vi.fn().mockResolvedValue(100n);

    const harness: Harness = {
      name: 'codex',
      version: '0.0.0',
      supports: () => true,
      run: async () => { throw new Error('not used'); },
      isReady: async () => ({ ready: true }),
    };
    const readiness = new HarnessReadinessRegistry({
      harnessesByName: { codex: harness },
      joinedHarnessesByCid: {},
    });
    await readiness.refreshNow();
    const view = createMutableJoinedSolverNetsView({});
    const registry = new SolverNetRegistry();
    const config: { joinedSolverNets?: Record<string, JoinedSolverNetConfig> } = {};

    const applyJoin = createJoinApplier({ taskDiscovery, view, readiness, registry, config });

    // BEFORE: zero joins → discovery yields nothing, findClaimableTasks never called.
    const before = (adapter as any).discoverSubgraphRestorationTasks()[Symbol.asyncIterator]();
    const beforeFirst = await before.next();
    expect(beforeFirst.done).toBe(true);
    expect(findClaimableTasks).not.toHaveBeenCalled();
    expect(readiness.isReadyForClaim(CID).ready).toBe(false);
    expect(view.get(CID)).toBeUndefined();
    expect(registry.forSolverType('swe-rebench-v2.v1', 'restoration')).toBeUndefined();

    // APPLY (no restart).
    await applyJoin(joined);

    // AFTER: same adapter instance now discovers; all four surfaces live.
    const after = (adapter as any).discoverSubgraphRestorationTasks()[Symbol.asyncIterator]();
    await after.next();
    expect(findClaimableTasks).toHaveBeenCalledWith(
      expect.objectContaining({ solverNetManifestCids: [CID] }),
    );
    expect(readiness.isReadyForClaim(CID).ready).toBe(true);
    expect(view.get(CID)).toEqual({ roles: ['solver'] });
    expect(registry.forSolverType('swe-rebench-v2.v1', 'restoration')?.name).toBe('swe-isolated');
  });
});
