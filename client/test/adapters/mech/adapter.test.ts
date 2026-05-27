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
  let storedBlock: bigint | null = lastProcessedBlock;
  return {
    getLastProcessedBlock: vi.fn(() => storedBlock),
    setLastProcessedBlock: vi.fn((block: bigint) => {
      storedBlock = block;
    }),
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
        // Opt out of the ghost-task floor for this test — the
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

  it('discovery re-yields a previously-claimed taskId when canClaimTask still ok (multi-claim per operator)', async () => {
    // Regression for #582: the adapter used to keep an in-memory
    // `claimedRestorationTaskIds` set that suppressed a taskId from the
    // DiscoveryAPI path after the daemon had claimed it once. For Tasks
    // with `maxClaimsPerOperator > 1`, that silently blocked the second
    // (and any subsequent) claim. The authoritative per-operator cap is
    // `canClaimTask` (on-chain simulation) — when it still returns ok the
    // adapter must re-yield, not filter.
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
      // Return the same candidate on every poll — the contract still says
      // canClaimTask ok, so the operator should be allowed to claim again.
      findClaimableTasks: vi.fn().mockResolvedValueOnce([candidate]).mockResolvedValueOnce([candidate]),
      listLaunchedSolverNets: vi.fn().mockResolvedValue([]),
      getLifecycleStatus: vi.fn().mockResolvedValue(undefined),
      queryEnvelopes: vi.fn().mockResolvedValue([]),
    };
    // Only queue a single signed-task mock — on the bugged path the second
    // iteration never reaches the hydrate step (the in-memory gate filters
    // first). After the fix the second iteration falls through to the
    // shared baseline mock, which is fine because we only assert on taskId.
    vi.mocked(fetchSignedTaskFromIpfs).mockResolvedValueOnce(signedTask({ id: 'multi-claim-task' }));
    // Pin the claim result's taskId to '42' so the (since-removed) in-memory
    // `claimedRestorationTaskIds.add(claimed.taskId)` gate would actually
    // suppress this candidate on the second poll. The shared baseline mock
    // returns taskId '1', which would never collide with '42' and would mask
    // the bug.
    vi.mocked(claimTask).mockResolvedValueOnce({
      taskId: '42',
      attemptIndex: 0,
      requestId: REQUEST_ID,
      txHash: TX_HASH,
      blockNumber: 124,
    });

    const adapter = new MechAdapter({
      ...TEST_CONFIG,
      taskDiscovery: {
        discoveryApi: mockDiscoveryApi,
        solverNetManifestCids: ['bafyfixturecid'],
        onchainFromBlock: 0,
      },
    });
    await adapter.initialize();

    // First discovery poll yields the candidate.
    const iter1 = (adapter as any).discoverSubgraphRestorationTasks()[Symbol.asyncIterator]();
    const first = await iter1.next();
    expect(first.value).toMatchObject({ taskId: '42' });

    // Claim it — this used to populate the in-memory gate that suppressed
    // the second discovery yield.
    await adapter.claimTask(first.value!.taskId);
    expect(claimTask).toHaveBeenCalledTimes(1);

    // Second discovery poll — canClaimTask still returns ok, so the
    // candidate must be re-yielded. With the in-memory gate present this
    // call would resolve to `{ value: undefined, done: true }`.
    const iter2 = (adapter as any).discoverSubgraphRestorationTasks()[Symbol.asyncIterator]();
    const second = await iter2.next();
    expect(second.value).toMatchObject({ taskId: '42' });

    await adapter.stop();
  });

  it('discovery skips a candidate when canClaimTask returns TCOperatorClaimLimitReached', async () => {
    // Companion to #582: the on-chain per-operator cap is the authoritative
    // gate. When `canClaimTask` returns the operator-cap revert the adapter
    // must NOT yield the candidate, regardless of whether the in-memory
    // gate is present.
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { canClaimTask } = await import('../../../src/adapters/mech/contracts.js');

    const candidate: ClaimableTaskCandidate = {
      taskId: '77',
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
    vi.mocked(canClaimTask).mockResolvedValueOnce({
      ok: false,
      reason: 'operator has reached per-operator claim limit',
      revertName: 'TCOperatorClaimLimitReached',
    });

    const adapter = new MechAdapter({
      ...TEST_CONFIG,
      taskDiscovery: {
        discoveryApi: mockDiscoveryApi,
        solverNetManifestCids: ['bafyfixturecid'],
        onchainFromBlock: 0,
      },
    });
    await adapter.initialize();

    const iter = (adapter as any).discoverSubgraphRestorationTasks()[Symbol.asyncIterator]();
    const result = await iter.next();

    // The generator finishes without yielding — canClaimTask blocked the
    // only candidate.
    expect(result.done).toBe(true);
    expect(result.value).toBeUndefined();
    expect(canClaimTask).toHaveBeenCalledTimes(1);

    await adapter.stop();
  });

  it('discovery filters out pre-floor candidates (ghost-task floor)', async () => {
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

  it('discovery yields every hydrated candidate per polling pass', async () => {
    // Bug shape (pre-fix): the generator returned after the first successful
    // yield, so when the engine-watcher's in-flight gate fast-skipped that
    // candidate every subsequent candidate in the round-robin (`fc05f686`)
    // ordering starved for the duration of the 30s skip TTL. Live-verified
    // on task 212: iso 209/210/211/212 were claimable for 23 min while op-b's
    // daemon kept yielding `mainB` and getting fast-skipped.
    //
    // The engine-watcher (daemon._runEngineWatcherLoop) is the single point
    // of skip-state truth. The adapter's job is to surface the full
    // candidate list per cycle and let the engine apply its gate to each.
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
    vi.mocked(fetchSignedTaskFromIpfs)
      .mockResolvedValueOnce(signedTask({ id: 'first-discovery-task' }))
      .mockResolvedValueOnce(signedTask({ id: 'second-discovery-task' }));

    const adapter = new MechAdapter({
      ...TEST_CONFIG,
      taskDiscovery: {
        discoveryApi: mockDiscoveryApi,
        solverNetManifestCids: ['bafyfixturecid'],
        // Opt out of the floor — fixtures use tiny block numbers.
        onchainFromBlock: 0,
      },
    });
    await adapter.initialize();

    const iter = (adapter as any).discoverSubgraphRestorationTasks()[Symbol.asyncIterator]();
    const first = await iter.next();
    const second = await iter.next();
    const third = await iter.next();

    expect(first.value).toMatchObject({
      taskId: '42',
      task: { id: 'first-discovery-task' },
    });
    expect(second.value).toMatchObject({
      taskId: '43',
      task: { id: 'second-discovery-task' },
    });
    expect(third.done).toBe(true);
    expect(canClaimTask).toHaveBeenCalledTimes(2);
    expect(fetchSignedTaskFromIpfs).toHaveBeenCalledTimes(2);

    await adapter.stop();
  });

  it('discovery preserves round-robin fairness when the consumer skips earlier candidates within a cycle', async () => {
    // Round-robin regression (post-`fc05f686`): the engine-watcher applies
    // its admission gate to each yielded announcement and may fast-skip a
    // candidate (e.g. an in-flight mainline task). The adapter must continue
    // iterating its candidate list within the same cycle so that an isolated
    // task interleaved by the round-robin still reaches the engine — without
    // waiting a full poll cycle (or the 30s skip-recheck TTL) per skip.
    //
    // Mirrors the live bug shape on task 212:
    //   candidates = [mainA, iso212, mainB, iso213]
    //   engine fast-skips mainA and mainB (in-flight)
    //   the adapter must still yield iso212 and iso213 in this same cycle.
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { fetchSignedTaskFromIpfs } = await import('../../../src/adapters/mech/ipfs.js');

    const mockDiscoveryApi: DiscoveryAPI = {
      findClaimableTasks: vi.fn().mockResolvedValueOnce([
        {
          taskId: 'mainA',
          taskCidDigest: TASK_CID_DIGEST,
          manifestDigest: MANIFEST_DIGEST,
          createdAtBlock: 80,
          createdAtTx: TX_HASH,
          attemptCount: 0,
          operatorAttemptCount: 0,
        },
        {
          taskId: 'iso212',
          taskCidDigest: TASK_CID_DIGEST,
          manifestDigest: MANIFEST_DIGEST,
          createdAtBlock: 81,
          createdAtTx: TX_HASH,
          attemptCount: 0,
          operatorAttemptCount: 0,
        },
        {
          taskId: 'mainB',
          taskCidDigest: TASK_CID_DIGEST,
          manifestDigest: MANIFEST_DIGEST,
          createdAtBlock: 82,
          createdAtTx: TX_HASH,
          attemptCount: 0,
          operatorAttemptCount: 0,
        },
        {
          taskId: 'iso213',
          taskCidDigest: TASK_CID_DIGEST,
          manifestDigest: MANIFEST_DIGEST,
          createdAtBlock: 83,
          createdAtTx: TX_HASH,
          attemptCount: 0,
          operatorAttemptCount: 0,
        },
      ]),
      listLaunchedSolverNets: vi.fn().mockResolvedValue([]),
      getLifecycleStatus: vi.fn().mockResolvedValue(undefined),
      queryEnvelopes: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(fetchSignedTaskFromIpfs)
      .mockResolvedValueOnce(signedTask({ id: 'mainA-task' }))
      .mockResolvedValueOnce(signedTask({ id: 'iso212-task' }))
      .mockResolvedValueOnce(signedTask({ id: 'mainB-task' }))
      .mockResolvedValueOnce(signedTask({ id: 'iso213-task' }));

    const adapter = new MechAdapter({
      ...TEST_CONFIG,
      taskDiscovery: {
        discoveryApi: mockDiscoveryApi,
        solverNetManifestCids: ['bafyfixturecid'],
        // Opt out of the floor — fixtures use tiny block numbers.
        onchainFromBlock: 0,
      },
    });
    await adapter.initialize();

    // Drain the generator in a single cycle. The consumer (engine-watcher
    // surrogate) ignores `mainA` and `mainB` as if they were fast-skipped by
    // an in-flight gate, and records the ones it "accepts".
    const accepted: string[] = [];
    const skipped = new Set(['mainA', 'mainB']);
    for await (const announcement of (adapter as any).discoverSubgraphRestorationTasks()) {
      if (skipped.has(announcement.taskId)) continue;
      accepted.push(announcement.taskId);
    }

    expect(accepted).toEqual(['iso212', 'iso213']);

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
        // Opt out of the floor — fixtures use tiny block numbers.
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
      revertName: 'TCAttemptAlreadyFinalized',
    });

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
    // The claimability gate runs before the restoration lookup — a terminal
    // opportunity never pays the restoration / delivery / IPFS cost.
    expect(fetchSignedTaskFromIpfs).not.toHaveBeenCalled();
    expect(getMarketplaceRequestDeliveryMech).not.toHaveBeenCalled();
    expect(findLatestDeliveryDataHexForRequest).not.toHaveBeenCalled();
    expect(fetchFromIpfs).not.toHaveBeenCalled();

    await adapter.stop();
  });

  it('classifies a terminal opportunity from the structured revertName even when the formatted reason contains a "("', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { canClaimEvaluation, getTaskCidDigest } = await import('../../../src/adapters/mech/contracts.js');
    const { fetchSignedTaskFromIpfs } = await import('../../../src/adapters/mech/ipfs.js');

    // The formatted `reason` here is intentionally pathological: a leading "("
    // in the arg rendering. The old code regex-stripped `reason` (`/\(.*$/`)
    // to recover the bare name — that strip would corrupt this string and the
    // terminal check would silently fail, re-scanning a dead opportunity
    // forever. Classification now reads the structured `revertName` directly,
    // so the "(" in `reason` is irrelevant.
    vi.mocked(canClaimEvaluation).mockResolvedValueOnce({
      ok: false,
      reason: 'TCAttemptAlreadyFinalized((corrupt) 1, 0)',
      revertName: 'TCAttemptAlreadyFinalized',
    });

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
    // Terminal — classified via the structured name, pruned despite the "(" in reason.
    expect((adapter as any).pendingEvaluationSolutions.has(REQUEST_ID)).toBe(false);
    expect(getTaskCidDigest).not.toHaveBeenCalled();
    expect(fetchSignedTaskFromIpfs).not.toHaveBeenCalled();

    await adapter.stop();
  });

  it('prunes a terminal-reason evaluation opportunity before the expensive restoration lookup', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { canClaimEvaluation, getTaskCidDigest } = await import('../../../src/adapters/mech/contracts.js');
    const { fetchSignedTaskFromIpfs } = await import('../../../src/adapters/mech/ipfs.js');

    vi.mocked(canClaimEvaluation).mockResolvedValueOnce({
      ok: false,
      reason: 'TCMaxVerdictsReached(1, 0)',
      revertName: 'TCMaxVerdictsReached',
    });

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
    // Terminal reason -> pruned from the working set so the loop never re-scans it.
    expect((adapter as any).pendingEvaluationSolutions.has(REQUEST_ID)).toBe(false);
    // The claimability gate runs FIRST; the restoration lookup is never attempted.
    expect(getTaskCidDigest).not.toHaveBeenCalled();
    expect(fetchSignedTaskFromIpfs).not.toHaveBeenCalled();

    await adapter.stop();
  });

  it('retains a transient-reason evaluation opportunity for retry', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { canClaimEvaluation } = await import('../../../src/adapters/mech/contracts.js');

    vi.mocked(canClaimEvaluation).mockResolvedValueOnce({
      ok: false,
      reason: 'HTTP request failed: 429 Too Many Requests',
      revertName: null,
    });

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
    // Transient reason -> kept in the working set; it must be retried next cycle.
    expect((adapter as any).pendingEvaluationSolutions.has(REQUEST_ID)).toBe(true);

    await adapter.stop();
  });

  it('retryPendingEvaluationSolutions drops terminal opportunities and keeps re-checking transient ones', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { canClaimEvaluation } = await import('../../../src/adapters/mech/contracts.js');

    const TERMINAL_REQUEST_ID = ('0x' + 'ce'.repeat(32)) as `0x${string}`;
    const TRANSIENT_REQUEST_ID = ('0x' + 'cf'.repeat(32)) as `0x${string}`;

    const adapter = new MechAdapter(TEST_CONFIG);
    await adapter.initialize();
    const mkSolution = (taskId: string, requestId: `0x${string}`) => ({
      taskId,
      attemptIndex: 0,
      requestId,
      operator: ('0x' + '66'.repeat(20)) as `0x${string}`,
      transactionHash: TX_HASH,
      blockNumber: 333,
    });
    (adapter as any).pendingEvaluationSolutions.set(TERMINAL_REQUEST_ID, mkSolution('1', TERMINAL_REQUEST_ID));
    (adapter as any).pendingEvaluationSolutions.set(TRANSIENT_REQUEST_ID, mkSolution('2', TRANSIENT_REQUEST_ID));

    // canClaimEvaluation: terminal task -> non-recoverable revert; transient task -> generic RPC error.
    // mockImplementation persists across tests (vi.clearAllMocks only resets call
    // data, not the implementation), so it is restored before this test returns.
    const claimImpl = async (
      _pc: unknown,
      _safe: unknown,
      _router: unknown,
      taskId: unknown,
    ): Promise<{ ok: true } | { ok: false; reason: string; revertName: string | null }> => {
      if (String(taskId) === '1') {
        return { ok: false, reason: 'TCEvaluationDeadlinePassed(1)', revertName: 'TCEvaluationDeadlinePassed' };
      }
      return { ok: false, reason: 'execution reverted: connection timeout', revertName: null };
    };
    vi.mocked(canClaimEvaluation).mockImplementation(claimImpl as never);

    const drain = async () => {
      for await (const _ of (adapter as any).retryPendingEvaluationSolutions()) {
        // nothing claimable in this scenario
      }
    };

    // Cycle 1: both opportunities are checked.
    await drain();
    expect(canClaimEvaluation).toHaveBeenCalledTimes(2);
    // Terminal one is pruned; transient one survives.
    expect((adapter as any).pendingEvaluationSolutions.has(TERMINAL_REQUEST_ID)).toBe(false);
    expect((adapter as any).pendingEvaluationSolutions.has(TRANSIENT_REQUEST_ID)).toBe(true);

    // Cycle 2: only the transient opportunity is re-checked — terminal history is not re-scanned.
    vi.mocked(canClaimEvaluation).mockClear();
    await drain();
    expect(canClaimEvaluation).toHaveBeenCalledTimes(1);
    expect(canClaimEvaluation).toHaveBeenCalledWith(
      expect.anything(),
      TEST_CONFIG.safeAddress,
      TEST_CONFIG.routerAddress,
      '2',
      0,
      TEST_CONFIG.mechContractAddress,
    );
    expect((adapter as any).pendingEvaluationSolutions.has(TRANSIENT_REQUEST_ID)).toBe(true);

    await adapter.stop();
    // Restore the default so the persisted mockImplementation does not leak.
    vi.mocked(canClaimEvaluation).mockReset();
    vi.mocked(canClaimEvaluation).mockResolvedValue({ ok: true });
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

  // ── issue #552: watchForDeliveries chunked log scan ─────────────────────────
  // The mech adapter's delivery-polling loop must paginate `getLogs` so a
  // multi-100k-block cursor → head gap can drain without hitting RPC block-range
  // limits (Tenderly base-sepolia caps at 100k; sepolia.base.org ~1k). Before the
  // fix a single unchunked call wedged the loop for ~9 days on a live operator
  // and the cursor never advanced. Persistence must happen per chunk so a
  // mid-scan RPC failure doesn't strand the cursor.

  it('scanDeliveryLogChunks chunks getLogs when the cursor lags head by more than the chunk window', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { decodeDeliverLogs } = await import('../../../src/adapters/mech/contracts.js');
    vi.mocked(decodeDeliverLogs).mockReturnValue([]);

    const adapter = new MechAdapter(TEST_CONFIG);
    await adapter.initialize();
    const getLogs = vi.fn().mockResolvedValue([]);
    (adapter as any).publicClient.getLogs = getLogs;
    (adapter as any).deliveryBlockCursor = 0n;

    // Drive the chunked scan directly — no setTimeout / generator scheduling
    // to fight. cursor=0, head=30_000, chunk=9_999 → 3 chunks.
    for await (const _ of (adapter as any).scanDeliveryLogChunks(30_000n)) {
      // decoded is [] each chunk; nothing to process
    }

    expect(getLogs).toHaveBeenCalledTimes(3);
    const ranges = getLogs.mock.calls.map((c: unknown[]) => ({
      fromBlock: (c[0] as { fromBlock: bigint }).fromBlock,
      toBlock: (c[0] as { toBlock: bigint }).toBlock,
    }));
    expect(ranges).toEqual([
      { fromBlock: 1n, toBlock: 10_000n },
      { fromBlock: 10_001n, toBlock: 20_000n },
      { fromBlock: 20_001n, toBlock: 30_000n },
    ]);
    // Each call queries the mech contract address — must not be the router.
    for (const call of getLogs.mock.calls) {
      expect((call[0] as { address: string }).address).toBe(TEST_CONFIG.mechContractAddress);
    }
    expect((adapter as any).deliveryBlockCursor).toBe(30_000n);
  });

  it('scanDeliveryLogChunks persists per-chunk progress so a mid-scan RPC failure does not strand the cursor', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { decodeDeliverLogs } = await import('../../../src/adapters/mech/contracts.js');
    vi.mocked(decodeDeliverLogs).mockReturnValue([]);

    const store = makeConfigStore();
    const adapter = new MechAdapter(TEST_CONFIG, store as never);
    await adapter.initialize();
    const getLogs = vi.fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('query exceeds max block range 100000'));
    (adapter as any).publicClient.getLogs = getLogs;
    (adapter as any).deliveryBlockCursor = 0n;

    // Drive the chunked scan until the second chunk throws.
    await expect((async () => {
      for await (const _ of (adapter as any).scanDeliveryLogChunks(20_000n)) {
        // first chunk yields []; second chunk throws before yielding
      }
    })()).rejects.toThrow(/exceeds max block range/);

    expect(getLogs).toHaveBeenCalledTimes(2);
    // First chunk succeeded → cursor advanced to its end and was persisted.
    // Second chunk threw and the cursor was NOT advanced — partial progress is durable.
    expect((adapter as any).deliveryBlockCursor).toBe(10_000n);
    expect(store.setLastProcessedBlock).toHaveBeenCalledWith(10_000n);
    expect(store.setLastProcessedBlock).toHaveBeenCalledTimes(1);
  });

  // ── issue #553: prune evaluation opportunities whose Deliver event is gone ─
  // When the Deliver event lookup exhausts its configured lookback without
  // finding the event (e.g. the event is older than the 100k-block default,
  // which happens after a long daemon outage), the retry is deterministically
  // futile — toBlock is fixed at solution.blockNumber, so re-running the same
  // window can never start finding the event. Before the fix the solution
  // stayed in `pendingEvaluationSolutions` and logged "No Deliver event data
  // found" forever, every poll cycle.

  it('prunes a pending evaluation solution when the Deliver event is not found within the lookback', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const {
      canClaimEvaluation,
      findLatestDeliveryDataHexForRequest,
      getMarketplaceRequestDeliveryMech,
    } = await import('../../../src/adapters/mech/contracts.js');
    const { fetchFromIpfs, fetchSignedTaskFromIpfs } = await import('../../../src/adapters/mech/ipfs.js');

    vi.mocked(canClaimEvaluation).mockResolvedValueOnce({ ok: true });
    vi.mocked(getMarketplaceRequestDeliveryMech)
      .mockResolvedValueOnce(('0x' + 'aa'.repeat(20)) as `0x${string}`);
    // The lookup returns null — Deliver event is not in the lookback window.
    vi.mocked(findLatestDeliveryDataHexForRequest).mockResolvedValueOnce(null);

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
    // Solution is pruned: the retry would deterministically re-query the same
    // [333 - 100_000, 333] window with the same null result.
    expect((adapter as any).pendingEvaluationSolutions.has(REQUEST_ID)).toBe(false);
    // We never paid the IPFS fetch cost — pruning happens before that.
    expect(fetchFromIpfs).not.toHaveBeenCalled();
    // Restoration lookup did run (`getTaskCidDigest`, etc. via
    // `restorationAnnouncementForTaskId`) — that's expected: the cheap
    // claimability gate passed, so we paid the restoration lookup before
    // discovering the Deliver event is gone. Subsequent cycles will not
    // re-pay it because the solution is now pruned.
    expect(fetchSignedTaskFromIpfs).toHaveBeenCalled();
  });

  // ── issue #645: bounded retry counter for unrecoverable transient failures ─
  // The #553 immediate-prune covers the case where `deliveryEnvelopeCidForSolution`
  // returns `null`. But that requires `canClaimEvaluation` to PASS first. If the
  // earlier work *throws* (e.g. `findLatestDeliveryDataHexForRequest` throws
  // before the `null` return path is reached, as on the pre-#555 daemon), the
  // catch-arm inside `retryPendingEvaluationSolutions` swallows the error and the
  // candidate stays pending — re-logging the same failure every poll cycle
  // forever. A bounded `failedAttempts` counter forces a prune after
  // MAX_EVALUATION_RETRY_ATTEMPTS = 20 consecutive failures.

  it('prunes a pending evaluation solution after MAX_EVALUATION_RETRY_ATTEMPTS catch-arm failures', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const {
      canClaimEvaluation,
      findLatestDeliveryDataHexForRequest,
      getMarketplaceRequestDeliveryMech,
    } = await import('../../../src/adapters/mech/contracts.js');

    vi.mocked(canClaimEvaluation).mockResolvedValue({ ok: true });
    vi.mocked(getMarketplaceRequestDeliveryMech)
      .mockResolvedValue(('0x' + 'aa'.repeat(20)) as `0x${string}`);
    // `findLatestDeliveryDataHexForRequest` THROWS — this is the catch-arm path
    // inside `retryPendingEvaluationSolutions`, NOT the existing #553 null path.
    vi.mocked(findLatestDeliveryDataHexForRequest).mockRejectedValue(
      new Error('No Deliver event data found'),
    );

    const store = makeConfigStore();
    const adapter = new MechAdapter(TEST_CONFIG, store as never);
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

    // Drive the retry loop 20 times — candidate should still be present.
    for (let i = 0; i < 20; i++) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of (adapter as any).retryPendingEvaluationSolutions()) {
        // No announcements expected — the lookup always throws.
      }
    }
    expect((adapter as any).pendingEvaluationSolutions.has(REQUEST_ID)).toBe(true);
    const persistedAt20 = (adapter as any).pendingEvaluationSolutions.get(REQUEST_ID);
    expect(persistedAt20.failedAttempts).toBe(20);

    // 21st cycle: counter exceeds MAX_EVALUATION_RETRY_ATTEMPTS → prune.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of (adapter as any).retryPendingEvaluationSolutions()) {
      // still nothing yielded
    }
    expect((adapter as any).pendingEvaluationSolutions.has(REQUEST_ID)).toBe(false);

    // The counter is persisted, so a daemon restart cannot re-spam the log for
    // the same wedge: the value at prune time was already in the store.
    expect(store.setConfigValue).toHaveBeenCalledWith(
      'mech_pending_evaluation_solutions_v1',
      expect.any(String),
    );
  });

  it('prunes a pending evaluation solution after MAX_EVALUATION_RETRY_ATTEMPTS transient canClaimEvaluation failures', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { canClaimEvaluation } = await import('../../../src/adapters/mech/contracts.js');

    // Unclassified revertName → isTerminalEvaluationReason() returns false →
    // transient path → the new failedAttempts counter should increment.
    vi.mocked(canClaimEvaluation).mockResolvedValue({
      ok: false,
      reason: 'simulated transient failure',
      revertName: 'SomeUnknownRevert',
    } as never);

    const store = makeConfigStore();
    const adapter = new MechAdapter(TEST_CONFIG, store as never);
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

    for (let i = 0; i < 20; i++) {
      await (adapter as any).evaluationAnnouncementForSolution(
        (adapter as any).pendingEvaluationSolutions.get(REQUEST_ID),
      );
    }
    expect((adapter as any).pendingEvaluationSolutions.has(REQUEST_ID)).toBe(true);
    expect(
      (adapter as any).pendingEvaluationSolutions.get(REQUEST_ID).failedAttempts,
    ).toBe(20);

    // 21st call — exceeds threshold → prune.
    await (adapter as any).evaluationAnnouncementForSolution(
      (adapter as any).pendingEvaluationSolutions.get(REQUEST_ID),
    );
    expect((adapter as any).pendingEvaluationSolutions.has(REQUEST_ID)).toBe(false);
  });
});

describe('DEFAULT_TASK_DISCOVERY_FROM_BLOCK (ghost-task floor)', () => {
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
