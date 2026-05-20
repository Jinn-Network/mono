import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  encodeAbiParameters,
  getAddress,
  type Address,
  type Hex,
  zeroAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CLAIM_TICKET_TOPIC0 } from '../src/abis.js';
import type { ClaimRelayerConfig } from '../src/config.js';
import { ClaimRelayerStore } from '../src/db.js';
import { buildStatusPayload } from '../src/http.js';
import { ClaimRelayer, snapshotHash } from '../src/relayer.js';
import type { ClaimSnapshot, MessengerFixture } from '../src/types.js';

const PRIVATE_KEY = '0x59c6995e998f97a5a0044966f094538d0e9dae1f177b4dd056dbd8e1a6d69690' as const;
const SIGNER = privateKeyToAccount(PRIVATE_KEY).address;
const OWNER_MISMATCH = '0x000000000000000000000000000000000000dEaD' as const;
const DISTRIBUTOR = '0x2222222222222222222222222222222222222222' as const;
const MESSENGER = '0x3333333333333333333333333333333333333333' as const;
const EMITTER = '0x4444444444444444444444444444444444444444' as const;
const MULTISIG = '0x5555555555555555555555555555555555555555' as const;
const CLAIMER = '0x6666666666666666666666666666666666666666' as const;

let stores: ClaimRelayerStore[] = [];

afterEach(() => {
  for (const store of stores) store.close();
  stores = [];
});

function makeStore(): ClaimRelayerStore {
  const dir = mkdtempSync(path.join(tmpdir(), 'jinn-claim-relayer-'));
  const store = new ClaimRelayerStore(path.join(dir, 'relayer.sqlite'));
  stores.push(store);
  return store;
}

function makeConfig(overrides: Partial<ClaimRelayerConfig> = {}): ClaimRelayerConfig {
  return {
    privateKey: PRIVATE_KEY,
    signerAddress: SIGNER,
    l1RpcUrl: 'https://l1.secret.example/rpc',
    l2RpcUrl: 'https://l2.secret.example/rpc',
    l1Chain: { network: 'sepolia', chainId: 11155111 },
    l2Chain: { network: 'base-sepolia', chainId: 84532 },
    startBlock: 10n,
    dbPath: ':memory:',
    port: 8737,
    pollIntervalMs: 60_000,
    batchBlocks: 5000n,
    artifacts: {
      l1ArtifactPath: '/tmp/l1.json',
      l2ArtifactPath: '/tmp/l2.json',
      distributor: DISTRIBUTOR,
      messenger: MESSENGER,
      claimEmitter: EMITTER,
    },
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<ClaimSnapshot> = {}): ClaimSnapshot {
  return {
    claimId: 101n,
    serviceId: 7n,
    taskCreationWeight: 3n,
    solutionDeliveryWeight: 5n,
    verdictDeliveryWeight: 2n,
    multisig: MULTISIG,
    claimer: CLAIMER,
    l2BlockNumber: 12n,
    l2LogIndex: 0,
    l2TxHash: '0xabc',
    ...overrides,
  };
}

function claimTicketLog(snapshot = makeSnapshot()): Record<string, unknown> {
  return {
    address: EMITTER,
    topics: [
      CLAIM_TICKET_TOPIC0,
      topic(snapshot.claimId),
      topic(snapshot.serviceId),
      topic(snapshot.multisig),
    ],
    data: encodeAbiParameters(
      [
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'address' },
      ],
      [
        snapshot.taskCreationWeight,
        snapshot.solutionDeliveryWeight,
        snapshot.verdictDeliveryWeight,
        snapshot.claimer,
      ],
    ),
    blockNumber: snapshot.l2BlockNumber,
    logIndex: snapshot.l2LogIndex,
    transactionHash: snapshot.l2TxHash,
    removed: false,
  };
}

function topic(value: bigint | Address): Hex {
  const raw = typeof value === 'bigint'
    ? value.toString(16)
    : value.replace(/^0x/, '');
  return `0x${raw.padStart(64, '0')}` as Hex;
}

function emptyFixture(): MessengerFixture {
  return {
    serviceId: 0n,
    taskCreationWeight: 0n,
    solutionDeliveryWeight: 0n,
    verdictDeliveryWeight: 0n,
    multisig: zeroAddress,
  };
}

async function waitForAssertion(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < 20; i++) {
    try {
      assertion();
      return;
    } catch (error: unknown) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

function matchingFixture(snapshot = makeSnapshot()): MessengerFixture {
  return {
    serviceId: snapshot.serviceId,
    taskCreationWeight: snapshot.taskCreationWeight,
    solutionDeliveryWeight: snapshot.solutionDeliveryWeight,
    verdictDeliveryWeight: snapshot.verdictDeliveryWeight,
    multisig: snapshot.multisig,
  };
}

function makeClients(options: {
  owner?: Address;
  distributorMessenger?: Address;
  fixture?: MessengerFixture;
  snapshot?: ClaimSnapshot;
  snapshots?: ClaimSnapshot[];
  onchainSnapshotHash?: Hex;
  legacyWeightGetters?: boolean;
  transientReadFailure?: {
    functionName: string;
    message: string;
    times: number;
  };
  distributorState?: {
    operatorRatio?: bigint;
    daoRatio?: bigint;
    wTaskCreation?: bigint;
    wSolutionDelivery?: bigint;
    wVerdictDelivery?: bigint;
    totalClaimedOperator?: bigint;
    totalClaimedDao?: bigint;
  };
} = {}) {
  const snapshot = options.snapshot ?? makeSnapshot();
  const snapshots = options.snapshots ?? [snapshot];
  const fixture = options.fixture ?? emptyFixture();
  let transientReadFailures = options.transientReadFailure?.times ?? 0;
  const setFixtureTx = '0xaaa1' as Hex;
  const claimTx = '0xbbb2' as Hex;
  const distributorState = {
    operatorRatio: 750_000_000_000_000_000n,
    daoRatio: 250_000_000_000_000_000n,
    wTaskCreation: 1n,
    wSolutionDelivery: 1n,
    wVerdictDelivery: 1n,
    totalClaimedOperator: 0n,
    totalClaimedDao: 0n,
    ...options.distributorState,
  };

  const l1Public = {
    readContract: vi.fn(async ({ functionName }: any) => {
      if (
        options.transientReadFailure &&
        functionName === options.transientReadFailure.functionName &&
        transientReadFailures > 0
      ) {
        transientReadFailures--;
        throw new Error(options.transientReadFailure.message);
      }
      if (functionName === 'owner') return options.owner ?? SIGNER;
      if (functionName === 'messenger') return options.distributorMessenger ?? MESSENGER;
      if (options.legacyWeightGetters) {
        if (
          functionName === 'wTaskCreation' ||
          functionName === 'wSolutionDelivery' ||
          functionName === 'wVerdictDelivery'
        ) {
          throw new Error(`missing live getter ${functionName}`);
        }
        if (functionName === 'wCreation') return distributorState.wTaskCreation;
        if (functionName === 'wRestorationDelivery') return distributorState.wSolutionDelivery;
        if (functionName === 'wEvaluationDelivery') return distributorState.wVerdictDelivery;
      }
      if (functionName in distributorState) {
        return distributorState[functionName as keyof typeof distributorState];
      }
      if (functionName === 'fixtures') {
        return [
          fixture.serviceId,
          fixture.taskCreationWeight,
          fixture.solutionDeliveryWeight,
          fixture.verdictDeliveryWeight,
          fixture.multisig,
        ];
      }
      throw new Error(`unexpected L1 read ${functionName}`);
    }),
    simulateContract: vi.fn(async ({ functionName }: any) => ({
      request: { functionName, hash: functionName === 'setFixture' ? setFixtureTx : claimTx },
    })),
    waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
  };

  const l2Public = {
    getBlockNumber: vi.fn(async () => snapshots[snapshots.length - 1].l2BlockNumber),
    getLogs: vi.fn(async () => snapshots.map((entry) => claimTicketLog(entry))),
    readContract: vi.fn(async ({ functionName, args }: any) => {
      if (functionName === 'claimSnapshotHashes') {
        if (options.onchainSnapshotHash) return options.onchainSnapshotHash;
        const claimId = args?.[0] as bigint | undefined;
        const matchingSnapshot = snapshots.find((entry) => entry.claimId === claimId) ?? snapshot;
        return snapshotHash(matchingSnapshot);
      }
      throw new Error(`unexpected L2 read ${functionName}`);
    }),
  };

  const l1Wallet = {
    account: { address: SIGNER },
    writeContract: vi.fn(async (request: any) => request.hash),
  };

  return { l1Public, l2Public, l1Wallet };
}

describe('ClaimRelayer', () => {
  it('fails startup when signer is not MockMessenger.owner()', async () => {
    const store = makeStore();
    const clients = makeClients({ owner: OWNER_MISMATCH });
    const relayer = new ClaimRelayer(makeConfig(), store, clients);

    await expect(relayer.startupCheck()).rejects.toThrow('MockMessenger.owner()');
  });

  it('marks snapshot mismatch failed without fixture or claim writes', async () => {
    const store = makeStore();
    const clients = makeClients({ onchainSnapshotHash: `0x${'00'.repeat(32)}` });
    const relayer = new ClaimRelayer(makeConfig(), store, clients);

    const result = await relayer.runOnce();

    expect(result).toMatchObject({ scanned: 1, claimed: 0, failed: 1 });
    expect(clients.l1Public.simulateContract).not.toHaveBeenCalled();
    expect(store.countByStatus().failed).toBe(1);
    expect(store.getCheckpoint(10n)).toBe(12n);
  });

  it('marks transient ticket failures retryable and leaves checkpoint behind', async () => {
    const store = makeStore();
    const secretError = [
      'HTTP request failed.',
      'URL: https://key.example/secret-provider-token',
      'Request body: {"method":"eth_call"}',
    ].join('\n');
    const clients = makeClients({
      transientReadFailure: {
        functionName: 'operatorRatio',
        message: secretError,
        times: 1,
      },
    });
    const config = makeConfig();
    const relayer = new ClaimRelayer(config, store, clients);

    const first = await relayer.runOnce();

    expect(first).toMatchObject({ scanned: 1, claimed: 0, failed: 1 });
    expect(store.getCheckpoint(10n)).toBe(9n);
    expect(store.countByStatus().retryable).toBe(1);
    expect(store.listTickets()[0].error).toContain('URL: [redacted-url]');
    expect(JSON.stringify(store.listTickets())).not.toContain('key.example');
    expect(relayer.getStatus().lastError).toContain('URL: [redacted-url]');
    expect(relayer.getStatus().lastError).not.toContain('key.example');
    const statusPayload = buildStatusPayload({
      config,
      store,
      relayer,
      startedAtMs: Date.now(),
    });
    expect(JSON.stringify(statusPayload)).not.toContain('key.example');
    expect(statusPayload.stats.lastError).toContain('URL: [redacted-url]');

    const second = await relayer.runOnce();

    expect(second).toMatchObject({ scanned: 1, claimed: 1, failed: 0 });
    expect(store.getCheckpoint(10n)).toBe(12n);
    expect(store.countByStatus().claimed).toBe(1);
    expect(store.countByStatus().retryable).toBe(0);
  });

  it('stops a batch after a retryable ticket instead of advancing later claims', async () => {
    const store = makeStore();
    const first = makeSnapshot({ claimId: 1n, l2BlockNumber: 12n, l2LogIndex: 0 });
    const second = makeSnapshot({ claimId: 2n, l2BlockNumber: 12n, l2LogIndex: 1 });
    const clients = makeClients({
      snapshots: [first, second],
      transientReadFailure: {
        functionName: 'operatorRatio',
        message: 'HTTP request failed. URL: https://key.example/rpc',
        times: 1,
      },
    });
    const relayer = new ClaimRelayer(makeConfig({ batchBlocks: 20n }), store, clients);

    const result = await relayer.runOnce();

    expect(result).toMatchObject({ scanned: 1, claimed: 0, failed: 1 });
    expect(store.getCheckpoint(10n)).toBe(9n);
    expect(clients.l1Wallet.writeContract).not.toHaveBeenCalled();
  });

  it('retries transient L1 write failures without advancing the checkpoint', async () => {
    const store = makeStore();
    const snapshot = makeSnapshot();
    const clients = makeClients({ snapshot, fixture: matchingFixture(snapshot) });
    clients.l1Wallet.writeContract.mockRejectedValueOnce(
      new Error('HTTP request failed. URL: https://key.example/write-token'),
    );
    const relayer = new ClaimRelayer(makeConfig(), store, clients);

    await expect(relayer.runOnce()).resolves.toMatchObject({ claimed: 0, failed: 1 });
    expect(store.getCheckpoint(10n)).toBe(9n);
    expect(store.countByStatus().retryable).toBe(1);
    expect(JSON.stringify(store.listTickets())).not.toContain('key.example');

    await expect(relayer.runOnce()).resolves.toMatchObject({ claimed: 1, failed: 0 });
    expect(store.getCheckpoint(10n)).toBe(12n);
    expect(store.countByStatus().claimed).toBe(1);
    expect(clients.l1Wallet.writeContract).toHaveBeenCalledTimes(2);
  });

  it('reuses a matching fixture and only submits the distributor claim', async () => {
    const store = makeStore();
    const snapshot = makeSnapshot();
    const clients = makeClients({ snapshot, fixture: matchingFixture(snapshot) });
    const relayer = new ClaimRelayer(makeConfig(), store, clients);

    const result = await relayer.runOnce();

    expect(result).toMatchObject({ scanned: 1, claimed: 1, failed: 0 });
    expect(clients.l1Public.simulateContract).toHaveBeenCalledTimes(1);
    expect(clients.l1Public.simulateContract.mock.calls[0][0]).toMatchObject({
      address: DISTRIBUTOR,
      functionName: 'claim',
    });
  });

  it('skips new tickets that have no distributor delta owed', async () => {
    const store = makeStore();
    const snapshot = makeSnapshot();
    const weighted =
      snapshot.taskCreationWeight + snapshot.solutionDeliveryWeight + snapshot.verdictDeliveryWeight;
    const clients = makeClients({
      snapshot,
      distributorState: {
        totalClaimedOperator: (weighted * 750_000_000_000_000_000n) / 1_000_000_000_000_000_000n,
        totalClaimedDao: (weighted * 250_000_000_000_000_000n) / 1_000_000_000_000_000_000n,
      },
    });
    const relayer = new ClaimRelayer(makeConfig(), store, clients);

    const result = await relayer.runOnce();

    expect(result).toMatchObject({ scanned: 1, skipped: 1, claimed: 0, failed: 0 });
    expect(clients.l1Public.simulateContract).not.toHaveBeenCalled();
    expect(clients.l1Wallet.writeContract).not.toHaveBeenCalled();
    expect(store.countByStatus().skipped).toBe(1);
  });

  it('falls back to the live Sepolia distributor weight getter names', async () => {
    const store = makeStore();
    const clients = makeClients({ legacyWeightGetters: true });
    const relayer = new ClaimRelayer(makeConfig(), store, clients);

    await expect(relayer.runOnce()).resolves.toMatchObject({ claimed: 1, failed: 0 });

    const readNames = clients.l1Public.readContract.mock.calls.map((call) => call[0].functionName);
    expect(readNames).toContain('wTaskCreation');
    expect(readNames).toContain('wCreation');
    expect(readNames).toContain('wSolutionDelivery');
    expect(readNames).toContain('wRestorationDelivery');
    expect(readNames).toContain('wVerdictDelivery');
    expect(readNames).toContain('wEvaluationDelivery');
  });

  it('fails on fixture mismatch and does not submit claim', async () => {
    const store = makeStore();
    const clients = makeClients({
      fixture: {
        ...matchingFixture(),
        multisig: getAddress('0x7777777777777777777777777777777777777777'),
      },
    });
    const relayer = new ClaimRelayer(makeConfig(), store, clients);

    const result = await relayer.runOnce();

    expect(result).toMatchObject({ scanned: 1, claimed: 0, failed: 1 });
    expect(clients.l1Public.simulateContract).not.toHaveBeenCalled();
    expect(store.countByStatus().failed).toBe(1);
  });

  it('skips replayed claimed tickets without resubmitting a no-delta claim', async () => {
    const store = makeStore();
    const snapshot = makeSnapshot();
    const clients = makeClients({ snapshot, fixture: matchingFixture(snapshot) });
    const relayer = new ClaimRelayer(makeConfig(), store, clients);

    await expect(relayer.runOnce()).resolves.toMatchObject({ claimed: 1 });
    store.setCheckpoint(9n);
    clients.l1Public.simulateContract.mockClear();
    clients.l1Wallet.writeContract.mockClear();

    await expect(relayer.runOnce()).resolves.toMatchObject({ skipped: 1, claimed: 0 });
    expect(clients.l1Public.simulateContract).not.toHaveBeenCalled();
    expect(clients.l1Wallet.writeContract).not.toHaveBeenCalled();
  });

  it('writes fixture when empty then submits claim', async () => {
    const store = makeStore();
    const clients = makeClients();
    const relayer = new ClaimRelayer(makeConfig(), store, clients);

    await expect(relayer.runOnce()).resolves.toMatchObject({ claimed: 1, failed: 0 });

    expect(clients.l1Public.simulateContract).toHaveBeenCalledTimes(2);
    expect(clients.l1Public.simulateContract.mock.calls[0][0]).toMatchObject({
      address: MESSENGER,
      functionName: 'setFixture',
    });
    expect(clients.l1Public.simulateContract.mock.calls[1][0]).toMatchObject({
      address: DISTRIBUTOR,
      functionName: 'claim',
    });
  });

  it('coalesces overlapping runOnce calls into one L1/checkpoint writer', async () => {
    const store = makeStore();
    const clients = makeClients();
    let releaseBlock!: () => void;
    const blockGate = new Promise<void>((resolve) => {
      releaseBlock = resolve;
    });
    clients.l2Public.getBlockNumber.mockImplementation(async () => {
      await blockGate;
      return 12n;
    });
    const relayer = new ClaimRelayer(makeConfig(), store, clients);

    const first = relayer.runOnce();
    const second = relayer.runOnce();

    await waitForAssertion(() => {
      expect(clients.l2Public.getBlockNumber).toHaveBeenCalledTimes(1);
    });
    releaseBlock();
    const results = await Promise.all([first, second]);

    expect(results[0]).toEqual(results[1]);
    expect(clients.l2Public.getLogs).toHaveBeenCalledTimes(1);
    expect(clients.l1Wallet.writeContract).toHaveBeenCalledTimes(2);
    expect(store.getCheckpoint(10n)).toBe(12n);
  });

  it('scopes checkpoints and tickets to the deployment identity', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'jinn-claim-relayer-scope-'));
    const store = new ClaimRelayerStore(path.join(dir, 'relayer.sqlite'));
    stores.push(store);
    const snapshot = makeSnapshot({ claimId: 1n });
    const firstClients = makeClients({ snapshot, fixture: matchingFixture(snapshot) });
    const firstRelayer = new ClaimRelayer(makeConfig(), store, firstClients);

    await expect(firstRelayer.runOnce()).resolves.toMatchObject({ claimed: 1 });
    expect(store.getCheckpoint(10n)).toBe(12n);

    const nextEmitter = '0x7777777777777777777777777777777777777777' as const;
    const secondClients = makeClients({ snapshot, fixture: matchingFixture(snapshot) });
    const secondRelayer = new ClaimRelayer(
      makeConfig({
        artifacts: {
          l1ArtifactPath: '/tmp/l1.json',
          l2ArtifactPath: '/tmp/l2.json',
          distributor: DISTRIBUTOR,
          messenger: MESSENGER,
          claimEmitter: nextEmitter,
        },
      }),
      store,
      secondClients,
    );

    expect(store.getCheckpoint(10n)).toBe(9n);
    await expect(secondRelayer.runOnce()).resolves.toMatchObject({ scanned: 1, claimed: 1 });
    expect(secondClients.l1Public.simulateContract).toHaveBeenCalledTimes(1);
    expect(store.countByStatus().claimed).toBe(1);
  });
});
