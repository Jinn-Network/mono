import { vi } from 'vitest';
import { MechAdapter } from '../../src/adapters/mech/adapter.js';
import type { MechAdapterConfig } from '../../src/adapters/mech/types.js';
import {
  decodeTaskCreatedLogs,
  decodeSolutionDeliveryClaimedLogs,
} from '../../src/adapters/mech/contracts.js';
import { fetchFromIpfs, fetchSignedTaskFromIpfs } from '../../src/adapters/mech/ipfs.js';

const ADAPTER_REQUEST_ID = `0x${'aa'.repeat(32)}` as `0x${string}`;
const ADAPTER_TASK_CID_DIGEST = `0x${'cc'.repeat(32)}` as `0x${string}`;
const ADAPTER_TASK_CID = `f01551220${'cc'.repeat(32)}`;
const ADAPTER_MANIFEST_DIGEST = `0x${'99'.repeat(32)}` as `0x${string}`;
const ADAPTER_TX_HASH = `0x${'12'.repeat(32)}` as `0x${string}`;
const ADAPTER_CREATION_TX = `0x${'34'.repeat(32)}` as `0x${string}`;

const ADAPTER_CONFIG: MechAdapterConfig = {
  rpcUrl: 'http://localhost:8545',
  mechMarketplaceAddress: `0x${'11'.repeat(20)}` as `0x${string}`,
  routerAddress: `0x${'22'.repeat(20)}` as `0x${string}`,
  mechContractAddress: `0x${'33'.repeat(20)}` as `0x${string}`,
  safeAddress: `0x${'44'.repeat(20)}` as `0x${string}`,
  agentEoaPrivateKey: `0x${'55'.repeat(32)}` as `0x${string}`,
  ipfsRegistryUrl: 'http://localhost:5001',
  ipfsGatewayUrl: 'http://localhost:8080',
  pollIntervalMs: 1_000,
  chainId: 8453,
  routerClaimDeliveryVariant: 'v1',
};

function signedTaskFixture(id: string): unknown {
  return {
    schemaVersion: 'task.v1',
    id,
    solverType: 'prediction.v1',
    contractId: 'prediction',
    contractVersion: 'v1',
    solverNetManifestCid: 'bafyfixturecid',
    role: 'restoration',
    description: 'fixture task',
    window: { startTs: Date.now() - 600_000, endTs: Date.now() + 3_600_000 },
    spec: {
      venue: 'polymarket',
      marketId: 'market-1',
      conditionId: `0x${'11'.repeat(32)}`,
      outcomeTokenId: '123',
      outcome: 'YES',
    },
    eligibility: {},
    claimPolicy: { mode: 'parallel', maxClaims: 25, maxClaimsPerOperator: 1, claimLeaseTtlSeconds: 600 },
    creator: {
      safeAddress: '0x1111111111111111111111111111111111111111',
      agentEoa: '0x2222222222222222222222222222222222222222',
    },
    createdAt: 1_775_000_000_000,
    signature: {
      algo: 'secp256k1',
      signer: '0x2222222222222222222222222222222222222222',
      hash: `0x${'ab'.repeat(32)}`,
      sig: `0x${'cd'.repeat(65)}`,
    },
  };
}

export interface AdapterFixtureOpts {
  routerLogs?: Array<'TaskCreated' | 'SolutionDeliveryClaimed'>;
  joinedSolverNets?: Record<string, unknown>;
  pollIntervalMs?: number;
}

export function adapterFixture(opts: AdapterFixtureOpts = {}): MechAdapter {
  const routerLogs = new Set(opts.routerLogs ?? []);
  const manifestCids = opts.joinedSolverNets ? Object.keys(opts.joinedSolverNets) : undefined;

  vi.mocked(decodeTaskCreatedLogs).mockReset();
  vi.mocked(decodeSolutionDeliveryClaimedLogs).mockReset();
  vi.mocked(fetchFromIpfs).mockReset();
  vi.mocked(fetchSignedTaskFromIpfs).mockReset();

  const taskCreatedEvent = {
    taskId: '1',
    taskCidDigest: ADAPTER_TASK_CID_DIGEST,
    manifestDigest: ADAPTER_MANIFEST_DIGEST,
    creator: ADAPTER_CONFIG.safeAddress,
    transactionHash: ADAPTER_CREATION_TX,
    blockNumber: 79,
  };

  if (routerLogs.has('TaskCreated')) {
    vi.mocked(decodeTaskCreatedLogs).mockReturnValueOnce([taskCreatedEvent]);
  } else {
    vi.mocked(decodeTaskCreatedLogs)
      .mockReturnValueOnce([])
      .mockReturnValueOnce([taskCreatedEvent]);
  }

  if (routerLogs.has('SolutionDeliveryClaimed')) {
    vi.mocked(decodeSolutionDeliveryClaimedLogs).mockReturnValueOnce([{
      taskId: '1',
      attemptIndex: 0,
      requestId: ADAPTER_REQUEST_ID,
      operator: `0x${'66'.repeat(20)}` as `0x${string}`,
      transactionHash: ADAPTER_TX_HASH,
      blockNumber: 333,
    }]);
  } else {
    vi.mocked(decodeSolutionDeliveryClaimedLogs).mockReturnValue([]);
  }

  vi.mocked(fetchFromIpfs).mockResolvedValue({
    data: 'solution payload',
    task: {
      cid: ADAPTER_TASK_CID,
      onchainCreationTx: ADAPTER_CREATION_TX,
      onchainCreationBlock: 79,
      requestId: ADAPTER_REQUEST_ID,
    },
  });
  vi.mocked(fetchSignedTaskFromIpfs).mockResolvedValue(signedTaskFixture('watched-task'));

  const adapter = new MechAdapter({
    ...ADAPTER_CONFIG,
    pollIntervalMs: opts.pollIntervalMs ?? ADAPTER_CONFIG.pollIntervalMs,
    ...(manifestCids ? { taskDiscovery: { solverNetManifestCids: manifestCids } } : {}),
  });

  (adapter as unknown as { publicClient: unknown }).publicClient = {
    getBlockNumber: vi.fn().mockResolvedValue(101n),
    getLogs: vi.fn().mockResolvedValue([{ data: '0x', topics: [] }]),
    readContract: vi.fn().mockResolvedValue(false),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({ logs: [] }),
  };
  (adapter as unknown as { walletClient: unknown }).walletClient = {};
  (adapter as unknown as { requestBlockCursor: bigint }).requestBlockCursor = 100n;

  return adapter;
}
