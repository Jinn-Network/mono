import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MechAdapterConfig } from '../../../src/adapters/mech/types.js';
import { VerdictCode } from '../../../src/adapters/mech/verdict-code.js';
import type { SignedTaskV1 } from '../../../src/types/task-document.js';
import type { DiscoveryAPI, ClaimableTaskCandidate } from '../../../src/discovery/types.js';
import { DiscoveryUnavailableError } from '../../../src/discovery/types.js';

const HOISTED = vi.hoisted(() => {
  const REQUEST_ID = ('0x' + 'aa'.repeat(32)) as `0x${string}`;
  const TASK_CID_DIGEST = ('0x' + 'cc'.repeat(32)) as `0x${string}`;
  const TASK_CID = `f01551220${'cc'.repeat(32)}`;
  const MANIFEST_DIGEST = ('0x' + '99'.repeat(32)) as `0x${string}`;
  const TX_HASH = ('0x' + '12'.repeat(32)) as `0x${string}`;
  const signedTask = (overrides: Partial<SignedTaskV1> = {}): SignedTaskV1 => ({
    schemaVersion: 'task.v1',
    id: 'prediction-task-1',
    solverType: 'prediction.v1',
    contractId: 'prediction',
    contractVersion: 'v1',
    solverNetManifestCid: 'bafyfixturecid',
    role: 'restoration',
    description: 'Will the test market resolve YES?',
    window: { startTs: 1_775_000_000_000, endTs: 1_775_000_600_000 },
    spec: {
      venue: 'polymarket',
      marketId: 'market-1',
      conditionId: '0x' + '11'.repeat(32),
      outcomeTokenId: '123',
      outcome: 'YES',
    },
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
  return { REQUEST_ID, TASK_CID_DIGEST, TASK_CID, MANIFEST_DIGEST, TX_HASH, signedTask };
});

const { REQUEST_ID, TASK_CID_DIGEST, TASK_CID, MANIFEST_DIGEST, TX_HASH, signedTask } = HOISTED;

// MOCK_JUSTIFICATION: src/adapters/mech/contracts.js is the I/O leaf for chain RPC calls; mocking it is mocking the boundary.
vi.mock('../../../src/adapters/mech/contracts.js', () => ({
  submitTask: vi.fn().mockResolvedValue({
    taskId: '1',
    txHash: TX_HASH,
    receiptLogCount: 1,
    blockNumber: 123,
  }),
  claimTask: vi.fn().mockResolvedValue({
    taskId: '1',
    attemptIndex: 0,
    requestId: REQUEST_ID,
    txHash: TX_HASH,
    blockNumber: 124,
  }),
  canClaimTask: vi.fn().mockResolvedValue({ ok: true }),
  canClaimEvaluation: vi.fn().mockResolvedValue({ ok: true }),
  claimEvaluation: vi.fn().mockResolvedValue({
    taskId: '1',
    attemptIndex: 0,
    verdictIndex: 0,
    requestId: ('0x' + 'bb'.repeat(32)) as `0x${string}`,
    txHash: TX_HASH,
    blockNumber: 125,
  }),
  claimDelivery: vi.fn().mockResolvedValue('0x1234'),
  getMechDeliveryRate: vi.fn().mockResolvedValue(1000000n),
  getTimeoutBounds: vi.fn().mockResolvedValue({ min: 60n, max: 300n }),
  decodeTaskCreatedLogs: vi.fn().mockReturnValue([]),
  decodeSolutionDeliveryClaimedLogs: vi.fn().mockReturnValue([]),
  decodeDeliverLogs: vi.fn().mockReturnValue([]),
  findLatestDeliveryDataHexForRequest: vi.fn().mockResolvedValue(TASK_CID_DIGEST),
  getMarketplaceRequestDeliveryMech: vi.fn().mockResolvedValue(('0x' + '77'.repeat(20)) as `0x${string}`),
  getTaskCidDigest: vi.fn().mockResolvedValue(TASK_CID_DIGEST),
  callDeliverToMarketplace: vi.fn().mockResolvedValue('0x5678'),
}));

// MOCK_JUSTIFICATION: src/adapters/mech/ipfs.js is the I/O leaf for IPFS gateway HTTP calls; mocking it is mocking the boundary.
vi.mock('../../../src/adapters/mech/ipfs.js', () => ({
  buildResultPayload: vi.fn((requestId: string, result: unknown) => ({ requestId, ...(result as Record<string, unknown>) })),
  uploadToIpfs: vi.fn().mockResolvedValue('QmFakeCid'),
  cidToDigestHex: vi.fn().mockReturnValue(TASK_CID_DIGEST),
  fetchFromIpfs: vi.fn().mockResolvedValue({ data: 'result' }),
  fetchSignedTaskFromIpfs: vi.fn().mockResolvedValue(signedTask()),
  fetchSignedEnvelopeFromIpfs: vi.fn().mockResolvedValue(null),
  digestHexToGatewayUrl: vi.fn(),
}));

// MOCK_JUSTIFICATION: digest.js is a pure CID-to-digest transform; mocking it pins the output so manifest-filter assertions use a deterministic digest.
vi.mock('../../../src/adapters/mech/digest.js', () => ({
  manifestDigestForCid: vi.fn().mockReturnValue(MANIFEST_DIGEST),
}));

// MOCK_JUSTIFICATION: canonical-json is a pure transform; mocking it fixes the output for deterministic evidence hash assertions.
vi.mock('../../../src/harnesses/engine/canonical-json.js', () => ({
  canonicalJson: vi.fn().mockReturnValue('{"mocked":"jcs"}'),
}));

// MOCK_JUSTIFICATION: envelope schema validation is covered in envelope tests; here we isolate adapter routing logic.
vi.mock('../../../src/types/envelope.js', () => ({
  normalizeEnvelopeRole: vi.fn((role: unknown) => role === 'restoration' ? 'solution' : role),
  SignedEnvelopeSchema: {
    parse: vi.fn(),
  },
}));

// MOCK_JUSTIFICATION: src/adapters/mech/safe.js is the Safe/RPC I/O leaf; mocking it is mocking the boundary.
vi.mock('../../../src/adapters/mech/safe.js', () => ({
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

function makeConfigStore(initial: Record<string, string> = {}, lastProcessedBlock: bigint | null = null) {
  const values = new Map(Object.entries(initial));
  return {
    getLastProcessedBlock: vi.fn().mockReturnValue(lastProcessedBlock),
    getConfigValue: vi.fn((key: string) => values.get(key) ?? null),
    setConfigValue: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    values,
  };
}

describe('MechAdapter TaskCoordinator flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('postTask uploads a signed task.v1 document and calls createTask', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { submitTask } = await import('../../../src/adapters/mech/contracts.js');
    const { uploadToIpfs } = await import('../../../src/adapters/mech/ipfs.js');

    const adapter = new MechAdapter(TEST_CONFIG);
    await adapter.initialize();

    const posted = await adapter.postTask({
      id: 'prediction-task-1',
      description: 'Will the test market resolve YES?',
      solverType: 'prediction.v1',
      contractId: 'prediction',
      contractVersion: 'v1',
      solverNetManifestCid: 'bafyfixturecid',
      claimPolicy: {
        mode: 'parallel',
        maxClaims: 25,
        maxClaimsPerOperator: 1,
        claimLeaseTtlSeconds: 600,
      },
    });

    expect(posted).toMatchObject({
      taskId: '1',
      taskCid: TASK_CID,
      txHash: TX_HASH,
      blockNumber: 123,
    });
    expect(uploadToIpfs).toHaveBeenCalledWith(
      TEST_CONFIG.ipfsRegistryUrl,
      expect.objectContaining({
        schemaVersion: 'task.v1',
        solverType: 'prediction.v1',
        contractId: 'prediction',
        contractVersion: 'v1',
        solverNetManifestCid: 'bafyfixturecid',
        claimPolicy: expect.objectContaining({ maxClaims: 25 }),
      }),
    );
    // Task 24 (spec/2026-05-05-solvernet-creation-and-launch.md §14): on-chain
    // `manifestDigest` is `keccak256(toBytes(manifestCid))` — bound to the
    // launched SolverNet manifest, not to the SolverType label.
    const { keccak256, toBytes } = await import('viem');
    const expectedManifestDigest = keccak256(toBytes('bafyfixturecid'));
    expect(submitTask).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      TEST_CONFIG.safeAddress,
      TEST_CONFIG.routerAddress,
      TASK_CID_DIGEST,
      expectedManifestDigest,
      expect.objectContaining({
        maxClaims: 25,
        maxClaimsPerOperator: 1,
        evaluationPolicy: expect.objectContaining({
          requiredVerdicts: 1,
          passThreshold: 1,
          maxVerdictsPerEvaluator: 1,
          disallowSolverSelfEvaluation: true,
        }),
      }),
      1000000n,
      1000000n,
      300n,
      undefined,
    );

    await adapter.stop();
  });

  it('postTask refuses to sign and post a Task without solverNetManifestCid', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { submitTask } = await import('../../../src/adapters/mech/contracts.js');

    const adapter = new MechAdapter(TEST_CONFIG);
    await adapter.initialize();

    await expect(
      adapter.postTask({
        id: 'orphan-task',
        description: 'orphan — no SolverNet manifest cid',
        solverType: 'prediction.v1',
      }),
    ).rejects.toThrow(/solverNetManifestCid/);
    expect(submitTask).not.toHaveBeenCalled();

    await adapter.stop();
  });

  it('watchForTasks yields signed TaskCreated announcements', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { decodeTaskCreatedLogs } = await import('../../../src/adapters/mech/contracts.js');
    const { fetchSignedTaskFromIpfs } = await import('../../../src/adapters/mech/ipfs.js');

    vi.mocked(decodeTaskCreatedLogs).mockReturnValueOnce([{
      taskId: '7',
      taskCidDigest: TASK_CID_DIGEST,
      manifestDigest: MANIFEST_DIGEST,
      creator: TEST_CONFIG.safeAddress,
      transactionHash: TX_HASH,
      blockNumber: 321,
    }]);
    vi.mocked(fetchSignedTaskFromIpfs).mockResolvedValueOnce(signedTask({ id: 'watched-task' }));

    const adapter = new MechAdapter(TEST_CONFIG);
    await adapter.initialize();
    (adapter as any).publicClient.getBlockNumber = vi.fn().mockResolvedValue(101n);
    (adapter as any).publicClient.getLogs = vi.fn().mockResolvedValue([{ data: '0x', topics: [] }]);
    (adapter as any).requestBlockCursor = 100n;

    const gen = adapter.watchForTasks()[Symbol.asyncIterator]();
    const { value } = await gen.next();

    expect(value).toMatchObject({
      taskId: '7',
      taskCid: TASK_CID,
      onchainCreationTx: TX_HASH,
      onchainCreationBlock: 321,
    });
    expect(value!.task.id).toBe('watched-task');
    expect(value!.task.solverType).toBe('prediction.v1');
    expect(fetchSignedTaskFromIpfs).toHaveBeenCalledWith(TEST_CONFIG.ipfsGatewayUrl, TASK_CID);

    await adapter.stop();
  });

  it('watchForTasks yields discoveryApi-discovered claimable backlog tasks', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { canClaimTask, claimTask } = await import('../../../src/adapters/mech/contracts.js');
    const { fetchSignedTaskFromIpfs } = await import('../../../src/adapters/mech/ipfs.js');

    const candidate: ClaimableTaskCandidate = {
      taskId: '42',
      taskCidDigest: TASK_CID_DIGEST,
      manifestDigest: MANIFEST_DIGEST,
      createdAtBlock: 80,
      createdAtTx: TX_HASH,
      attemptCount: 0,
      operatorAttemptCount: 0,
    };
    const mockDiscoveryApi: DiscoveryAPI = {
      findClaimableTasks: vi.fn().mockResolvedValueOnce([candidate]),
      listLaunchedSolverNets: vi.fn().mockResolvedValue([]),
      getLifecycleStatus: vi.fn().mockResolvedValue(undefined),
      queryEnvelopes: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(fetchSignedTaskFromIpfs).mockResolvedValueOnce(signedTask({ id: 'discovery-task' }));

    const adapter = new MechAdapter({
      ...TEST_CONFIG,
      taskDiscovery: {
        discoveryApi: mockDiscoveryApi,
        solverNetManifestCids: ['bafyfixturecid'],
        // Opt out of the gh #300 ghost-task floor for this test — the
        // fixture candidates use tiny block numbers that pre-date the
        // production default floor; this test is about discovery
        // yielding, not floor filtering.
        onchainFromBlock: 0,
      },
    });
    await adapter.initialize();
    (adapter as any).publicClient.getBlockNumber = vi.fn().mockResolvedValue(100n);

    const gen = adapter.watchForTasks()[Symbol.asyncIterator]();
    const { value } = await gen.next();

    expect(mockDiscoveryApi.findClaimableTasks).toHaveBeenCalledWith(expect.objectContaining({
      solverNetManifestCids: ['bafyfixturecid'],
      operatorAddress: TEST_CONFIG.safeAddress,
    }));
    expect(canClaimTask).toHaveBeenCalledWith(
      expect.anything(),
      TEST_CONFIG.safeAddress,
      TEST_CONFIG.routerAddress,
      '42',
      TEST_CONFIG.mechContractAddress,
    );
    expect(value).toMatchObject({
      taskId: '42',
      taskCid: TASK_CID,
      onchainCreationTx: TX_HASH,
      onchainCreationBlock: 80,
      task: { id: 'discovery-task' },
    });

    await adapter.claimTask(value!.taskId);
    expect(claimTask).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      TEST_CONFIG.safeAddress,
      TEST_CONFIG.routerAddress,
      '42',
      TEST_CONFIG.mechContractAddress,
      undefined,
    );

    await adapter.stop();
  });

  it('discovery filters out pre-floor candidates (gh #300 ghost-task floor)', async () => {
    // The DiscoveryAPI (Ponder indexer or onchain-floor listClaimableTasks)
    // returns all claimable tasks regardless of when they were created.
    // Without a parallel floor filter here, the floor on the on-chain
    // TaskCreated backlog scan is bypassed by the DiscoveryAPI path. This
    // test pins that filter: a candidate with `createdAtBlock` below the
    // configured floor must be skipped before canClaimTask is called.
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { canClaimTask } = await import('../../../src/adapters/mech/contracts.js');
    const { fetchSignedTaskFromIpfs } = await import('../../../src/adapters/mech/ipfs.js');

    const mockDiscoveryApi: DiscoveryAPI = {
      findClaimableTasks: vi.fn().mockResolvedValueOnce([
        // Pre-floor candidate — should be filtered out.
        {
          taskId: '42',
          taskCidDigest: TASK_CID_DIGEST,
          manifestDigest: MANIFEST_DIGEST,
          createdAtBlock: 50,
          createdAtTx: TX_HASH,
          attemptCount: 0,
          operatorAttemptCount: 0,
        },
        // Post-floor candidate — should be yielded.
        {
          taskId: '43',
          taskCidDigest: TASK_CID_DIGEST,
          manifestDigest: MANIFEST_DIGEST,
          createdAtBlock: 150,
          createdAtTx: TX_HASH,
          attemptCount: 0,
          operatorAttemptCount: 0,
        },
      ]),
      listLaunchedSolverNets: vi.fn().mockResolvedValue([]),
      getLifecycleStatus: vi.fn().mockResolvedValue(undefined),
      queryEnvelopes: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(fetchSignedTaskFromIpfs).mockResolvedValueOnce(signedTask({ id: 'post-floor-task' }));

    const adapter = new MechAdapter({
      ...TEST_CONFIG,
      taskDiscovery: {
        discoveryApi: mockDiscoveryApi,
        solverNetManifestCids: ['bafyfixturecid'],
        onchainFromBlock: 100,
      },
    });
    await adapter.initialize();

    const iter = (adapter as any).discoverSubgraphRestorationTasks()[Symbol.asyncIterator]();
    const first = await iter.next();

    // Only the post-floor candidate (taskId 43) should be yielded; the
    // pre-floor candidate (taskId 42) is filtered before canClaimTask runs.
    expect(first.value).toMatchObject({ taskId: '43' });
    expect(canClaimTask).toHaveBeenCalledTimes(1);
    expect(vi.mocked(canClaimTask).mock.calls[0][3]).toBe('43');

    await adapter.stop();
  });

  it('discovery passes through candidates with missing createdAtBlock (cannot filter without it)', async () => {
    // Defensive: if the DiscoveryAPI omits createdAtBlock for some reason
    // (legacy indexer schema, partial response), we let the candidate
    // through rather than dropping it silently. canClaimTask then enforces
    // claimability and signed-task fetch validates the rest.
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { canClaimTask } = await import('../../../src/adapters/mech/contracts.js');
    const { fetchSignedTaskFromIpfs } = await import('../../../src/adapters/mech/ipfs.js');

    const mockDiscoveryApi: DiscoveryAPI = {
      findClaimableTasks: vi.fn().mockResolvedValueOnce([
        {
          taskId: '99',
          taskCidDigest: TASK_CID_DIGEST,
          manifestDigest: MANIFEST_DIGEST,
          // No createdAtBlock.
          createdAtTx: TX_HASH,
          attemptCount: 0,
          operatorAttemptCount: 0,
        },
      ]),
      listLaunchedSolverNets: vi.fn().mockResolvedValue([]),
      getLifecycleStatus: vi.fn().mockResolvedValue(undefined),
      queryEnvelopes: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(fetchSignedTaskFromIpfs).mockResolvedValueOnce(signedTask({ id: 'no-block-task' }));

    const adapter = new MechAdapter({
      ...TEST_CONFIG,
      taskDiscovery: {
        discoveryApi: mockDiscoveryApi,
        solverNetManifestCids: ['bafyfixturecid'],
        onchainFromBlock: 100,
      },
    });
    await adapter.initialize();

    const iter = (adapter as any).discoverSubgraphRestorationTasks()[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.value).toMatchObject({ taskId: '99' });

    await adapter.stop();
  });

  it('discovery yields one backlog task per polling pass', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { canClaimTask } = await import('../../../src/adapters/mech/contracts.js');
    const { fetchSignedTaskFromIpfs } = await import('../../../src/adapters/mech/ipfs.js');

    const mockDiscoveryApi: DiscoveryAPI = {
      findClaimableTasks: vi.fn().mockResolvedValueOnce([
        {
          taskId: '42',
          taskCidDigest: TASK_CID_DIGEST,
          manifestDigest: MANIFEST_DIGEST,
          createdAtBlock: 80,
          createdAtTx: TX_HASH,
          attemptCount: 0,
          operatorAttemptCount: 0,
        },
        {
          taskId: '43',
          taskCidDigest: TASK_CID_DIGEST,
          manifestDigest: MANIFEST_DIGEST,
          createdAtBlock: 81,
          createdAtTx: TX_HASH,
          attemptCount: 0,
          operatorAttemptCount: 0,
        },
      ]),
      listLaunchedSolverNets: vi.fn().mockResolvedValue([]),
      getLifecycleStatus: vi.fn().mockResolvedValue(undefined),
      queryEnvelopes: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(fetchSignedTaskFromIpfs).mockResolvedValueOnce(signedTask({ id: 'first-discovery-task' }));

    const adapter = new MechAdapter({
      ...TEST_CONFIG,
      taskDiscovery: {
        discoveryApi: mockDiscoveryApi,
        solverNetManifestCids: ['bafyfixturecid'],
        // gh #300: opt out of the floor — fixtures use tiny block numbers.
        onchainFromBlock: 0,
      },
    });
    await adapter.initialize();

    const iter = (adapter as any).discoverSubgraphRestorationTasks()[Symbol.asyncIterator]();
    const first = await iter.next();
    const second = await iter.next();

    expect(first.value).toMatchObject({
      taskId: '42',
      task: { id: 'first-discovery-task' },
    });
    expect(second.done).toBe(true);
    expect(canClaimTask).toHaveBeenCalledTimes(1);
    expect(fetchSignedTaskFromIpfs).toHaveBeenCalledTimes(1);

    await adapter.stop();
  });

  it('discovery honors an explicit task id scope', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { canClaimTask } = await import('../../../src/adapters/mech/contracts.js');
    const { fetchSignedTaskFromIpfs } = await import('../../../src/adapters/mech/ipfs.js');

    const mockDiscoveryApi: DiscoveryAPI = {
      findClaimableTasks: vi.fn().mockResolvedValueOnce([
        {
          taskId: '42',
          taskCidDigest: TASK_CID_DIGEST,
          manifestDigest: MANIFEST_DIGEST,
          createdAtBlock: 80,
          createdAtTx: TX_HASH,
          attemptCount: 0,
          operatorAttemptCount: 0,
        },
        {
          taskId: '43',
          taskCidDigest: TASK_CID_DIGEST,
          manifestDigest: MANIFEST_DIGEST,
          createdAtBlock: 81,
          createdAtTx: TX_HASH,
          attemptCount: 0,
          operatorAttemptCount: 0,
        },
      ]),
      listLaunchedSolverNets: vi.fn().mockResolvedValue([]),
      getLifecycleStatus: vi.fn().mockResolvedValue(undefined),
      queryEnvelopes: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(fetchSignedTaskFromIpfs).mockResolvedValueOnce(signedTask({ id: 'scoped-discovery-task' }));

    const adapter = new MechAdapter({
      ...TEST_CONFIG,
      taskDiscovery: {
        discoveryApi: mockDiscoveryApi,
        solverNetManifestCids: ['bafyfixturecid'],
        allowedTaskIds: ['43'],
        // gh #300: opt out of the floor — fixtures use tiny block numbers.
        onchainFromBlock: 0,
      },
    });
    await adapter.initialize();

    const iter = (adapter as any).discoverSubgraphRestorationTasks()[Symbol.asyncIterator]();
    const first = await iter.next();

    expect(first.value).toMatchObject({
      taskId: '43',
      task: { id: 'scoped-discovery-task' },
    });
    expect(canClaimTask).toHaveBeenCalledTimes(1);
    expect(canClaimTask).toHaveBeenCalledWith(
      expect.anything(),
      TEST_CONFIG.safeAddress,
      TEST_CONFIG.routerAddress,
      '43',
      TEST_CONFIG.mechContractAddress,
    );

    await adapter.stop();
  });

  it('falls back to canonical TaskCreated logs when discoveryApi fails', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { decodeTaskCreatedLogs } = await import('../../../src/adapters/mech/contracts.js');
    const { fetchSignedTaskFromIpfs } = await import('../../../src/adapters/mech/ipfs.js');
    const manifestCid = 'bafyfixturecid';

    const mockDiscoveryApi: DiscoveryAPI = {
      findClaimableTasks: vi.fn().mockRejectedValueOnce(
        new DiscoveryUnavailableError('discovery HTTP 429'),
      ),
      listLaunchedSolverNets: vi.fn().mockResolvedValue([]),
      getLifecycleStatus: vi.fn().mockResolvedValue(undefined),
      queryEnvelopes: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(decodeTaskCreatedLogs).mockReturnValueOnce([{
      taskId: '44',
      taskCidDigest: TASK_CID_DIGEST,
      manifestDigest: MANIFEST_DIGEST,
      creator: TEST_CONFIG.safeAddress,
      transactionHash: TX_HASH,
      blockNumber: 101,
    }]);
    vi.mocked(fetchSignedTaskFromIpfs).mockResolvedValueOnce(signedTask({ id: 'fallback-task' }));

    const adapter = new MechAdapter({
      ...TEST_CONFIG,
      taskDiscovery: {
        discoveryApi: mockDiscoveryApi,
        solverNetManifestCids: [manifestCid],
        onchainFromBlock: 100,
      },
    });
    await adapter.initialize();
    (adapter as any).publicClient.getBlockNumber = vi.fn().mockResolvedValue(101n);
    (adapter as any).publicClient.getLogs = vi.fn().mockResolvedValue([{ data: '0x', topics: [] }]);

    const gen = adapter.watchForTasks()[Symbol.asyncIterator]();
    const { value } = await gen.next();

    expect(value).toMatchObject({
      taskId: '44',
      task: { id: 'fallback-task' },
      taskCid: TASK_CID,
    });

    await adapter.stop();
  });

  it('canonical TaskCreated scan honors an explicit task id scope', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { decodeTaskCreatedLogs } = await import('../../../src/adapters/mech/contracts.js');
    const { fetchSignedTaskFromIpfs } = await import('../../../src/adapters/mech/ipfs.js');
    const manifestCid = 'bafyfixturecid';

    vi.mocked(decodeTaskCreatedLogs).mockReturnValueOnce([
      {
        taskId: '44',
        taskCidDigest: TASK_CID_DIGEST,
        manifestDigest: MANIFEST_DIGEST,
        transactionHash: TX_HASH,
        blockNumber: 101,
      },
      {
        taskId: '45',
        taskCidDigest: TASK_CID_DIGEST,
        manifestDigest: MANIFEST_DIGEST,
        transactionHash: TX_HASH,
        blockNumber: 102,
      },
    ]);
    vi.mocked(fetchSignedTaskFromIpfs).mockResolvedValueOnce(signedTask({ id: 'scoped-onchain-task' }));

    const adapter = new MechAdapter({
      ...TEST_CONFIG,
      taskDiscovery: {
        solverNetManifestCids: [manifestCid],
        onchainFromBlock: 100,
        allowedTaskIds: ['45'],
      },
    });
    await adapter.initialize();
    (adapter as any).publicClient.getBlockNumber = vi.fn().mockResolvedValue(102n);
    (adapter as any).publicClient.getLogs = vi.fn().mockResolvedValue([{ data: '0x', topics: [] }]);

    const gen = adapter.watchForTasks()[Symbol.asyncIterator]();
    const { value } = await gen.next();

    expect(value).toMatchObject({
      taskId: '45',
      task: { id: 'scoped-onchain-task' },
    });

    await adapter.stop();
  });

  it('watchForTasks yields evaluation opportunities and claimTask claims them as evaluator work', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const {
      canClaimEvaluation,
      claimEvaluation,
      decodeSolutionDeliveryClaimedLogs,
      findLatestDeliveryDataHexForRequest,
      getMarketplaceRequestDeliveryMech,
      getTaskCidDigest,
    } = await import('../../../src/adapters/mech/contracts.js');
    const { fetchFromIpfs, fetchSignedTaskFromIpfs, uploadToIpfs } = await import('../../../src/adapters/mech/ipfs.js');
    const solverSafe = ('0x' + '66'.repeat(20)) as `0x${string}`;
    const solverMech = ('0x' + '77'.repeat(20)) as `0x${string}`;

    vi.mocked(decodeSolutionDeliveryClaimedLogs).mockReturnValueOnce([{
      taskId: '1',
      attemptIndex: 0,
      requestId: REQUEST_ID,
      operator: solverSafe,
      transactionHash: TX_HASH,
      blockNumber: 333,
    }]);
    vi.mocked(getMarketplaceRequestDeliveryMech).mockResolvedValueOnce(solverMech);
    vi.mocked(fetchFromIpfs).mockResolvedValueOnce({ data: 'solution payload' });
    vi.mocked(fetchSignedTaskFromIpfs).mockResolvedValueOnce(signedTask({ id: 'watched-task' }));

    const adapter = new MechAdapter(TEST_CONFIG);
    await adapter.initialize();
    (adapter as any).publicClient.getBlockNumber = vi.fn().mockResolvedValue(101n);
    (adapter as any).publicClient.getLogs = vi.fn().mockResolvedValue([{ data: '0x', topics: [] }]);
    (adapter as any).requestBlockCursor = 100n;

    const gen = adapter.watchForTasks()[Symbol.asyncIterator]();
    const { value } = await gen.next();

    expect(value).toMatchObject({
      taskId: `evaluation:1:0:${REQUEST_ID}`,
      task: {
        role: 'evaluation',
        restorationRequestId: REQUEST_ID,
        attemptId: REQUEST_ID,
        attemptNumber: 0,
      },
      onchainCreationTx: TX_HASH,
      onchainCreationBlock: 333,
    });
    expect(value!.task.id).toBe('watched-task:evaluation:0');
    expect(value!.task.context).toMatchObject({
      restorationResult: 'solution payload',
      solutionEnvelopeCid: TASK_CID,
    });
    expect(getTaskCidDigest).toHaveBeenCalledWith(
      expect.anything(),
      TEST_CONFIG.routerAddress,
      '1',
    );
    expect(getMarketplaceRequestDeliveryMech).toHaveBeenCalledWith(
      expect.anything(),
      TEST_CONFIG.mechMarketplaceAddress,
      REQUEST_ID,
    );
    expect(findLatestDeliveryDataHexForRequest).toHaveBeenCalledWith(
      expect.anything(),
      solverMech,
      REQUEST_ID,
      0n,
      333n,
    );
    expect(fetchSignedTaskFromIpfs).toHaveBeenCalledWith(
      TEST_CONFIG.ipfsGatewayUrl,
      TASK_CID,
    );
    expect(canClaimEvaluation).toHaveBeenCalledWith(
      expect.anything(),
      TEST_CONFIG.safeAddress,
      TEST_CONFIG.routerAddress,
      '1',
      0,
      TEST_CONFIG.mechContractAddress,
    );
    expect(claimEvaluation).not.toHaveBeenCalled();

    const request = await adapter.claimTask(value!.taskId);
    expect(uploadToIpfs).toHaveBeenCalledWith(TEST_CONFIG.ipfsRegistryUrl, expect.objectContaining({
      role: 'evaluation',
      restorationRequestId: REQUEST_ID,
    }));
    expect(claimEvaluation).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      TEST_CONFIG.safeAddress,
      TEST_CONFIG.routerAddress,
      '1',
      0,
      TEST_CONFIG.mechContractAddress,
      TASK_CID_DIGEST,
      undefined,
    );
    expect(request).toMatchObject({
      requestId: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      taskId: '1',
      attemptIndex: 0,
      task: { role: 'evaluation', restorationRequestId: REQUEST_ID },
      taskCid: 'QmFakeCid',
    });

    await adapter.stop();
  });

  it('drops stale evaluation opportunities before yielding them to the daemon', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const {
      canClaimEvaluation,
      findLatestDeliveryDataHexForRequest,
      getMarketplaceRequestDeliveryMech,
    } = await import('../../../src/adapters/mech/contracts.js');
    const { fetchFromIpfs, fetchSignedTaskFromIpfs } = await import('../../../src/adapters/mech/ipfs.js');
    vi.mocked(canClaimEvaluation).mockResolvedValueOnce({
      ok: false,
      reason: 'TCAttemptAlreadyFinalized(1, 0)',
    });
    vi.mocked(fetchSignedTaskFromIpfs).mockResolvedValueOnce(signedTask({ id: 'watched-task' }));

    const adapter = new MechAdapter(TEST_CONFIG);
    await adapter.initialize();
    const solution = {
      taskId: '1',
      attemptIndex: 0,
      requestId: REQUEST_ID,
      operator: ('0x' + '66'.repeat(20)) as `0x${string}`,
      transactionHash: TX_HASH,
      blockNumber: 333,
    };
    (adapter as any).pendingEvaluationSolutions.set(REQUEST_ID, solution);

    const announcement = await (adapter as any).evaluationAnnouncementForSolution(solution);

    expect(announcement).toBeUndefined();
    expect((adapter as any).pendingEvaluationSolutions.has(REQUEST_ID)).toBe(false);
    expect(canClaimEvaluation).toHaveBeenCalledWith(
      expect.anything(),
      TEST_CONFIG.safeAddress,
      TEST_CONFIG.routerAddress,
      '1',
      0,
      TEST_CONFIG.mechContractAddress,
    );
    expect(getMarketplaceRequestDeliveryMech).not.toHaveBeenCalled();
    expect(findLatestDeliveryDataHexForRequest).not.toHaveBeenCalled();
    expect(fetchFromIpfs).not.toHaveBeenCalled();

    await adapter.stop();
  });

  it('bounds the default delivery-log scan around delayed SolutionDeliveryClaimed events', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const {
      decodeSolutionDeliveryClaimedLogs,
      findLatestDeliveryDataHexForRequest,
    } = await import('../../../src/adapters/mech/contracts.js');
    const { fetchFromIpfs, fetchSignedTaskFromIpfs } = await import('../../../src/adapters/mech/ipfs.js');
    const solverSafe = ('0x' + '66'.repeat(20)) as `0x${string}`;
    const solverMech = ('0x' + '77'.repeat(20)) as `0x${string}`;

    vi.mocked(decodeSolutionDeliveryClaimedLogs).mockReturnValueOnce([{
      taskId: '1',
      attemptIndex: 0,
      requestId: REQUEST_ID,
      operator: solverSafe,
      transactionHash: TX_HASH,
      blockNumber: 125_000,
    }]);
    vi.mocked(fetchFromIpfs).mockResolvedValueOnce({ data: 'solution payload' });
    vi.mocked(fetchSignedTaskFromIpfs).mockResolvedValueOnce(signedTask({ id: 'watched-task' }));

    const adapter = new MechAdapter(TEST_CONFIG);
    await adapter.initialize();
    (adapter as any).publicClient.getBlockNumber = vi.fn().mockResolvedValue(125_001n);
    (adapter as any).publicClient.getLogs = vi.fn().mockResolvedValue([{ data: '0x', topics: [] }]);
    (adapter as any).requestBlockCursor = 124_999n;

    const gen = adapter.watchForTasks()[Symbol.asyncIterator]();
    const { value } = await gen.next();

    expect(value!.task.role).toBe('evaluation');
    expect(findLatestDeliveryDataHexForRequest).toHaveBeenCalledWith(
      expect.anything(),
      solverMech,
      REQUEST_ID,
      25_000n,
      125_000n,
    );

    await adapter.stop();
  });

  it('retries transient evaluation discovery failures after advancing the router cursor', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const {
      decodeSolutionDeliveryClaimedLogs,
      findLatestDeliveryDataHexForRequest,
    } = await import('../../../src/adapters/mech/contracts.js');
    const { fetchFromIpfs, fetchSignedTaskFromIpfs } = await import('../../../src/adapters/mech/ipfs.js');
    const solverSafe = ('0x' + '66'.repeat(20)) as `0x${string}`;

    vi.mocked(decodeSolutionDeliveryClaimedLogs).mockReturnValueOnce([{
      taskId: '1',
      attemptIndex: 0,
      requestId: REQUEST_ID,
      operator: solverSafe,
      transactionHash: TX_HASH,
      blockNumber: 333,
    }]);
    vi.mocked(fetchSignedTaskFromIpfs).mockResolvedValueOnce(signedTask({ id: 'watched-task' }));
    vi.mocked(fetchFromIpfs)
      .mockRejectedValueOnce(new Error('temporary IPFS outage'))
      .mockResolvedValueOnce({ data: 'solution payload' });

    const adapter = new MechAdapter({ ...TEST_CONFIG, pollIntervalMs: 0 });
    await adapter.initialize();
    (adapter as any).publicClient.getBlockNumber = vi.fn().mockResolvedValue(101n);
    (adapter as any).publicClient.getLogs = vi.fn().mockResolvedValue([{ data: '0x', topics: [] }]);
    (adapter as any).requestBlockCursor = 100n;

    const gen = adapter.watchForTasks()[Symbol.asyncIterator]();
    const { value } = await gen.next();

    expect(value).toMatchObject({
      taskId: `evaluation:1:0:${REQUEST_ID}`,
      task: {
        role: 'evaluation',
        restorationRequestId: REQUEST_ID,
      },
    });
    expect((adapter as any).requestBlockCursor).toBe(101n);
    expect(fetchFromIpfs).toHaveBeenCalledTimes(2);
    expect(findLatestDeliveryDataHexForRequest).toHaveBeenCalledTimes(2);

    await adapter.stop();
  });

  it('backfills router task logs from the persisted block after restart', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { decodeTaskCreatedLogs } = await import('../../../src/adapters/mech/contracts.js');
    const { fetchSignedTaskFromIpfs } = await import('../../../src/adapters/mech/ipfs.js');
    const store = makeConfigStore({}, 100n);

    vi.mocked(decodeTaskCreatedLogs).mockReturnValueOnce([{
      taskId: '7',
      taskCidDigest: TASK_CID_DIGEST,
      manifestDigest: MANIFEST_DIGEST,
      transactionHash: TX_HASH,
      blockNumber: 105,
    }]);
    vi.mocked(fetchSignedTaskFromIpfs).mockResolvedValueOnce(signedTask({ id: 'recovered-task' }));

    const adapter = new MechAdapter(
      { ...TEST_CONFIG, pollIntervalMs: 0 },
      store as any,
    );
    await adapter.initialize();
    (adapter as any).publicClient.getBlockNumber = vi.fn().mockResolvedValue(110n);
    const getLogs = vi.fn().mockResolvedValue([{ data: '0x', topics: [] }]);
    (adapter as any).publicClient.getLogs = getLogs;

    const gen = adapter.watchForTasks()[Symbol.asyncIterator]();
    const { value } = await gen.next();

    expect(value).toMatchObject({
      taskId: '7',
      task: { id: 'recovered-task' },
    });
    expect(getLogs).toHaveBeenCalledWith({
      address: TEST_CONFIG.routerAddress,
      fromBlock: 101n,
      toBlock: 110n,
    });
    expect(store.values.get('mech_router_request_block_cursor_v1')).toBe('110');

    await adapter.stop();
  });

  it('rescans the canonical on-chain backlog on restart even after a previous scan marker', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { decodeTaskCreatedLogs } = await import('../../../src/adapters/mech/contracts.js');
    const { fetchSignedTaskFromIpfs } = await import('../../../src/adapters/mech/ipfs.js');
    const store = makeConfigStore({
      mech_router_request_block_cursor_v1: '119',
      mech_router_task_created_canonical_scan_v1: '1',
    }, 119n);

    vi.mocked(decodeTaskCreatedLogs).mockReturnValueOnce([{
      taskId: '88',
      taskCidDigest: TASK_CID_DIGEST,
      manifestDigest: MANIFEST_DIGEST,
      transactionHash: TX_HASH,
      blockNumber: 105,
    }]);
    vi.mocked(fetchSignedTaskFromIpfs).mockResolvedValueOnce(signedTask({ id: 'rescanned-task' }));

    const adapter = new MechAdapter(
      {
        ...TEST_CONFIG,
        pollIntervalMs: 0,
        taskDiscovery: {
          solverNetManifestCids: ['bafyfixturecid'],
          onchainFromBlock: 100,
        },
      },
      store as any,
    );
    await adapter.initialize();
    (adapter as any).publicClient.getBlockNumber = vi.fn().mockResolvedValue(120n);
    const getLogs = vi.fn().mockResolvedValue([{ data: '0x', topics: [] }]);
    (adapter as any).publicClient.getLogs = getLogs;

    const gen = adapter.watchForTasks()[Symbol.asyncIterator]();
    const { value } = await gen.next();

    expect(value).toMatchObject({
      taskId: '88',
      task: { id: 'rescanned-task' },
    });
    expect(getLogs).toHaveBeenCalledWith({
      address: TEST_CONFIG.routerAddress,
      fromBlock: 100n,
      toBlock: 120n,
    });
    expect(store.values.get('mech_router_request_block_cursor_v1')).toBe('120');

    await adapter.stop();
  });

  it('keeps pending evaluation solutions durable until claimTask creates a verdict request', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { claimEvaluation } = await import('../../../src/adapters/mech/contracts.js');
    const { uploadToIpfs } = await import('../../../src/adapters/mech/ipfs.js');
    const solverSafe = ('0x' + '66'.repeat(20)) as `0x${string}`;
    const store = makeConfigStore({
      mech_pending_evaluation_solutions_v1: JSON.stringify([{
        taskId: '1',
        attemptIndex: 0,
        requestId: REQUEST_ID,
        operator: solverSafe,
        transactionHash: TX_HASH,
        blockNumber: 333,
      }]),
      mech_router_request_block_cursor_v1: '333',
    }, 333n);

    const adapter = new MechAdapter(
      { ...TEST_CONFIG, pollIntervalMs: 0 },
      store as any,
    );
    await adapter.initialize();
    (adapter as any).publicClient.getBlockNumber = vi.fn().mockResolvedValue(333n);

    const gen = adapter.watchForTasks()[Symbol.asyncIterator]();
    const { value } = await gen.next();

    expect(value).toMatchObject({
      taskId: `evaluation:1:0:${REQUEST_ID}`,
      task: {
        role: 'evaluation',
        restorationRequestId: REQUEST_ID,
      },
    });
    expect(store.values.get('mech_pending_evaluation_solutions_v1')).toContain(REQUEST_ID);

    const request = await adapter.claimTask(value!.taskId);

    expect(uploadToIpfs).toHaveBeenCalledWith(TEST_CONFIG.ipfsRegistryUrl, expect.objectContaining({
      role: 'evaluation',
      restorationRequestId: REQUEST_ID,
    }));
    expect(claimEvaluation).toHaveBeenCalled();
    expect(request).toMatchObject({
      requestId: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      taskId: '1',
      attemptIndex: 0,
    });
    expect(store.values.get('mech_pending_evaluation_solutions_v1')).toBe('[]');

    await adapter.stop();
  });

  it('claimTask creates an internal requestId for an observed Task', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { claimTask } = await import('../../../src/adapters/mech/contracts.js');

    const adapter = new MechAdapter(TEST_CONFIG);
    await adapter.initialize();
    (adapter as any).observedTasks.set('1', {
      taskId: '1',
      task: { id: 'prediction-task-1', description: 'test', solverType: 'prediction.v1' },
      taskCid: TASK_CID,
      onchainCreationTx: TX_HASH,
      onchainCreationBlock: 123,
    });

    const request = await adapter.claimTask('1');

    expect(request).toMatchObject({
      taskId: '1',
      attemptIndex: 0,
      requestId: REQUEST_ID,
      taskCid: TASK_CID,
    });
    expect(claimTask).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      TEST_CONFIG.safeAddress,
      TEST_CONFIG.routerAddress,
      '1',
      TEST_CONFIG.mechContractAddress,
      undefined,
    );
    expect((adapter as any).pendingEvaluations.get(REQUEST_ID).solverType).toBe('prediction.v1');

    await adapter.stop();
  });

  it('submitResult remains requestId-based after Task claim', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { callDeliverToMarketplace } = await import('../../../src/adapters/mech/contracts.js');
    const { buildResultPayload, uploadToIpfs } = await import('../../../src/adapters/mech/ipfs.js');

    const adapter = new MechAdapter(TEST_CONFIG);
    await adapter.initialize();

    await adapter.submitResult(REQUEST_ID, { data: 'solution', artifacts: ['bafyartifact'] });

    expect(buildResultPayload).toHaveBeenCalledWith(REQUEST_ID, {
      data: 'solution',
      artifacts: ['bafyartifact'],
    });
    expect(uploadToIpfs).toHaveBeenCalledWith(TEST_CONFIG.ipfsRegistryUrl, expect.objectContaining({
      requestId: REQUEST_ID,
      data: 'solution',
    }));
    expect(callDeliverToMarketplace).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      TEST_CONFIG.safeAddress,
      TEST_CONFIG.mechContractAddress,
      [REQUEST_ID],
      [TASK_CID_DIGEST],
      undefined,
    );

    await adapter.stop();
  });

  it('watchForDeliveries claims router delivery and yields the submitted Solution', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { claimDelivery, claimEvaluation, decodeDeliverLogs } = await import('../../../src/adapters/mech/contracts.js');
    const { fetchFromIpfs, uploadToIpfs } = await import('../../../src/adapters/mech/ipfs.js');

    vi.mocked(decodeDeliverLogs).mockReturnValueOnce([{
      requestId: REQUEST_ID,
      deliveryDataHex: TASK_CID_DIGEST,
      mechAddress: TEST_CONFIG.safeAddress,
    }]);
    vi.mocked(fetchFromIpfs).mockResolvedValueOnce({
      schemaVersion: 'jinn.execution.v1',
      role: 'solution',
      signature: { hash: '0x' + 'ef'.repeat(32) },
    });

    const adapter = new MechAdapter(TEST_CONFIG);
    await adapter.initialize();
    (adapter as any).publicClient.getBlockNumber = vi.fn().mockResolvedValue(101n);
    (adapter as any).publicClient.getLogs = vi.fn().mockResolvedValue([{ data: '0x', topics: [] }]);
    (adapter as any).deliveryBlockCursor = 100n;
    (adapter as any).pendingEvaluations.set(REQUEST_ID, { id: 'prediction-task-1', description: 'test' });
    (adapter as any).originalStates.set(REQUEST_ID, { id: 'prediction-task-1', description: 'test' });
    (adapter as any).requestKinds.set(REQUEST_ID, 'solution');

    const gen = adapter.watchForDeliveries()[Symbol.asyncIterator]();
    const { value } = await gen.next();

    expect(claimDelivery).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      TEST_CONFIG.safeAddress,
      TEST_CONFIG.routerAddress,
      REQUEST_ID,
      { variant: 'v1', kind: 'solution', evidenceHash: undefined },
      undefined,
    );
    expect(uploadToIpfs).not.toHaveBeenCalled();
    expect(claimEvaluation).not.toHaveBeenCalled();
    expect(value).toMatchObject({
      requestId: REQUEST_ID,
      result: {
        data: expect.stringContaining('"schemaVersion":"jinn.execution.v1"'),
      },
      deliveryMechAddress: TEST_CONFIG.safeAddress,
    });

    await adapter.stop();
  });

  it('watchForDeliveries still claims recovery deliveries while the submission deadline remains open', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-18T12:30:00.000Z'));

    try {
      const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
      const { claimDelivery, decodeDeliverLogs } = await import('../../../src/adapters/mech/contracts.js');
      const { fetchFromIpfs } = await import('../../../src/adapters/mech/ipfs.js');
      const claimWindowEndTs = Date.parse('2026-05-18T12:00:00.000Z');
      const submissionDeadlineTs = Date.parse('2026-05-18T12:20:00.000Z');
      const blockTimestampSeconds = Math.floor(Date.parse('2026-05-18T12:10:00.000Z') / 1000);

      vi.mocked(decodeDeliverLogs).mockReturnValueOnce([{
        requestId: REQUEST_ID,
        deliveryDataHex: TASK_CID_DIGEST,
        mechAddress: TEST_CONFIG.safeAddress,
        blockNumber: 101n,
      }]);
      vi.mocked(fetchFromIpfs).mockResolvedValueOnce({ data: 'result' });

      const adapter = new MechAdapter({ ...TEST_CONFIG, pollIntervalMs: 1 });
      await adapter.initialize();
      (adapter as any).publicClient.getBlockNumber = vi.fn().mockResolvedValue(101n);
      (adapter as any).publicClient.getBlock = vi.fn().mockResolvedValue({ timestamp: BigInt(blockTimestampSeconds) });
      (adapter as any).publicClient.getLogs = vi.fn().mockResolvedValue([{ data: '0x', topics: [] }]);
      (adapter as any).deliveryBlockCursor = 100n;
      const taskWithinLease = {
        id: 'prediction-task-1',
        description: 'recovery task still within submission deadline',
        claimPolicy: {
          mode: 'exclusive',
          maxClaims: 1,
          maxClaimsPerOperator: 1,
          claimLeaseTtlSeconds: 600,
          claimWindowEndTs,
          submissionDeadlineTs,
        },
      };
      (adapter as any).pendingEvaluations.set(REQUEST_ID, taskWithinLease);
      (adapter as any).originalStates.set(REQUEST_ID, taskWithinLease);
      (adapter as any).requestKinds.set(REQUEST_ID, 'solution');

      const gen = adapter.watchForDeliveries()[Symbol.asyncIterator]();
      const { value } = await gen.next();

      expect((adapter as any).publicClient.getBlock).toHaveBeenCalledWith({ blockNumber: 101n });
      expect(claimDelivery).toHaveBeenCalledOnce();
      expect(fetchFromIpfs).toHaveBeenCalledOnce();
      expect(value).toMatchObject({
        requestId: REQUEST_ID,
        task: taskWithinLease,
        result: { data: 'result' },
        deliveryMechAddress: TEST_CONFIG.safeAddress,
      });

      await adapter.stop();
      const donePromise = gen.next();
      await vi.advanceTimersByTimeAsync(5);
      await expect(donePromise).resolves.toMatchObject({ done: true, value: undefined });

      expect((adapter as any).pendingEvaluations.has(REQUEST_ID)).toBe(false);
      expect((adapter as any).originalStates.has(REQUEST_ID)).toBe(false);
      expect((adapter as any).requestKinds.has(REQUEST_ID)).toBe(false);

    } finally {
      vi.useRealTimers();
    }
  });

  it('watchForDeliveries still claims recovery deliveries emitted before expiry even when processed after expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-18T12:30:00.000Z'));

    try {
      const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
      const { claimDelivery, decodeDeliverLogs } = await import('../../../src/adapters/mech/contracts.js');
      const { fetchFromIpfs } = await import('../../../src/adapters/mech/ipfs.js');
      const claimWindowEndTs = Date.parse('2026-05-18T12:00:00.000Z');
      const submissionDeadlineTs = Date.parse('2026-05-18T12:20:00.000Z');
      const deliveryBlockNumber = 101n;
      const scanHeadBlockNumber = 105n;
      const deliveryBlockTimestampSeconds = Math.floor(Date.parse('2026-05-18T12:10:00.000Z') / 1000);
      const scanHeadTimestampSeconds = Math.floor(Date.parse('2026-05-18T12:25:00.000Z') / 1000);

      vi.mocked(decodeDeliverLogs).mockReturnValueOnce([{
        requestId: REQUEST_ID,
        deliveryDataHex: TASK_CID_DIGEST,
        mechAddress: TEST_CONFIG.safeAddress,
        blockNumber: deliveryBlockNumber,
      }]);
      vi.mocked(fetchFromIpfs).mockResolvedValueOnce({ data: 'result' });

      const adapter = new MechAdapter({ ...TEST_CONFIG, pollIntervalMs: 1 });
      await adapter.initialize();
      (adapter as any).publicClient.getBlockNumber = vi.fn().mockResolvedValue(scanHeadBlockNumber);
      (adapter as any).publicClient.getBlock = vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => {
        if (blockNumber === deliveryBlockNumber) {
          return { timestamp: BigInt(deliveryBlockTimestampSeconds) };
        }
        if (blockNumber === scanHeadBlockNumber) {
          return { timestamp: BigInt(scanHeadTimestampSeconds) };
        }
        throw new Error(`unexpected block lookup: ${blockNumber}`);
      });
      (adapter as any).publicClient.getLogs = vi.fn().mockResolvedValue([{ data: '0x', topics: [] }]);
      (adapter as any).deliveryBlockCursor = 100n;
      const taskWithinDeadlineAtEmit = {
        id: 'prediction-task-1',
        description: 'recovery task emitted before expiry',
        claimPolicy: {
          mode: 'exclusive',
          maxClaims: 1,
          maxClaimsPerOperator: 1,
          claimLeaseTtlSeconds: 600,
          claimWindowEndTs,
          submissionDeadlineTs,
        },
      };
      (adapter as any).pendingEvaluations.set(REQUEST_ID, taskWithinDeadlineAtEmit);
      (adapter as any).originalStates.set(REQUEST_ID, taskWithinDeadlineAtEmit);
      (adapter as any).requestKinds.set(REQUEST_ID, 'solution');

      const gen = adapter.watchForDeliveries()[Symbol.asyncIterator]();
      const { value } = await gen.next();

      expect((adapter as any).publicClient.getBlock).toHaveBeenCalledWith({ blockNumber: deliveryBlockNumber });
      expect((adapter as any).publicClient.getBlock).not.toHaveBeenCalledWith({ blockNumber: scanHeadBlockNumber });
      expect(claimDelivery).toHaveBeenCalledOnce();
      expect(fetchFromIpfs).toHaveBeenCalledOnce();
      expect(value).toMatchObject({
        requestId: REQUEST_ID,
        task: taskWithinDeadlineAtEmit,
        result: { data: 'result' },
        deliveryMechAddress: TEST_CONFIG.safeAddress,
      });

      await adapter.stop();
      const donePromise = gen.next();
      await vi.advanceTimersByTimeAsync(5);
      await expect(donePromise).resolves.toMatchObject({ done: true, value: undefined });
    } finally {
      vi.useRealTimers();
    }
  });

  it('watchForDeliveries skips recovery deliveries once the submission deadline has passed on chain', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-18T12:05:00.000Z'));

    try {
      const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
      const { claimDelivery, decodeDeliverLogs } = await import('../../../src/adapters/mech/contracts.js');
      const { fetchFromIpfs } = await import('../../../src/adapters/mech/ipfs.js');
      const claimWindowEndTs = Date.parse('2026-05-18T12:00:00.000Z');
      const submissionDeadlineTs = Date.parse('2026-05-18T12:20:00.000Z');
      const blockTimestampSeconds = Math.floor(Date.parse('2026-05-18T12:20:01.000Z') / 1000);

      vi.mocked(decodeDeliverLogs).mockReturnValueOnce([{
        requestId: REQUEST_ID,
        deliveryDataHex: TASK_CID_DIGEST,
        mechAddress: TEST_CONFIG.safeAddress,
        blockNumber: 101n,
      }]);

      const adapter = new MechAdapter({ ...TEST_CONFIG, pollIntervalMs: 1 });
      await adapter.initialize();
      (adapter as any).publicClient.getBlockNumber = vi.fn().mockResolvedValue(101n);
      (adapter as any).publicClient.getBlock = vi.fn().mockResolvedValue({ timestamp: BigInt(blockTimestampSeconds) });
      (adapter as any).publicClient.getLogs = vi.fn().mockResolvedValue([{ data: '0x', topics: [] }]);
      (adapter as any).deliveryBlockCursor = 100n;
      const expiredTask = {
        id: 'prediction-task-1',
        description: 'expired recovery task',
        claimPolicy: {
          mode: 'exclusive',
          maxClaims: 1,
          maxClaimsPerOperator: 1,
          claimLeaseTtlSeconds: 600,
          claimWindowEndTs,
          submissionDeadlineTs,
        },
      };
      (adapter as any).pendingEvaluations.set(REQUEST_ID, expiredTask);
      (adapter as any).originalStates.set(REQUEST_ID, expiredTask);
      (adapter as any).requestKinds.set(REQUEST_ID, 'solution');

      const gen = adapter.watchForDeliveries()[Symbol.asyncIterator]();
      const nextPromise = gen.next();

      await vi.advanceTimersByTimeAsync(5);

      expect((adapter as any).publicClient.getBlock).toHaveBeenCalledWith({ blockNumber: 101n });
      expect(claimDelivery).not.toHaveBeenCalled();
      expect(fetchFromIpfs).not.toHaveBeenCalled();
      expect((adapter as any).pendingEvaluations.has(REQUEST_ID)).toBe(false);
      expect((adapter as any).originalStates.has(REQUEST_ID)).toBe(false);
      expect((adapter as any).requestKinds.has(REQUEST_ID)).toBe(false);

      await adapter.stop();
      await vi.advanceTimersByTimeAsync(5);

      await expect(nextPromise).resolves.toMatchObject({ done: true, value: undefined });
    } finally {
      vi.useRealTimers();
    }
  });

  it('V2 claimDelivery derives evidenceHash from the signed execution envelope', async () => {
    const { keccak256 } = await import('viem');
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { claimDelivery, decodeDeliverLogs } = await import('../../../src/adapters/mech/contracts.js');
    const { fetchSignedEnvelopeFromIpfs, fetchFromIpfs } = await import('../../../src/adapters/mech/ipfs.js');
    const { SignedEnvelopeSchema } = await import('../../../src/types/envelope.js');

    const expectedHash = keccak256(new TextEncoder().encode('{"mocked":"jcs"}'));
    const fakeEnvelope = {
      schemaVersion: 'jinn.execution.v1',
      kind: 'prediction.v1',
      role: 'solution',
      signature: {
        algo: 'secp256k1',
        signer: '0xabc',
        hash: expectedHash,
        sig: '0xsig',
      },
    };
    vi.mocked(fetchSignedEnvelopeFromIpfs).mockResolvedValueOnce(fakeEnvelope);
    vi.mocked((SignedEnvelopeSchema as any).parse).mockReturnValue(fakeEnvelope);
    vi.mocked(fetchFromIpfs).mockResolvedValueOnce({ data: 'solution' });
    vi.mocked(decodeDeliverLogs).mockReturnValueOnce([{
      requestId: REQUEST_ID,
      deliveryDataHex: TASK_CID_DIGEST,
      mechAddress: '0x9999999999999999999999999999999999999999',
      blockNumber: 101n,
    }]);

    const adapter = new MechAdapter({ ...TEST_CONFIG, routerClaimDeliveryVariant: 'v2' });
    await adapter.initialize();
    (adapter as any).publicClient.getBlockNumber = vi.fn().mockResolvedValue(101n);
    (adapter as any).publicClient.getLogs = vi.fn().mockResolvedValue([{ data: '0x', topics: [] }]);
    (adapter as any).deliveryBlockCursor = 100n;
    (adapter as any).pendingEvaluations.set(REQUEST_ID, { id: 'prediction-task-1', description: 'test' });
    (adapter as any).originalStates.set(REQUEST_ID, { id: 'prediction-task-1', description: 'test' });

    const gen = adapter.watchForDeliveries()[Symbol.asyncIterator]();
    await gen.next();

    expect(claimDelivery).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      TEST_CONFIG.safeAddress,
      TEST_CONFIG.routerAddress,
      REQUEST_ID,
      { variant: 'v2', kind: 'solution', evidenceHash: expectedHash },
      undefined,
    );
    expect(fetchSignedEnvelopeFromIpfs).toHaveBeenCalledWith(TEST_CONFIG.ipfsGatewayUrl, TASK_CID);

    await adapter.stop();
  });

  it('watchForDeliveries derives verdict claim metadata from the signed verdict envelope on retry', async () => {
    const { keccak256 } = await import('viem');
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { claimDelivery, decodeDeliverLogs } = await import('../../../src/adapters/mech/contracts.js');
    const { fetchSignedEnvelopeFromIpfs, fetchFromIpfs } = await import('../../../src/adapters/mech/ipfs.js');
    const { SignedEnvelopeSchema } = await import('../../../src/types/envelope.js');

    const expectedHash = keccak256(new TextEncoder().encode('{"mocked":"jcs"}'));
    const fakeEnvelope = {
      schemaVersion: 'jinn.execution.v1',
      solverType: 'prediction.v1',
      role: 'verdict',
      payload: {
        verdict: 'REJECTED',
      },
      signature: {
        algo: 'secp256k1',
        signer: '0xabc',
        hash: expectedHash,
        sig: '0xsig',
      },
    };
    vi.mocked(fetchSignedEnvelopeFromIpfs).mockResolvedValueOnce(fakeEnvelope);
    vi.mocked((SignedEnvelopeSchema as any).parse).mockReturnValue(fakeEnvelope);
    vi.mocked(fetchFromIpfs).mockResolvedValueOnce({ data: 'verdict' });
    vi.mocked(decodeDeliverLogs).mockReturnValueOnce([{
      requestId: REQUEST_ID,
      deliveryDataHex: TASK_CID_DIGEST,
      mechAddress: '0x9999999999999999999999999999999999999999',
    }]);

    const adapter = new MechAdapter({ ...TEST_CONFIG, routerClaimDeliveryVariant: 'v3' });
    await adapter.initialize();
    (adapter as any).publicClient.getBlockNumber = vi.fn().mockResolvedValue(101n);
    (adapter as any).publicClient.getLogs = vi.fn().mockResolvedValue([{ data: '0x', topics: [] }]);
    (adapter as any).deliveryBlockCursor = 100n;
    (adapter as any).pendingEvaluations.set(REQUEST_ID, { id: 'prediction-task-1', description: 'test', role: 'evaluation' });
    (adapter as any).originalStates.set(REQUEST_ID, { id: 'prediction-task-1', description: 'test', role: 'evaluation' });

    const gen = adapter.watchForDeliveries()[Symbol.asyncIterator]();
    await gen.next();

    expect(claimDelivery).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      TEST_CONFIG.safeAddress,
      TEST_CONFIG.routerAddress,
      REQUEST_ID,
      {
        variant: 'v3',
        kind: 'verdict',
        evidenceHash: expectedHash,
        verdictCode: VerdictCode.Fail,
      },
      undefined,
    );
    expect(fetchSignedEnvelopeFromIpfs).toHaveBeenCalledWith(TEST_CONFIG.ipfsGatewayUrl, TASK_CID);

    await adapter.stop();
  });
});

describe('DEFAULT_TASK_DISCOVERY_FROM_BLOCK (gh #300 — ghost-task floor)', () => {
  // The Base Sepolia floor sits just after the 2026-05-14T17:28Z rebuild of
  // the fufn validated-pool to `EVAL_SEMANTICS_VERSION='3'`. Tasks created
  // before that rebuild are admitted under a prior semantics regime and the
  // current evaluators refuse to score them ("admission_missing_or_unscorable
  // under semanticsVersion=3"). A fresh operator must not waste compute
  // claiming them. This is the regression guard against accidentally rolling
  // the floor back to a pre-rebuild block.
  it('Base Sepolia floor is set after the v3 pool rebuild', async () => {
    const { DEFAULT_TASK_DISCOVERY_FROM_BLOCK } = await import('../../../src/adapters/mech/adapter.js');
    expect(DEFAULT_TASK_DISCOVERY_FROM_BLOCK[84532]).toBe(41_510_000n);
  });

  it('Base mainnet floor is unchanged (no v3-rebuild equivalent on mainnet)', async () => {
    const { DEFAULT_TASK_DISCOVERY_FROM_BLOCK } = await import('../../../src/adapters/mech/adapter.js');
    expect(DEFAULT_TASK_DISCOVERY_FROM_BLOCK[8453]).toBe(25_000_000n);
  });
});
