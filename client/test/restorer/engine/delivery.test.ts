import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock the mech adapter helpers ─────────────────────────────────────────────

// MOCK_JUSTIFICATION: src/adapters/mech/ipfs.js is the I/O leaf for IPFS gateway HTTP calls; mocking it is mocking the boundary.
vi.mock('../../../src/adapters/mech/ipfs.js', () => ({
  cidToDigestHex: vi.fn().mockReturnValue('0xdeadbeef00000000000000000000000000000000000000000000000000000000' as `0x${string}`),
  uploadToIpfs: vi.fn(),
  fetchFromIpfs: vi.fn(),
  fetchFromDigest: vi.fn(),
  digestHexToGatewayUrl: vi.fn(),
}));

// MOCK_JUSTIFICATION: src/adapters/mech/contracts.js is the I/O leaf for chain RPC calls; mocking it is mocking the boundary.
vi.mock('../../../src/adapters/mech/contracts.js', () => ({
  callDeliverToMarketplace: vi.fn().mockResolvedValue('0xdeliverytx' as `0x${string}`),
  claimDelivery: vi.fn().mockResolvedValue('0xclaimtx' as `0x${string}`),
  submitRestorationJob: vi.fn(),
  submitEvaluationJob: vi.fn(),
  claimJob: vi.fn(),
  getJobClaim: vi.fn(),
  getMechDeliveryRate: vi.fn(),
  getTimeoutBounds: vi.fn(),
  pollDeliverEvents: vi.fn(),
  decodeMarketplaceRequestLogs: vi.fn(),
  decodeDeliverLogs: vi.fn(),
  scanRestorationJobs: vi.fn(),
  scanEvaluationJobs: vi.fn(),
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('deliverAndClaim', () => {
  const mockPublicClient = {} as import('viem').PublicClient;
  const mockWalletClient = {} as import('viem').WalletClient;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeDeps(variant: 'v1' | 'v2' = 'v2') {
    return {
      publicClient: mockPublicClient,
      walletClient: mockWalletClient,
      safeAddress: '0xsafe' as `0x${string}`,
      mechContractAddress: '0xmech' as `0x${string}`,
      routerAddress: '0xrouter' as `0x${string}`,
      claimDeliveryVariant: variant,
    };
  }

  it('calls callDeliverToMarketplace with correct args', async () => {
    const { deliverAndClaim } = await import('../../../src/restorer/engine/delivery.js');
    const { callDeliverToMarketplace } = await import('../../../src/adapters/mech/contracts.js');

    await deliverAndClaim(
      '0xreq001' as `0x${string}`,
      'bafymanifest123',
      '0xevidence' as `0x${string}`,
      makeDeps(),
    );

    expect(callDeliverToMarketplace).toHaveBeenCalledOnce();
    const call = vi.mocked(callDeliverToMarketplace).mock.calls[0]!;
    expect(call[4]).toEqual(['0xreq001']); // requestIds
    // deliveryDigest comes from cidToDigestHex mock
    expect(call[5]).toEqual(['0xdeadbeef00000000000000000000000000000000000000000000000000000000']);
  });

  it('calls claimDelivery with variant v2 and evidenceHash', async () => {
    const { deliverAndClaim } = await import('../../../src/restorer/engine/delivery.js');
    const { claimDelivery } = await import('../../../src/adapters/mech/contracts.js');

    await deliverAndClaim(
      '0xreq001' as `0x${string}`,
      'bafymanifest123',
      '0xevidence' as `0x${string}`,
      makeDeps('v2'),
    );

    expect(claimDelivery).toHaveBeenCalledOnce();
    const call = vi.mocked(claimDelivery).mock.calls[0]!;
    expect(call[5]).toMatchObject({ variant: 'v2', evidenceHash: '0xevidence' });
  });

  it('calls claimDelivery with variant v1 (no evidenceHash)', async () => {
    const { deliverAndClaim } = await import('../../../src/restorer/engine/delivery.js');
    const { claimDelivery } = await import('../../../src/adapters/mech/contracts.js');

    await deliverAndClaim(
      '0xreq001' as `0x${string}`,
      'bafymanifest123',
      '0xevidence' as `0x${string}`,
      makeDeps('v1'),
    );

    expect(claimDelivery).toHaveBeenCalledOnce();
    const call = vi.mocked(claimDelivery).mock.calls[0]!;
    expect(call[5]).toMatchObject({ variant: 'v1' });
    expect(call[5].evidenceHash).toBeUndefined();
  });

  it('returns delivery and claim tx hashes', async () => {
    const { deliverAndClaim } = await import('../../../src/restorer/engine/delivery.js');
    const result = await deliverAndClaim(
      '0xreq001' as `0x${string}`,
      'bafymanifest123',
      '0xevidence' as `0x${string}`,
      makeDeps(),
    );
    expect(result.deliveryTxHash).toBe('0xdeliverytx');
    expect(result.claimTxHash).toBe('0xclaimtx');
  });

  // ── #5 crash recovery: preExistingDeliveryTxHash ──────────────────────────

  it('skips callDeliverToMarketplace when preExistingDeliveryTxHash is provided', async () => {
    const { deliverAndClaim } = await import('../../../src/restorer/engine/delivery.js');
    const { callDeliverToMarketplace, claimDelivery } = await import('../../../src/adapters/mech/contracts.js');

    const result = await deliverAndClaim(
      '0xreq001' as `0x${string}`,
      'bafymanifest123',
      '0xevidence' as `0x${string}`,
      makeDeps(),
      '0xpre-existing-deliver-tx' as `0x${string}`,
    );

    // deliverToMarketplace must NOT be called again
    expect(callDeliverToMarketplace).not.toHaveBeenCalled();
    // claimDelivery must still be called exactly once
    expect(claimDelivery).toHaveBeenCalledOnce();
    // The pre-existing hash is returned as deliveryTxHash
    expect(result.deliveryTxHash).toBe('0xpre-existing-deliver-tx');
    expect(result.claimTxHash).toBe('0xclaimtx');
  });

  it('calls onDeliveryTxLanded callback after deliverToMarketplace succeeds', async () => {
    const { deliverAndClaim } = await import('../../../src/restorer/engine/delivery.js');
    const { callDeliverToMarketplace } = await import('../../../src/adapters/mech/contracts.js');
    vi.mocked(callDeliverToMarketplace).mockResolvedValue('0xdeliverytx2' as `0x${string}`);

    const onLanded = vi.fn();

    await deliverAndClaim(
      '0xreq001' as `0x${string}`,
      'bafymanifest123',
      '0xevidence' as `0x${string}`,
      makeDeps(),
      undefined,
      onLanded,
    );

    expect(onLanded).toHaveBeenCalledOnce();
    expect(onLanded).toHaveBeenCalledWith('0xdeliverytx2');
  });

  it('does NOT call onDeliveryTxLanded when preExistingDeliveryTxHash is provided', async () => {
    const { deliverAndClaim } = await import('../../../src/restorer/engine/delivery.js');
    const onLanded = vi.fn();

    await deliverAndClaim(
      '0xreq001' as `0x${string}`,
      'bafymanifest123',
      '0xevidence' as `0x${string}`,
      makeDeps(),
      '0xpre-existing' as `0x${string}`,
      onLanded,
    );

    expect(onLanded).not.toHaveBeenCalled();
  });
});
