import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MechAdapterConfig } from '../../../src/adapters/mech/types.js';
import { RESTORATION_INTENT_CID_CONTEXT_KEY } from '../../../src/restorer/impls/evaluation-context.js';

// Mock contract helpers
vi.mock('../../../src/adapters/mech/contracts.js', () => ({
  submitRestorationJob: vi.fn().mockResolvedValue({
    requestIds: ['0x' + 'aa'.repeat(32)],
    txHash: '0x' + '12'.repeat(32),
    receiptLogCount: 1,
  }),
  submitEvaluationJob: vi.fn().mockResolvedValue(['0x' + 'bb'.repeat(32)]),
  claimDelivery: vi.fn().mockResolvedValue('0x1234'),
  getMechDeliveryRate: vi.fn().mockResolvedValue(1000000n),
  getTimeoutBounds: vi.fn().mockResolvedValue({ min: 60n, max: 300n }),
  decodeMarketplaceRequestLogs: vi.fn().mockReturnValue([]),
  decodeDeliverLogs: vi.fn().mockReturnValue([]),
  callDeliverToMarketplace: vi.fn(),
  scanLatestRequestDataByRid: vi.fn().mockResolvedValue(new Map()),
  scanLatestDeliveryDataByRid: vi.fn().mockResolvedValue(new Map()),
  findLatestRequestDataHexForMarketplaceRequest: vi.fn().mockResolvedValue(null),
  findLatestDeliveryDataHexForRequest: vi.fn().mockResolvedValue(null),
  scanRestorationJobs: vi.fn().mockResolvedValue([]),
  scanEvaluationJobs: vi.fn().mockResolvedValue([]),
}));

// Mock IPFS
vi.mock('../../../src/adapters/mech/ipfs.js', () => ({
  buildRestorationJobPayload: vi.fn().mockReturnValue({ desiredStateId: 'ds-1', description: 'test' }),
  uploadToIpfs: vi.fn().mockResolvedValue('QmFakeCid'),
  cidToDigestHex: vi.fn().mockReturnValue('0x' + 'cc'.repeat(32)),
  fetchFromIpfs: vi.fn().mockResolvedValue({ data: 'result' }),
  parseRestorationJobFromPayload: vi.fn().mockReturnValue({ id: 'ds-1', description: 'test' }),
  digestHexToGatewayUrl: vi.fn(),
}));

// Mock Safe
vi.mock('../../../src/adapters/mech/safe.js', () => ({
  createClients: vi.fn().mockReturnValue({
    publicClient: {
      getBlockNumber: vi.fn().mockResolvedValue(100n),
      getLogs: vi.fn().mockResolvedValue([]),
      readContract: vi.fn(),
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

describe('MechAdapter with JinnRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('postRestorationJob calls submitRestorationJob with router address', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { submitRestorationJob } = await import('../../../src/adapters/mech/contracts.js');

    const adapter = new MechAdapter(TEST_CONFIG);
    await adapter.initialize();

    const requestId = await adapter.postRestorationJob({ id: 'ds-1', description: 'test' });

    expect(requestId).toBe('0x' + 'aa'.repeat(32));
    expect(submitRestorationJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      TEST_CONFIG.safeAddress,
      TEST_CONFIG.routerAddress,
      TEST_CONFIG.mechContractAddress,
      expect.any(String),
      expect.any(BigInt),
      expect.any(BigInt),
    );

    await adapter.stop();
  });

  it('includes router context when create returns no request ids', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { submitRestorationJob } = await import('../../../src/adapters/mech/contracts.js');

    vi.mocked(submitRestorationJob).mockResolvedValueOnce({
      requestIds: [],
      txHash: ('0x' + '99'.repeat(32)) as `0x${string}`,
      receiptLogCount: 3,
    });

    const adapter = new MechAdapter(TEST_CONFIG);
    await adapter.initialize();

    await expect(adapter.postRestorationJob({ id: 'ds-1', description: 'test' })).rejects.toThrow(
      new RegExp(`tx=0x9999.*router=${TEST_CONFIG.routerAddress}.*receiptLogs=3`),
    );

    await adapter.stop();
  });

  it('postRestorationJob does NOT call submitEvaluationJob upfront', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { submitEvaluationJob } = await import('../../../src/adapters/mech/contracts.js');

    const adapter = new MechAdapter(TEST_CONFIG);
    await adapter.initialize();

    await adapter.postRestorationJob({ id: 'ds-1', description: 'test' });

    expect(submitEvaluationJob).not.toHaveBeenCalled();

    await adapter.stop();
  });

  it('populates on-chain provenance fields from MarketplaceRequest log metadata', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { decodeMarketplaceRequestLogs } = await import('../../../src/adapters/mech/contracts.js');
    const { fetchFromIpfs, parseRestorationJobFromPayload } = await import('../../../src/adapters/mech/ipfs.js');

    const fakeTxHash = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
    const fakeBlockNumber = 42_000;
    const fakeDigest = 'cc'.repeat(32);

    vi.mocked(decodeMarketplaceRequestLogs).mockReturnValueOnce([{
      requestId: '0x' + 'aa'.repeat(32),
      requestDataHex: '0x' + fakeDigest,
      priorityMech: '0x' + '00'.repeat(20),
      transactionHash: fakeTxHash,
      blockNumber: fakeBlockNumber,
    }]);
    vi.mocked(fetchFromIpfs).mockResolvedValueOnce({ description: 'test intent' });
    vi.mocked(parseRestorationJobFromPayload).mockReturnValueOnce({ id: 'ds-prov', description: 'test intent' });

    const adapter = new MechAdapter(TEST_CONFIG);
    await adapter.initialize();

    // Advance block cursor so the poll sees new blocks
    (adapter as any).publicClient.getBlockNumber = vi.fn().mockResolvedValue(200n);
    (adapter as any).requestBlockCursor = 100n;

    const gen = adapter.watchForRequests()[Symbol.asyncIterator]();
    const { value: request } = await gen.next();

    expect(request).toBeDefined();
    expect(request!.intentCid).toBe(`f01551220${fakeDigest}`);
    expect(request!.onchainCreationTx).toBe(fakeTxHash);
    expect(request!.onchainCreationBlock).toBe(fakeBlockNumber);

    await adapter.stop();
  });

  it('preserves restoration result context across evaluation-job retries', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { submitEvaluationJob } = await import('../../../src/adapters/mech/contracts.js');
    const { buildRestorationJobPayload } = await import('../../../src/adapters/mech/ipfs.js');

    vi.mocked(submitEvaluationJob)
      .mockRejectedValueOnce(new Error('GS013'))
      .mockResolvedValueOnce(['0x' + 'bb'.repeat(32)]);

    const adapter = new MechAdapter(TEST_CONFIG);
    await adapter.initialize();

    // Stub verifyRestorationClaimed() to always report the claim is visible
    // (origin/main added a readContract poll before submitting the evaluation
    // job; without this stub the test would hit MAX_POLLS * POLL_DELAY_MS).
    (adapter as any).publicClient.readContract = vi.fn().mockResolvedValue(true);

    const requestId = '0x' + 'aa'.repeat(32);
    (adapter as any).pendingEvaluations.set(requestId, {
      id: 'ds-1',
      description: 'test',
    });

    await (adapter as any).tryCreateEvaluationJob(requestId, 'restoration output');
    await (adapter as any).tryCreateEvaluationJob(requestId);

    expect(vi.mocked(buildRestorationJobPayload)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(buildRestorationJobPayload).mock.calls[1]?.[0]).toMatchObject({
      type: 'evaluation',
      restorationRequestId: requestId,
      context: {
        restorationResult: 'restoration output',
      },
    });

    await adapter.stop();
  });

  it('defers evaluation job when restoration result is not in cache and chain backfill finds nothing', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { submitEvaluationJob, findLatestDeliveryDataHexForRequest } = await import('../../../src/adapters/mech/contracts.js');
    const { buildRestorationJobPayload } = await import('../../../src/adapters/mech/ipfs.js');

    vi.mocked(findLatestDeliveryDataHexForRequest).mockResolvedValue(null);

    const adapter = new MechAdapter(TEST_CONFIG);
    await adapter.initialize();

    const requestId = '0x' + 'aa'.repeat(32);
    (adapter as any).pendingEvaluations.set(requestId, {
      id: 'ds-1',
      description: 'test',
    });

    await (adapter as any).tryCreateEvaluationJob(requestId);

    expect(vi.mocked(buildRestorationJobPayload)).not.toHaveBeenCalled();
    expect(submitEvaluationJob).not.toHaveBeenCalled();
    expect((adapter as any).claimedButNotEvaluated.has(requestId)).toBe(true);

    await adapter.stop();
  });

  it('recoverPendingState backfills restorationIntentCid from marketplace logs', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const {
      scanRestorationJobs,
      scanEvaluationJobs,
      scanLatestRequestDataByRid,
      scanLatestDeliveryDataByRid,
    } = await import('../../../src/adapters/mech/contracts.js');

    vi.mocked(scanRestorationJobs).mockResolvedValueOnce([{ requestId: '0x' + 'aa'.repeat(32), creator: TEST_CONFIG.safeAddress }]);
    vi.mocked(scanEvaluationJobs).mockResolvedValueOnce([]);
    vi.mocked(scanLatestRequestDataByRid).mockResolvedValueOnce(new Map([
      [('0x' + 'aa'.repeat(32)).toLowerCase(), ('0x' + 'dd'.repeat(32)) as `0x${string}`],
    ]));
    vi.mocked(scanLatestDeliveryDataByRid).mockResolvedValueOnce(new Map());

    const adapter = new MechAdapter(TEST_CONFIG);
    await adapter.initialize();
    (adapter as any).store = {
      getLastProcessedBlock: () => 50n,
      setLastProcessedBlock: vi.fn(),
      savePendingEvaluation: vi.fn(),
      getPendingEvaluations: vi.fn().mockReturnValue([]),
      deletePendingEvaluation: vi.fn(),
      saveDeliveryStatus: vi.fn(),
      getDeliveryStatus: vi.fn(),
      saveAttemptToResolveClaim: vi.fn(),
      hasAttemptedToResolveClaim: vi.fn(),
    };

    (adapter as any).publicClient.readContract = vi.fn().mockResolvedValue([
      '0x' + '00'.repeat(20),
      '0x' + '00'.repeat(20),
      TEST_CONFIG.safeAddress,
      0n,
      0n,
      '0x' + '00'.repeat(32),
    ]);

    await (adapter as any).recoverPendingState(100n);

    const pending = (adapter as any).pendingEvaluations.get('0x' + 'aa'.repeat(32));
    expect(pending.context[RESTORATION_INTENT_CID_CONTEXT_KEY]).toBe(`f01551220${'dd'.repeat(32)}`);

    await adapter.stop();
  });

  it('tryCreateEvaluationJob uses chain backfill result when cache is cold', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { submitEvaluationJob, findLatestDeliveryDataHexForRequest } = await import('../../../src/adapters/mech/contracts.js');
    const { buildRestorationJobPayload, fetchFromIpfs } = await import('../../../src/adapters/mech/ipfs.js');

    vi.mocked(findLatestDeliveryDataHexForRequest).mockResolvedValueOnce(('0x' + 'ef'.repeat(32)) as `0x${string}`);
    vi.mocked(fetchFromIpfs).mockResolvedValueOnce({ data: 'backfilled restoration output' });

    const adapter = new MechAdapter(TEST_CONFIG);
    await adapter.initialize();
    (adapter as any).publicClient.readContract = vi.fn().mockResolvedValue(true);

    const requestId = '0x' + 'aa'.repeat(32);
    (adapter as any).pendingEvaluations.set(requestId, {
      id: 'ds-1',
      description: 'test',
    });

    await (adapter as any).tryCreateEvaluationJob(requestId);

    expect(vi.mocked(buildRestorationJobPayload).mock.calls.at(-1)?.[0]).toMatchObject({
      context: { restorationResult: 'backfilled restoration output' },
    });
    expect(submitEvaluationJob).toHaveBeenCalled();

    await adapter.stop();
  });
});
