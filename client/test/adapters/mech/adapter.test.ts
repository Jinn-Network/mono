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
});
