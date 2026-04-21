import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MechAdapterConfig } from '../../../src/adapters/mech/types.js';

// Mock contract helpers
vi.mock('../../../src/adapters/mech/contracts.js', () => ({
  submitRestorationJob: vi.fn().mockResolvedValue(['0x' + 'aa'.repeat(32)]),
  submitEvaluationJob: vi.fn().mockResolvedValue(['0x' + 'bb'.repeat(32)]),
  claimDelivery: vi.fn().mockResolvedValue('0x1234'),
  getMechDeliveryRate: vi.fn().mockResolvedValue(1000000n),
  getTimeoutBounds: vi.fn().mockResolvedValue({ min: 60n, max: 300n }),
  decodeMarketplaceRequestLogs: vi.fn().mockReturnValue([]),
  decodeDeliverLogs: vi.fn().mockReturnValue([]),
  callDeliverToMarketplace: vi.fn(),
}));

// Mock IPFS
vi.mock('../../../src/adapters/mech/ipfs.js', () => ({
  buildDesiredStatePayload: vi.fn().mockReturnValue({ desiredStateId: 'ds-1', description: 'test' }),
  uploadToIpfs: vi.fn().mockResolvedValue('QmFakeCid'),
  cidToDigestHex: vi.fn().mockReturnValue('0x' + 'cc'.repeat(32)),
  fetchFromIpfs: vi.fn().mockResolvedValue({ data: 'result' }),
  parseDesiredStateFromPayload: vi.fn().mockReturnValue({ id: 'ds-1', description: 'test' }),
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

  it('postDesiredState calls submitRestorationJob with router address', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { submitRestorationJob } = await import('../../../src/adapters/mech/contracts.js');

    const adapter = new MechAdapter(TEST_CONFIG);
    await adapter.initialize();

    const requestId = await adapter.postDesiredState({ id: 'ds-1', description: 'test' });

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

  it('postDesiredState does NOT call submitEvaluationJob upfront', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { submitEvaluationJob } = await import('../../../src/adapters/mech/contracts.js');

    const adapter = new MechAdapter(TEST_CONFIG);
    await adapter.initialize();

    await adapter.postDesiredState({ id: 'ds-1', description: 'test' });

    expect(submitEvaluationJob).not.toHaveBeenCalled();

    await adapter.stop();
  });

  it('populates on-chain provenance fields from MarketplaceRequest log metadata', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { decodeMarketplaceRequestLogs } = await import('../../../src/adapters/mech/contracts.js');
    const { fetchFromIpfs, parseDesiredStateFromPayload } = await import('../../../src/adapters/mech/ipfs.js');

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
    vi.mocked(parseDesiredStateFromPayload).mockReturnValueOnce({ id: 'ds-prov', description: 'test intent' });

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
    const { buildDesiredStatePayload } = await import('../../../src/adapters/mech/ipfs.js');

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

    expect(vi.mocked(buildDesiredStatePayload)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(buildDesiredStatePayload).mock.calls[1]?.[0]).toMatchObject({
      type: 'evaluation',
      restorationRequestId: requestId,
      context: {
        restorationResult: 'restoration output',
      },
    });

    await adapter.stop();
  });
});
