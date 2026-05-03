import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MechAdapterConfig } from '../../../src/adapters/mech/types.js';
import type { SignedTaskV1 } from '../../../src/types/task-document.js';

const HOISTED = vi.hoisted(() => {
  const REQUEST_ID = ('0x' + 'aa'.repeat(32)) as `0x${string}`;
  const TASK_CID_DIGEST = ('0x' + 'cc'.repeat(32)) as `0x${string}`;
  const TASK_CID = `f01551220${'cc'.repeat(32)}`;
  const TX_HASH = ('0x' + '12'.repeat(32)) as `0x${string}`;
  const signedTask = (overrides: Partial<SignedTaskV1> = {}): SignedTaskV1 => ({
    schemaVersion: 'task.v1',
    id: 'prediction-task-1',
    solverType: 'prediction.v1',
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
  return { REQUEST_ID, TASK_CID_DIGEST, TASK_CID, TX_HASH, signedTask };
});

const { REQUEST_ID, TASK_CID_DIGEST, TASK_CID, TX_HASH, signedTask } = HOISTED;

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

// MOCK_JUSTIFICATION: canonical-json is a pure transform; mocking it fixes the output for deterministic evidence hash assertions.
vi.mock('../../../src/harnesses/engine/canonical-json.js', () => ({
  canonicalJson: vi.fn().mockReturnValue('{"mocked":"jcs"}'),
}));

// MOCK_JUSTIFICATION: envelope schema validation is covered in envelope tests; here we isolate adapter routing logic.
vi.mock('../../../src/types/envelope.js', () => ({
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
        claimPolicy: expect.objectContaining({ maxClaims: 25 }),
      }),
    );
    expect(submitTask).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      TEST_CONFIG.safeAddress,
      TEST_CONFIG.routerAddress,
      TASK_CID_DIGEST,
      expect.any(String),
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

  it('watchForTasks yields signed TaskCreated announcements', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { decodeTaskCreatedLogs } = await import('../../../src/adapters/mech/contracts.js');
    const { fetchSignedTaskFromIpfs } = await import('../../../src/adapters/mech/ipfs.js');

    vi.mocked(decodeTaskCreatedLogs).mockReturnValueOnce([{
      taskId: '7',
      taskCidDigest: TASK_CID_DIGEST,
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

  it('watchForTasks yields evaluation opportunities and claimTask claims them as evaluator work', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const {
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
      restorationEnvelopeCid: TASK_CID,
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

  it('uses a full delivery-log scan by default for delayed SolutionDeliveryClaimed events', async () => {
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
      blockNumber: 25_000,
    }]);
    vi.mocked(fetchFromIpfs).mockResolvedValueOnce({ data: 'solution payload' });
    vi.mocked(fetchSignedTaskFromIpfs).mockResolvedValueOnce(signedTask({ id: 'watched-task' }));

    const adapter = new MechAdapter(TEST_CONFIG);
    await adapter.initialize();
    (adapter as any).publicClient.getBlockNumber = vi.fn().mockResolvedValue(25_001n);
    (adapter as any).publicClient.getLogs = vi.fn().mockResolvedValue([{ data: '0x', topics: [] }]);
    (adapter as any).requestBlockCursor = 24_999n;

    const gen = adapter.watchForTasks()[Symbol.asyncIterator]();
    const { value } = await gen.next();

    expect(value!.task.role).toBe('evaluation');
    expect(findLatestDeliveryDataHexForRequest).toHaveBeenCalledWith(
      expect.anything(),
      solverMech,
      REQUEST_ID,
      0n,
      25_000n,
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
      role: 'restoration',
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
      role: 'restoration',
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
});
