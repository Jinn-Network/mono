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
  findLatestDeliveryForRequest: vi.fn(),
  submitTask: vi.fn(),
  submitEvaluationJob: vi.fn(),
  claimJob: vi.fn(),
  getJobClaim: vi.fn(),
  getMechDeliveryRate: vi.fn(),
  getTimeoutBounds: vi.fn(),
  pollDeliverEvents: vi.fn(),
  decodeMarketplaceRequestLogs: vi.fn(),
  decodeDeliverLogs: vi.fn(),
  scanTasks: vi.fn(),
  scanEvaluationJobs: vi.fn(),
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('deliverAndClaim', () => {
  const mockPublicClient = {} as import('viem').PublicClient;
  const mockWalletClient = {} as import('viem').WalletClient;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeDeps(variant: 'v1' | 'v2' | 'v3' = 'v2') {
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
    const { deliverAndClaim } = await import('../../../src/harnesses/engine/delivery.js');
    const { callDeliverToMarketplace } = await import('../../../src/adapters/mech/contracts.js');

    await deliverAndClaim(
      '0xreq001' as `0x${string}`,
      'bafymanifest123',
      '0xevidence' as `0x${string}`,
      makeDeps(),
    );

    expect(callDeliverToMarketplace).toHaveBeenCalledOnce();
    const call = vi.mocked(callDeliverToMarketplace).mock.calls[0]!;
    expect(call[5]).toEqual(['0xreq001']); // requestIds
    // deliveryDigest comes from cidToDigestHex mock
    expect(call[6]).toEqual(['0xdeadbeef00000000000000000000000000000000000000000000000000000000']);
  });

  it('calls claimDelivery with variant v2 and evidenceHash', async () => {
    const { deliverAndClaim } = await import('../../../src/harnesses/engine/delivery.js');
    const { claimDelivery } = await import('../../../src/adapters/mech/contracts.js');

    await deliverAndClaim(
      '0xreq001' as `0x${string}`,
      'bafymanifest123',
      '0xevidence' as `0x${string}`,
      makeDeps('v2'),
    );

    expect(claimDelivery).toHaveBeenCalledOnce();
    const call = vi.mocked(claimDelivery).mock.calls[0]!;
    expect(call[6]).toMatchObject({ variant: 'v2', evidenceHash: '0xevidence' });
  });

  it('passes verdict settlement options for V3 evaluation deliveries', async () => {
    const { deliverAndClaim } = await import('../../../src/harnesses/engine/delivery.js');
    const { claimDelivery } = await import('../../../src/adapters/mech/contracts.js');

    await deliverAndClaim(
      '0xreq001' as `0x${string}`,
      'bafymanifest123',
      '0xevidence' as `0x${string}`,
      makeDeps('v3'),
      undefined,
      undefined,
      { kind: 'verdict', verdictCode: 2 },
    );

    expect(claimDelivery).toHaveBeenCalledOnce();
    const call = vi.mocked(claimDelivery).mock.calls[0]!;
    expect(call[6]).toMatchObject({
      variant: 'v3',
      kind: 'verdict',
      evidenceHash: '0xevidence',
      verdictCode: 2,
    });
  });

  it('calls claimDelivery with variant v1 (no evidenceHash)', async () => {
    const { deliverAndClaim } = await import('../../../src/harnesses/engine/delivery.js');
    const { claimDelivery } = await import('../../../src/adapters/mech/contracts.js');

    await deliverAndClaim(
      '0xreq001' as `0x${string}`,
      'bafymanifest123',
      '0xevidence' as `0x${string}`,
      makeDeps('v1'),
    );

    expect(claimDelivery).toHaveBeenCalledOnce();
    const call = vi.mocked(claimDelivery).mock.calls[0]!;
    expect(call[6]).toMatchObject({ variant: 'v1' });
    expect(call[5].evidenceHash).toBeUndefined();
  });

  it('returns delivery and claim tx hashes', async () => {
    const { deliverAndClaim } = await import('../../../src/harnesses/engine/delivery.js');
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
    const { deliverAndClaim } = await import('../../../src/harnesses/engine/delivery.js');
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
    const { deliverAndClaim } = await import('../../../src/harnesses/engine/delivery.js');
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
    const { deliverAndClaim } = await import('../../../src/harnesses/engine/delivery.js');
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

describe('split delivery operations', () => {
  const mockPublicClient = {} as import('viem').PublicClient;
  const mockWalletClient = {} as import('viem').WalletClient;
  const deps = {
    publicClient: mockPublicClient,
    walletClient: mockWalletClient,
    safeAddress: '0xsafe' as `0x${string}`,
    mechContractAddress: '0xmech' as `0x${string}`,
    routerAddress: '0xrouter' as `0x${string}`,
    claimDeliveryVariant: 'v3' as const,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Mech-delivers without claiming the Router delivery', async () => {
    const { deliverToMarketplace } = await import('../../../src/harnesses/engine/delivery.js');
    const { callDeliverToMarketplace, claimDelivery } = await import('../../../src/adapters/mech/contracts.js');
    vi.mocked(callDeliverToMarketplace).mockResolvedValue('0xdeliverytx' as `0x${string}`);

    const result = await deliverToMarketplace(
      '0xreq001' as `0x${string}`,
      'bafymanifest123',
      deps,
    );

    expect(result).toEqual({
      deliveryTxHash: '0xdeliverytx',
      deliveryDigest: '0xdeadbeef00000000000000000000000000000000000000000000000000000000',
    });
    expect(callDeliverToMarketplace).toHaveBeenCalledOnce();
    expect(claimDelivery).not.toHaveBeenCalled();
  });

  it('claims the Router delivery without Mech-delivering', async () => {
    const { claimRouterDelivery } = await import('../../../src/harnesses/engine/delivery.js');
    const { callDeliverToMarketplace, claimDelivery } = await import('../../../src/adapters/mech/contracts.js');

    const claimTxHash = await claimRouterDelivery(
      '0xreq001' as `0x${string}`,
      '0xevidence' as `0x${string}`,
      deps,
      { kind: 'verdict', verdictCode: 2 },
    );

    expect(claimTxHash).toBe('0xclaimtx');
    expect(callDeliverToMarketplace).not.toHaveBeenCalled();
    expect(claimDelivery).toHaveBeenCalledOnce();
  });
});

describe('exact marketplace delivery recovery', () => {
  const expected = {
    requestId: '0xreq001' as `0x${string}`,
    manifestCid: 'bafymanifest123',
    deliveryDigest: '0xdeadbeef00000000000000000000000000000000000000000000000000000000' as `0x${string}`,
    evidenceHash: '0xevidence' as `0x${string}`,
    role: 'solution' as const,
    fromBlock: 100n,
  };

  function projection(overrides: Record<string, unknown> = {}) {
    return {
      requestId: expected.requestId,
      envelopeCid: expected.manifestCid,
      signatureHash: expected.evidenceHash,
      role: expected.role,
      ...overrides,
    };
  }

  async function makeRecovery(overrides: Record<string, unknown> = {}) {
    const delivery = await import('../../../src/harnesses/engine/delivery.js');
    const store = {
      queryEnvelopeProjections: vi.fn().mockReturnValue([
        projection(overrides),
      ]),
    };
    const publicClient = {
      getBlockNumber: vi.fn().mockResolvedValue(200n),
    } as unknown as import('viem').PublicClient;
    const recovery = delivery.createMarketplaceDeliveryRecovery({
      publicClient,
      mechContractAddress: '0xmech' as `0x${string}`,
      safeAddress: '0xsafe' as `0x${string}`,
      store,
    });
    return { recovery, store, publicClient };
  }

  beforeEach(async () => {
    const { findLatestDeliveryForRequest } = await import(
      '../../../src/adapters/mech/contracts.js'
    );
    vi.mocked(findLatestDeliveryForRequest).mockReset();
  });

  it('returns exact tx and envelope metadata for a matching Mech Deliver event', async () => {
    const { findLatestDeliveryForRequest } = await import(
      '../../../src/adapters/mech/contracts.js'
    );
    vi.mocked(findLatestDeliveryForRequest).mockResolvedValue({
      requestId: expected.requestId,
      deliveryDataHex: expected.deliveryDigest,
      transactionHash: '0xdeliverytx' as `0x${string}`,
      mechAddress: '0xsafe',
      blockNumber: 150n,
    });
    const { recovery } = await makeRecovery();

    await expect(recovery.resolveExistingDelivery(expected)).resolves.toEqual({
      state: 'matching',
      ...expected,
      deliveryTxHash: '0xdeliverytx',
    });
    expect(findLatestDeliveryForRequest).toHaveBeenCalledWith(
      expect.anything(),
      '0xmech',
      expected.requestId,
      100n,
      200n,
    );
  });

  it.each([
    ['role', { role: 'verdict' }],
    ['evidence', { signatureHash: '0xwrong-evidence' }],
  ])('fails closed when the persisted envelope %s contradicts expectations', async (
    _field,
    override,
  ) => {
    const { recovery } = await makeRecovery(override);

    await expect(recovery.resolveExistingDelivery(expected)).resolves.toMatchObject({
      state: 'contradictory',
    });
  });

  it('fails closed when the on-chain delivery digest contradicts the envelope', async () => {
    const { findLatestDeliveryForRequest } = await import(
      '../../../src/adapters/mech/contracts.js'
    );
    vi.mocked(findLatestDeliveryForRequest).mockResolvedValue({
      requestId: expected.requestId,
      deliveryDataHex: '0xwrong-digest',
      transactionHash: '0xdeliverytx' as `0x${string}`,
      mechAddress: '0xsafe',
      blockNumber: 150n,
    });
    const { recovery } = await makeRecovery();

    await expect(recovery.resolveExistingDelivery(expected)).resolves.toMatchObject({
      state: 'contradictory',
    });
  });

  it('reports authoritative absence only after scanning through the latest block', async () => {
    const { findLatestDeliveryForRequest } = await import(
      '../../../src/adapters/mech/contracts.js'
    );
    vi.mocked(findLatestDeliveryForRequest).mockResolvedValue(null);
    const { recovery } = await makeRecovery();

    await expect(recovery.resolveExistingDelivery(expected)).resolves.toEqual({
      state: 'absent',
    });
  });
});
