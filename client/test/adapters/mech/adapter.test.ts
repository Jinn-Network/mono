import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ZodError } from 'zod';
import type { MechAdapterConfig } from '../../../src/adapters/mech/types.js';
import { RESTORATION_INTENT_CID_CONTEXT_KEY } from '../../../src/restorer/impls/evaluation-context.js';

// Mock contract helpers
// MOCK_JUSTIFICATION: src/adapters/mech/contracts.js is the I/O leaf for chain RPC calls; mocking it is mocking the boundary.
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
// MOCK_JUSTIFICATION: src/adapters/mech/ipfs.js is the I/O leaf for IPFS gateway HTTP calls; mocking it is mocking the boundary.
vi.mock('../../../src/adapters/mech/ipfs.js', () => ({
  buildRestorationJobPayload: vi.fn().mockReturnValue({ desiredStateId: 'ds-1', description: 'test' }),
  uploadToIpfs: vi.fn().mockResolvedValue('QmFakeCid'),
  cidToDigestHex: vi.fn().mockReturnValue('0x' + 'cc'.repeat(32)),
  fetchFromIpfs: vi.fn().mockResolvedValue({ data: 'result' }),
  // Default: simulate legacy (pre-envelope) IPFS data by throwing ZodError so the
  // adapter falls back to parseRestorationJobFromPayload. Tests that want to exercise
  // the signed-envelope path can override this mock per-test.
  fetchSignedIntentFromIpfs: vi.fn().mockImplementation(() => {
    throw new ZodError([]);
  }),
  fetchSignedEnvelopeFromIpfs: vi.fn().mockResolvedValue(null),
  parseRestorationJobFromPayload: vi.fn().mockReturnValue({ id: 'ds-1', description: 'test' }),
  digestHexToGatewayUrl: vi.fn(),
}));

// Mock canonical-json so hash derivation is deterministic in tests.
// MOCK_JUSTIFICATION: canonical-json is a pure transform; mocking it fixes the
// output so keccak256(JCS(...)) produces a predictable test hash.
vi.mock('../../../src/restorer/engine/canonical-json.js', () => ({
  canonicalJson: vi.fn().mockReturnValue('{"mocked":"jcs"}'),
}));

// Mock envelope types schema so SignedEnvelopeSchema.parse is controllable.
// MOCK_JUSTIFICATION: zod schema validation of the envelope shape is tested in
// envelope-assembly tests; here we only need to exercise the adapter routing logic.
vi.mock('../../../src/types/envelope.js', () => ({
  SignedEnvelopeSchema: {
    parse: vi.fn(),
  },
}));

// Mock Safe
// MOCK_JUSTIFICATION: src/adapters/mech/safe.js is the I/O leaf for Safe wallet RPC calls; mocking it is mocking the boundary.
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

  it('V2 claimDelivery uses canonical evidenceHash from store', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { claimDelivery, decodeDeliverLogs } = await import('../../../src/adapters/mech/contracts.js');
    const { fetchFromIpfs } = await import('../../../src/adapters/mech/ipfs.js');

    const canonicalHash = ('0x' + 'ca'.repeat(32)) as `0x${string}`;
    const requestId = '0x' + 'aa'.repeat(32);
    const mechAddress = ('0x' + '44'.repeat(20)).toLowerCase();

    vi.mocked(decodeDeliverLogs).mockReturnValueOnce([{
      requestId,
      deliveryDataHex: '0x' + 'dd'.repeat(32),
      mechAddress,
    }]);
    vi.mocked(fetchFromIpfs).mockResolvedValueOnce({ data: 'result' });

    const mockStore = {
      getLastProcessedBlock: () => null,
      setLastProcessedBlock: vi.fn(),
      getIntentEvidenceHash: vi.fn().mockReturnValue(canonicalHash),
    };

    const v2Config: MechAdapterConfig = { ...TEST_CONFIG, routerClaimDeliveryVariant: 'v2' };
    const adapter = new MechAdapter(v2Config, mockStore as any);
    await adapter.initialize();

    // Ensure the deliver event is picked up
    (adapter as any).publicClient.getBlockNumber = vi.fn().mockResolvedValue(200n);
    (adapter as any).deliveryBlockCursor = 100n;
    // Mark it as delivered by our safe so shouldClaimDelivery is true
    (adapter as any).pendingEvaluations.set(requestId, { id: 'ds-1', description: 'test' });

    const gen = adapter.watchForDeliveries()[Symbol.asyncIterator]();
    await gen.next();

    expect(mockStore.getIntentEvidenceHash).toHaveBeenCalledWith(requestId);
    expect(claimDelivery).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      v2Config.safeAddress,
      v2Config.routerAddress,
      requestId,
      { variant: 'v2', evidenceHash: canonicalHash },
    );

    await adapter.stop();
  });

  it('V2 claimDelivery uses undefined evidenceHash when store has no hash', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { claimDelivery, decodeDeliverLogs } = await import('../../../src/adapters/mech/contracts.js');
    const { fetchFromIpfs } = await import('../../../src/adapters/mech/ipfs.js');

    const requestId = '0x' + 'aa'.repeat(32);
    const mechAddress = ('0x' + '44'.repeat(20)).toLowerCase();

    vi.mocked(decodeDeliverLogs).mockReturnValueOnce([{
      requestId,
      deliveryDataHex: '0x' + 'dd'.repeat(32),
      mechAddress,
    }]);
    vi.mocked(fetchFromIpfs).mockResolvedValueOnce({ data: 'result' });

    const mockStore = {
      getLastProcessedBlock: () => null,
      setLastProcessedBlock: vi.fn(),
      getIntentEvidenceHash: vi.fn().mockReturnValue(null),
    };

    const v2Config: MechAdapterConfig = { ...TEST_CONFIG, routerClaimDeliveryVariant: 'v2' };
    const adapter = new MechAdapter(v2Config, mockStore as any);
    await adapter.initialize();

    (adapter as any).publicClient.getBlockNumber = vi.fn().mockResolvedValue(200n);
    (adapter as any).deliveryBlockCursor = 100n;
    (adapter as any).pendingEvaluations.set(requestId, { id: 'ds-1', description: 'test' });

    const gen = adapter.watchForDeliveries()[Symbol.asyncIterator]();
    await gen.next();

    expect(claimDelivery).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      v2Config.safeAddress,
      v2Config.routerAddress,
      requestId,
      { variant: 'v2', evidenceHash: undefined },
    );

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

  it('V2 cross-operator claimDelivery derives evidenceHash from fetched envelope', async () => {
    // Cross-operator: another mech delivered, we (creator) must claim.
    // No local store entry → adapter fetches envelope from IPFS, recomputes
    // keccak256(JCS(envelope - signature)), verifies against signature.hash,
    // then passes that hash to claimDelivery.
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { claimDelivery, decodeDeliverLogs } = await import('../../../src/adapters/mech/contracts.js');
    const { fetchSignedEnvelopeFromIpfs, fetchFromIpfs } = await import('../../../src/adapters/mech/ipfs.js');
    const { SignedEnvelopeSchema } = await import('../../../src/types/envelope.js');
    const { canonicalJson } = await import('../../../src/restorer/engine/canonical-json.js');

    const requestId = '0x' + 'aa'.repeat(32);
    const deliveryDigest = 'dd'.repeat(32);
    // mechAddress is DIFFERENT from safeAddress → cross-operator
    const otherMechAddress = '0x' + '99'.repeat(20);

    // The mocked canonicalJson returns '{"mocked":"jcs"}'; keccak256 of those
    // UTF-8 bytes produces a deterministic real hash. We set signature.hash to
    // that same value so the recomputed hash matches.
    const { keccak256 } = await import('viem');
    const jcsBytes = new TextEncoder().encode('{"mocked":"jcs"}');
    const expectedHash = keccak256(jcsBytes);

    const fakeEnvelope = {
      schemaVersion: 'jinn.execution.v1',
      kind: 'portfolio.v0',
      role: 'restoration',
      signature: { algo: 'secp256k1', signer: '0xabc', hash: expectedHash, sig: '0xsig' },
    };
    vi.mocked(fetchSignedEnvelopeFromIpfs).mockResolvedValueOnce(fakeEnvelope);
    vi.mocked((SignedEnvelopeSchema as any).parse).mockReturnValue(fakeEnvelope);
    // fetchFromIpfs mock for the eval job fetch (iCreatedRestoration path)
    vi.mocked(fetchFromIpfs).mockResolvedValueOnce({ data: 'restored' });

    vi.mocked(decodeDeliverLogs).mockReturnValueOnce([{
      requestId,
      deliveryDataHex: '0x' + deliveryDigest,
      mechAddress: otherMechAddress,
    }]);

    const v2Config: MechAdapterConfig = { ...TEST_CONFIG, routerClaimDeliveryVariant: 'v2' };
    const adapter = new MechAdapter(v2Config);
    await adapter.initialize();

    (adapter as any).publicClient.getBlockNumber = vi.fn().mockResolvedValue(200n);
    (adapter as any).deliveryBlockCursor = 100n;
    // Mark as iCreatedRestoration (we created this request)
    (adapter as any).pendingEvaluations.set(requestId, { id: 'ds-1', description: 'test' });

    const gen = adapter.watchForDeliveries()[Symbol.asyncIterator]();
    await gen.next();

    // claimDelivery must be called with the derived hash, NOT zero
    expect(claimDelivery).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      v2Config.safeAddress,
      v2Config.routerAddress,
      requestId,
      { variant: 'v2', evidenceHash: expectedHash },
    );
    expect(fetchSignedEnvelopeFromIpfs).toHaveBeenCalledWith(
      v2Config.ipfsGatewayUrl,
      `f01551220${deliveryDigest}`,
    );

    await adapter.stop();
  });

  it('V2 cross-operator claimDelivery skips claim when envelope fetch fails', async () => {
    // If IPFS is unavailable, derivation fails → skip claim, retry next loop.
    // Run the generator briefly; the skipped-claim path does not yield so we
    // stop the adapter after the first poll pass and assert claimDelivery was
    // not called.
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const { claimDelivery, decodeDeliverLogs } = await import('../../../src/adapters/mech/contracts.js');
    const { fetchSignedEnvelopeFromIpfs } = await import('../../../src/adapters/mech/ipfs.js');

    const requestId = '0x' + 'aa'.repeat(32);
    const otherMechAddress = '0x' + '99'.repeat(20);

    vi.mocked(decodeDeliverLogs).mockReturnValueOnce([{
      requestId,
      deliveryDataHex: '0x' + 'dd'.repeat(32),
      mechAddress: otherMechAddress,
    }]);
    vi.mocked(fetchSignedEnvelopeFromIpfs).mockRejectedValueOnce(
      new Error('IPFS fetch failed after all candidates'),
    );

    // Use a very short pollInterval so the loop finishes quickly
    const v2Config: MechAdapterConfig = {
      ...TEST_CONFIG,
      routerClaimDeliveryVariant: 'v2',
      pollIntervalMs: 0,
    };
    const adapter = new MechAdapter(v2Config);
    await adapter.initialize();

    (adapter as any).publicClient.getBlockNumber = vi.fn().mockResolvedValue(200n);
    (adapter as any).deliveryBlockCursor = 100n;
    (adapter as any).pendingEvaluations.set(requestId, { id: 'ds-1', description: 'test' });

    // Run the generator; stop after the first poll pass completes (the derivation
    // failure causes `continue` so no yield — we stop and check side effects).
    const gen = adapter.watchForDeliveries()[Symbol.asyncIterator]();
    // Stop the adapter immediately so the generator terminates after the first pass
    const firstPass = gen.next();
    // Give the event loop a tick for the first poll pass to execute
    await new Promise(r => setTimeout(r, 50));
    await adapter.stop();
    // The generator returns (done: true) after stop
    await firstPass;

    // claimDelivery must NOT be called when derivation fails
    expect(claimDelivery).not.toHaveBeenCalled();
  });
});
