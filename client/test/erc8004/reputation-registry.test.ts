import { describe, it, expect, vi, beforeEach } from 'vitest';
import { decodeFunctionData, type PublicClient, type WalletClient } from 'viem';

// MOCK_JUSTIFICATION: src/adapters/mech/safe.js is the I/O leaf for Safe-routed
// txs (calls into the Safe protocol-kit + RPC). Mocking it isolates the
// reputation client from Safe internals.
vi.mock('../../src/adapters/mech/safe.js', () => ({
  executeSafeTransaction: vi.fn().mockResolvedValue('0xsafe-tx-hash' as `0x${string}`),
}));

// MOCK_JUSTIFICATION: tx-retry uses fake-timer-unfriendly waiters; for unit
// tests we just resolve immediately.
vi.mock('../../src/tx-retry.js', () => ({
  waitForTransactionReceiptWithRetry: vi.fn().mockResolvedValue({
    transactionHash: '0xreceipt',
    status: 'success',
    logs: [],
  }),
  isRecoverableTransactionError: vi.fn().mockReturnValue(false),
  backoffDelay: vi.fn().mockResolvedValue(undefined),
  // Passthrough — the serializer's ordering is exercised in the dedicated
  // tx-retry tests; here we only need the wrapped fn to run.
  withEoaBroadcastLock: vi.fn(<T>(_from: unknown, fn: () => Promise<T>) => fn()),
}));

const REPUTATION_ADDRESS = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63' as `0x${string}`;
const RESTORER_AGENT_ID = 42n;
const EVALUATOR_ADDRESS = '0xeeee000000000000000000000000000000000001' as `0x${string}`;
const SAFE_ADDRESS = '0x5afe000000000000000000000000000000000001' as `0x${string}`;
const MANIFEST_CID = 'bafyrestoredmanifest123';
const EVIDENCE_HASH =
  '0xfeedfacedeadbeef00000000000000000000000000000000000000000000beef' as `0x${string}`;

function makePublicClient(overrides: Partial<PublicClient> = {}): PublicClient {
  return {
    readContract: vi.fn(),
    ...overrides,
  } as unknown as PublicClient;
}

function makeWalletClient(overrides: Partial<WalletClient> = {}): WalletClient {
  return {
    account: { address: EVALUATOR_ADDRESS },
    sendTransaction: vi.fn().mockResolvedValue('0xeoa-tx-hash' as `0x${string}`),
    chain: { id: 8453 },
    ...overrides,
  } as unknown as WalletClient;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('REPUTATION_REGISTRY_ADDRESSES', () => {
  it('has canonical Base mainnet + Base Sepolia addresses', async () => {
    const { REPUTATION_REGISTRY_ADDRESSES, getReputationRegistryAddress } = await import(
      '../../src/erc8004/reputation.js'
    );
    expect(REPUTATION_REGISTRY_ADDRESSES[8453]).toBe('0x8004BAa17C55a88189AE136b182e5fdA19dE9b63');
    expect(REPUTATION_REGISTRY_ADDRESSES[84532]).toBe('0x8004B663056A597Dffe9eCcC1965A193B7388713');
    expect(getReputationRegistryAddress(8453)).toBe('0x8004BAa17C55a88189AE136b182e5fdA19dE9b63');
    expect(getReputationRegistryAddress(999)).toBeNull();
  });
});

describe('ReputationRegistryClient.giveFeedback (calldata + routing)', () => {
  it('encodes giveFeedback with canonical body convention (manifest:<cid> + manifestHash)', async () => {
    const { ReputationRegistryClient, REPUTATION_REGISTRY_ABI } = await import(
      '../../src/erc8004/reputation.js'
    );
    const { executeSafeTransaction } = await import('../../src/adapters/mech/safe.js');

    const publicClient = makePublicClient();
    const walletClient = makeWalletClient();

    const client = new ReputationRegistryClient({
      reputationRegistryAddress: REPUTATION_ADDRESS,
      publicClient,
      walletClient,
      safeAddress: SAFE_ADDRESS,
    });

    const txHash = await client.giveFeedback({
      harnessAgentId: RESTORER_AGENT_ID,
      score: 100,
      scoreDecimals: 2,
      manifestRef: `manifest:${MANIFEST_CID}`,
      manifestHash: EVIDENCE_HASH,
      tag1: 'portfolio.v0',
    });

    expect(txHash).toBe('0xsafe-tx-hash');
    expect(executeSafeTransaction).toHaveBeenCalledOnce();
    const params = vi.mocked(executeSafeTransaction).mock.calls[0]![2];
    expect(params.safeAddress).toBe(SAFE_ADDRESS);
    expect(params.to).toBe(REPUTATION_ADDRESS);
    expect(params.value).toBe(0n);

    // Decode calldata to verify args wire through to the on-chain function.
    const decoded = decodeFunctionData({
      abi: REPUTATION_REGISTRY_ABI,
      data: params.data,
    });
    expect(decoded.functionName).toBe('giveFeedback');
    const [agentId, value, valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash] =
      decoded.args as [bigint, bigint, number, string, string, string, string, `0x${string}`];
    expect(agentId).toBe(RESTORER_AGENT_ID);
    expect(value).toBe(100n);
    expect(valueDecimals).toBe(2);
    expect(tag1).toBe('portfolio.v0');
    expect(tag2).toBe('');
    expect(endpoint).toBe('');
    expect(feedbackURI).toBe(`manifest:${MANIFEST_CID}`);
    expect(feedbackHash).toBe(EVIDENCE_HASH);
  });

  it('routes through Safe when safeAddress is configured', async () => {
    const { ReputationRegistryClient } = await import('../../src/erc8004/reputation.js');
    const { executeSafeTransaction } = await import('../../src/adapters/mech/safe.js');

    const walletClient = makeWalletClient();
    const client = new ReputationRegistryClient({
      reputationRegistryAddress: REPUTATION_ADDRESS,
      publicClient: makePublicClient(),
      walletClient,
      safeAddress: SAFE_ADDRESS,
    });

    await client.giveFeedback({
      harnessAgentId: RESTORER_AGENT_ID,
      score: 100,
      scoreDecimals: 2,
      manifestRef: `manifest:${MANIFEST_CID}`,
      manifestHash: EVIDENCE_HASH,
    });

    expect(executeSafeTransaction).toHaveBeenCalledOnce();
    expect(walletClient.sendTransaction).not.toHaveBeenCalled();
  });

  it('falls back to direct EOA send when safeAddress is absent', async () => {
    const { ReputationRegistryClient } = await import('../../src/erc8004/reputation.js');
    const { executeSafeTransaction } = await import('../../src/adapters/mech/safe.js');

    const walletClient = makeWalletClient();
    const client = new ReputationRegistryClient({
      reputationRegistryAddress: REPUTATION_ADDRESS,
      publicClient: makePublicClient(),
      walletClient,
    });

    const txHash = await client.giveFeedback({
      harnessAgentId: RESTORER_AGENT_ID,
      score: 0,
      scoreDecimals: 2,
      manifestRef: `manifest:${MANIFEST_CID}`,
      manifestHash: EVIDENCE_HASH,
    });

    expect(executeSafeTransaction).not.toHaveBeenCalled();
    expect(walletClient.sendTransaction).toHaveBeenCalledOnce();
    expect(txHash).toBe('0xeoa-tx-hash');
  });

  it('throws when called without a wallet client', async () => {
    const { ReputationRegistryClient } = await import('../../src/erc8004/reputation.js');
    const client = new ReputationRegistryClient({
      reputationRegistryAddress: REPUTATION_ADDRESS,
      publicClient: makePublicClient(),
    });
    await expect(
      client.giveFeedback({
        harnessAgentId: RESTORER_AGENT_ID,
        score: 100,
        scoreDecimals: 2,
        manifestRef: `manifest:${MANIFEST_CID}`,
        manifestHash: EVIDENCE_HASH,
      }),
    ).rejects.toThrow(/walletClient required/);
  });

  it('encodes endpoint + tag2 when supplied', async () => {
    const { ReputationRegistryClient, REPUTATION_REGISTRY_ABI } = await import(
      '../../src/erc8004/reputation.js'
    );
    const { executeSafeTransaction } = await import('../../src/adapters/mech/safe.js');

    const client = new ReputationRegistryClient({
      reputationRegistryAddress: REPUTATION_ADDRESS,
      publicClient: makePublicClient(),
      walletClient: makeWalletClient(),
      safeAddress: SAFE_ADDRESS,
    });

    await client.giveFeedback({
      harnessAgentId: RESTORER_AGENT_ID,
      score: 100,
      scoreDecimals: 2,
      manifestRef: `manifest:${MANIFEST_CID}`,
      manifestHash: EVIDENCE_HASH,
      tag1: 'portfolio.v0',
      tag2: 'evaluator-v1.2',
      endpoint: 'https://eval.example/.well-known/agent.json',
    });

    const params = vi.mocked(executeSafeTransaction).mock.calls[0]![2];
    const decoded = decodeFunctionData({ abi: REPUTATION_REGISTRY_ABI, data: params.data });
    const args = decoded.args as [bigint, bigint, number, string, string, string, string, string];
    expect(args[3]).toBe('portfolio.v0');
    expect(args[4]).toBe('evaluator-v1.2');
    expect(args[5]).toBe('https://eval.example/.well-known/agent.json');
  });
});

describe('ReputationRegistryClient.revokeFeedback / respondToFeedback', () => {
  it('encodes revokeFeedback calldata', async () => {
    const { ReputationRegistryClient, REPUTATION_REGISTRY_ABI } = await import(
      '../../src/erc8004/reputation.js'
    );
    const { executeSafeTransaction } = await import('../../src/adapters/mech/safe.js');

    const client = new ReputationRegistryClient({
      reputationRegistryAddress: REPUTATION_ADDRESS,
      publicClient: makePublicClient(),
      walletClient: makeWalletClient(),
      safeAddress: SAFE_ADDRESS,
    });

    await client.revokeFeedback({ agentId: RESTORER_AGENT_ID, feedbackIndex: 7n });

    const params = vi.mocked(executeSafeTransaction).mock.calls[0]![2];
    const decoded = decodeFunctionData({ abi: REPUTATION_REGISTRY_ABI, data: params.data });
    expect(decoded.functionName).toBe('revokeFeedback');
    expect(decoded.args).toEqual([RESTORER_AGENT_ID, 7n]);
  });

  it('encodes appendResponse calldata via respondToFeedback', async () => {
    const { ReputationRegistryClient, REPUTATION_REGISTRY_ABI } = await import(
      '../../src/erc8004/reputation.js'
    );
    const { executeSafeTransaction } = await import('../../src/adapters/mech/safe.js');

    const client = new ReputationRegistryClient({
      reputationRegistryAddress: REPUTATION_ADDRESS,
      publicClient: makePublicClient(),
      walletClient: makeWalletClient(),
      safeAddress: SAFE_ADDRESS,
    });

    const responseHash =
      '0xaaaabbbbccccddddeeeeffff00001111222233334444555566667777888899aa' as `0x${string}`;
    await client.respondToFeedback({
      feedbackId: { agentId: RESTORER_AGENT_ID, client: EVALUATOR_ADDRESS, feedbackIndex: 1n },
      responseURI: 'ipfs://response-cid',
      responseHash,
    });

    const params = vi.mocked(executeSafeTransaction).mock.calls[0]![2];
    const decoded = decodeFunctionData({ abi: REPUTATION_REGISTRY_ABI, data: params.data });
    expect(decoded.functionName).toBe('appendResponse');
    const args = decoded.args as [bigint, `0x${string}`, bigint, string, `0x${string}`];
    expect(args[0]).toBe(RESTORER_AGENT_ID);
    // viem returns the address checksummed — compare lowercase to be robust.
    expect(args[1].toLowerCase()).toBe(EVALUATOR_ADDRESS.toLowerCase());
    expect(args[2]).toBe(1n);
    expect(args[3]).toBe('ipfs://response-cid');
    expect(args[4]).toBe(responseHash);
  });
});

describe('ReputationRegistryClient read paths', () => {
  it('readFeedback returns a record with score + decimals + flags', async () => {
    const { ReputationRegistryClient } = await import('../../src/erc8004/reputation.js');
    const readContract = vi
      .fn()
      .mockResolvedValue([100n, 2, 'portfolio.v0', '', false]);
    const client = new ReputationRegistryClient({
      reputationRegistryAddress: REPUTATION_ADDRESS,
      publicClient: makePublicClient({ readContract }) as unknown as PublicClient,
    });

    const record = await client.readFeedback({
      agentId: RESTORER_AGENT_ID,
      clientAddress: EVALUATOR_ADDRESS,
      feedbackIndex: 1n,
    });

    expect(record).not.toBeNull();
    expect(record).toMatchObject({
      agentId: RESTORER_AGENT_ID,
      client: EVALUATOR_ADDRESS,
      feedbackIndex: 1n,
      score: 100n,
      scoreDecimals: 2,
      tag1: 'portfolio.v0',
      revoked: false,
    });
    // empty tag2 should normalise to undefined.
    expect(record!.tag2).toBeUndefined();
  });

  it('readFeedback returns null when contract reverts with "index out of bounds"', async () => {
    const { ReputationRegistryClient } = await import('../../src/erc8004/reputation.js');
    const readContract = vi.fn().mockRejectedValue(new Error('execution reverted: index out of bounds'));
    const client = new ReputationRegistryClient({
      reputationRegistryAddress: REPUTATION_ADDRESS,
      publicClient: makePublicClient({ readContract }) as unknown as PublicClient,
    });
    const record = await client.readFeedback({
      agentId: RESTORER_AGENT_ID,
      clientAddress: EVALUATOR_ADDRESS,
      feedbackIndex: 1n,
    });
    expect(record).toBeNull();
  });

  it('readAllFeedback decodes the parallel-arrays return shape', async () => {
    const { ReputationRegistryClient } = await import('../../src/erc8004/reputation.js');
    const readContract = vi.fn().mockResolvedValue([
      [EVALUATOR_ADDRESS, EVALUATOR_ADDRESS],
      [1n, 2n],
      [100n, 0n],
      [2, 2],
      ['portfolio.v0', 'portfolio.v0'],
      ['', ''],
      [false, true],
    ]);
    const client = new ReputationRegistryClient({
      reputationRegistryAddress: REPUTATION_ADDRESS,
      publicClient: makePublicClient({ readContract }) as unknown as PublicClient,
    });
    const records = await client.readAllFeedback(RESTORER_AGENT_ID, { includeRevoked: true });
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      feedbackIndex: 1n,
      score: 100n,
      scoreDecimals: 2,
      revoked: false,
    });
    expect(records[1]).toMatchObject({
      feedbackIndex: 2n,
      score: 0n,
      revoked: true,
    });
  });

  it('getSummary throws when called with empty clientAddresses (matches contract revert)', async () => {
    const { ReputationRegistryClient } = await import('../../src/erc8004/reputation.js');
    const client = new ReputationRegistryClient({
      reputationRegistryAddress: REPUTATION_ADDRESS,
      publicClient: makePublicClient(),
    });
    await expect(
      client.getSummary(RESTORER_AGENT_ID, { clientAddresses: [] }),
    ).rejects.toThrow(/clientAddresses must be non-empty/);
  });

  it('getSummary returns the on-chain tuple shape', async () => {
    const { ReputationRegistryClient } = await import('../../src/erc8004/reputation.js');
    const readContract = vi.fn().mockResolvedValue([3n, 50n, 2]);
    const client = new ReputationRegistryClient({
      reputationRegistryAddress: REPUTATION_ADDRESS,
      publicClient: makePublicClient({ readContract }) as unknown as PublicClient,
    });
    const summary = await client.getSummary(RESTORER_AGENT_ID, {
      clientAddresses: [EVALUATOR_ADDRESS],
    });
    expect(summary).toEqual({ count: 3n, summaryValue: 50n, summaryValueDecimals: 2 });
  });

  it('getClients returns a mutable address[] copy', async () => {
    const { ReputationRegistryClient } = await import('../../src/erc8004/reputation.js');
    const readContract = vi.fn().mockResolvedValue([EVALUATOR_ADDRESS]);
    const client = new ReputationRegistryClient({
      reputationRegistryAddress: REPUTATION_ADDRESS,
      publicClient: makePublicClient({ readContract }) as unknown as PublicClient,
    });
    const clients = await client.getClients(RESTORER_AGENT_ID);
    expect(clients).toEqual([EVALUATOR_ADDRESS]);
    // ensure we get a real array we can mutate, not a frozen tuple from viem.
    clients.push('0x0' as `0x${string}`);
    expect(clients).toHaveLength(2);
  });

  it('getLastIndex returns a bigint', async () => {
    const { ReputationRegistryClient } = await import('../../src/erc8004/reputation.js');
    const readContract = vi.fn().mockResolvedValue(42n);
    const client = new ReputationRegistryClient({
      reputationRegistryAddress: REPUTATION_ADDRESS,
      publicClient: makePublicClient({ readContract }) as unknown as PublicClient,
    });
    const idx = await client.getLastIndex(RESTORER_AGENT_ID, EVALUATOR_ADDRESS);
    expect(idx).toBe(42n);
  });
});
