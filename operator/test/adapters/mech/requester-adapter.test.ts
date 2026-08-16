import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MechAdapterConfig } from '../../../src/adapters/mech/types.js';

// The requester adapter is the extracted requester slice of MechAdapter: the
// only surface the legacy `jinn tasks submit` CLI (cli/execution-context.ts)
// needs after adapter.ts retires in Phase D. These tests pin its posting
// behavior against the same chain/IPFS boundary the full adapter mocks, so the
// extraction is provably behavior-identical for postTask / recoverTaskPost.

const HOISTED = vi.hoisted(() => {
  const TASK_CID_DIGEST = ('0x' + 'cc'.repeat(32)) as `0x${string}`;
  const TASK_CID = `f01551220${'cc'.repeat(32)}`;
  const MANIFEST_DIGEST = ('0x' + '99'.repeat(32)) as `0x${string}`;
  const TX_HASH = ('0x' + '12'.repeat(32)) as `0x${string}`;
  return { TASK_CID_DIGEST, TASK_CID, MANIFEST_DIGEST, TX_HASH };
});
const { TASK_CID_DIGEST, TASK_CID, MANIFEST_DIGEST, TX_HASH } = HOISTED;

// MOCK_JUSTIFICATION: src/adapters/mech/contracts.js is the I/O leaf for chain RPC calls; mocking it is mocking the boundary.
vi.mock('../../../src/adapters/mech/contracts.js', () => ({
  submitTask: vi.fn().mockResolvedValue({
    taskId: '1',
    txHash: TX_HASH,
    receiptLogCount: 1,
    blockNumber: 123,
  }),
  getMechDeliveryRate: vi.fn().mockResolvedValue(1000000n),
  getTimeoutBounds: vi.fn().mockResolvedValue({ min: 60n, max: 300n }),
  scanTasks: vi.fn().mockResolvedValue([]),
  PendingTaskSubmissionError: class PendingTaskSubmissionError extends Error {},
}));

// MOCK_JUSTIFICATION: src/adapters/mech/ipfs.js is the I/O leaf for IPFS gateway HTTP calls; mocking it is mocking the boundary.
vi.mock('../../../src/adapters/mech/ipfs.js', () => ({
  uploadToIpfs: vi.fn().mockResolvedValue('QmFakeCid'),
  cidToDigestHex: vi.fn().mockReturnValue(TASK_CID_DIGEST),
}));

// MOCK_JUSTIFICATION: digest.js is a pure CID-to-digest transform; mocking it pins the output so manifest-filter assertions use a deterministic digest.
vi.mock('../../../src/adapters/mech/digest.js', () => ({
  manifestDigestForCid: vi.fn().mockReturnValue(MANIFEST_DIGEST),
}));

// MOCK_JUSTIFICATION: src/adapters/mech/safe.js is the Safe/RPC I/O leaf; mocking it is mocking the boundary.
vi.mock('../../../src/adapters/mech/safe.js', () => ({
  createClients: vi.fn().mockReturnValue({
    publicClient: {
      getBlockNumber: vi.fn().mockResolvedValue(100n),
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

describe('MechRequesterAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('postTask uploads a signed task.v1 document and calls createTask', async () => {
    const { MechRequesterAdapter } = await import('../../../src/adapters/mech/requester-adapter.js');
    const { submitTask } = await import('../../../src/adapters/mech/contracts.js');
    const { uploadToIpfs } = await import('../../../src/adapters/mech/ipfs.js');

    const adapter = new MechRequesterAdapter(TEST_CONFIG);
    await adapter.initialize();
    const onTransactionHash = vi.fn();
    const beforeBroadcast = vi.fn();

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
    }, {
      onTransactionHash,
      beforeBroadcast,
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
    // Task 24: on-chain manifestDigest is keccak256(toBytes(manifestCid)).
    const { keccak256, toBytes } = await import('viem');
    const expectedManifestDigest = keccak256(toBytes('bafyfixturecid'));
    expect(submitTask).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      undefined,
      TEST_CONFIG.safeAddress,
      TEST_CONFIG.routerAddress,
      TASK_CID_DIGEST,
      expectedManifestDigest,
      // Mainnet (chainId 8453) + no explicit flag ⇒ self-eval defaults false.
      expect.objectContaining({
        maxClaims: 25,
        allowSolverSelfEvaluation: false,
      }),
      1000000n,
      1000000n,
      300n,
      undefined,
      onTransactionHash,
      beforeBroadcast,
    );
  });

  it('postTask refuses to sign and post a Task without solverNetManifestCid', async () => {
    const { MechRequesterAdapter } = await import('../../../src/adapters/mech/requester-adapter.js');
    const adapter = new MechRequesterAdapter(TEST_CONFIG);
    await adapter.initialize();
    await expect(
      adapter.postTask({
        id: 'no-manifest',
        description: 'missing manifest cid',
        solverType: 'prediction.v1',
        contractId: 'prediction',
        contractVersion: 'v1',
      }),
    ).rejects.toThrow(/solverNetManifestCid/);
  });

  it('recoverTaskPost returns null when no matching TaskCreated event exists', async () => {
    const { MechRequesterAdapter } = await import('../../../src/adapters/mech/requester-adapter.js');
    const { scanTasks } = await import('../../../src/adapters/mech/contracts.js');
    (scanTasks as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    const adapter = new MechRequesterAdapter(TEST_CONFIG);
    await adapter.initialize();
    const recovered = await adapter.recoverTaskPost({
      creatorSafeAddress: TEST_CONFIG.safeAddress,
      signedTask: {
        schemaVersion: 'task.v1',
        id: 'prediction-task-1',
        solverType: 'prediction.v1',
        contractId: 'prediction',
        contractVersion: 'v1',
        solverNetManifestCid: 'bafyfixturecid',
        role: 'restoration',
        description: 'desc',
        window: { startTs: 0, endTs: 1 },
        spec: {},
        eligibility: {},
        claimPolicy: { mode: 'exclusive', maxClaims: 1, maxClaimsPerOperator: 1, claimLeaseTtlSeconds: 600 },
        creator: {
          safeAddress: TEST_CONFIG.safeAddress,
          agentEoa: '0x2222222222222222222222222222222222222222',
        },
        createdAt: 0,
        signature: {
          algo: 'secp256k1',
          signer: '0x2222222222222222222222222222222222222222',
          hash: '0x' + 'ab'.repeat(32),
          sig: '0x' + 'cd'.repeat(65),
        },
      },
    });
    expect(recovered).toBeNull();
  });

  it('is a requester-only adapter: harness/evaluation methods are unsupported', async () => {
    const { MechRequesterAdapter } = await import('../../../src/adapters/mech/requester-adapter.js');
    const adapter = new MechRequesterAdapter(TEST_CONFIG);
    await adapter.initialize();

    await expect(adapter.claimTask('task-1')).rejects.toThrow(/requester-only/);
    await expect(
      adapter.submitResult('0xrequest' as never, { data: 'x' } as never),
    ).rejects.toThrow(/requester-only/);
    await expect(async () => {
      for await (const _ of adapter.watchForTasks()) { /* unreachable */ }
    }).rejects.toThrow(/requester-only/);
    // stop() is a benign no-op so CLI teardown never throws.
    await expect(adapter.stop()).resolves.toBeUndefined();
  });
});
