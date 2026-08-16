import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import {
  NativeConsumerChainFactsError,
  createConsumerChainReaderFromClient,
} from '../../src/native-consumer/chain-facts.js';

const ROUTER = '0x6f47863Ac4120A5a97Af224a5e30C3Ec2c9eA247' as const;
const COORDINATOR = '0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98' as const;
const MECH_MARKETPLACE = '0xD3233FdAaB51E9775f6bFCE8242B02C181D7c0e7' as const;
const MECH = '0x1234567890123456789012345678901234567890' as const;
const CREATOR = '0x1111111111111111111111111111111111111111' as const;
const OPERATOR = '0x2222222222222222222222222222222222222222' as const;
const EVALUATOR = '0x3333333333333333333333333333333333333333' as const;
const TX = `0x${'a'.repeat(64)}` as const;
const BLOCK_HASH = `0x${'b'.repeat(64)}` as const;
const TASK_DIGEST_HEX = `0x${'c'.repeat(64)}` as const;
const REQUEST_ID = `0x${'d'.repeat(64)}` as const;
const DELIVERY_DIGEST_HEX = `0x${'e'.repeat(64)}` as const;

function block(number: bigint, hash: `0x${string}` | null, timestamp: bigint) {
  return { number, hash, timestamp };
}

interface FakeClientInput {
  readonly receipts?: Record<string, { status: 'success' | 'reverted'; blockNumber: bigint; blockHash: `0x${string}` }>;
  readonly blocks?: Record<string, ReturnType<typeof block>>;
  readonly finalizedBlock?: ReturnType<typeof block>;
  readonly events?: Record<string, unknown[]>;
  readonly reads?: Record<string, unknown>;
}

function fakeClient(input: FakeClientInput): PublicClient {
  const receipts = input.receipts ?? {};
  const blocks = input.blocks ?? {};
  const finalizedBlock = input.finalizedBlock ?? block(1_000n, BLOCK_HASH, 2_000_000_000n);
  const events = input.events ?? {};
  const reads = input.reads ?? {};
  return {
    async getTransactionReceipt({ hash }: { hash: string }) {
      const receipt = receipts[hash];
      if (receipt === undefined) throw new Error(`no receipt for ${hash}`);
      return { transactionHash: hash, ...receipt };
    },
    async getBlock(args: { blockTag?: string; blockNumber?: bigint }) {
      if (args.blockTag === 'finalized') return finalizedBlock;
      const found = blocks[String(args.blockNumber)];
      if (found === undefined) throw new Error(`no block ${String(args.blockNumber)}`);
      return found;
    },
    async getContractEvents(args: { eventName: string }) {
      return events[args.eventName] ?? [];
    },
    async readContract(args: { functionName: string }) {
      if (!(args.functionName in reads)) throw new Error(`no stubbed read for ${args.functionName}`);
      return reads[args.functionName];
    },
  } as unknown as PublicClient;
}

describe('createConsumerChainReaderFromClient / verifyFinalized', () => {
  it('confirms a finalized anchor whose block matches exactly', async () => {
    const client = fakeClient({
      blocks: { '100': block(100n, BLOCK_HASH, 1_700_000_000n) },
      finalizedBlock: block(200n, BLOCK_HASH, 1_700_000_100n),
    });
    const reader = createConsumerChainReaderFromClient(client);
    const ok = await reader.verifyFinalized({
      chainId: 84532, blockNumber: '100', blockHash: BLOCK_HASH,
      timestamp: new Date(1_700_000_000_000).toISOString(), finalized: true,
    });
    expect(ok).toBe(true);
  });

  it('rejects an anchor ahead of the finalized head', async () => {
    const client = fakeClient({
      blocks: { '500': block(500n, BLOCK_HASH, 1_700_000_000n) },
      finalizedBlock: block(200n, BLOCK_HASH, 1_700_000_100n),
    });
    const reader = createConsumerChainReaderFromClient(client);
    const ok = await reader.verifyFinalized({
      chainId: 84532, blockNumber: '500', blockHash: BLOCK_HASH,
      timestamp: new Date(1_700_000_000_000).toISOString(), finalized: true,
    });
    expect(ok).toBe(false);
  });

  it('rejects a mismatched block hash', async () => {
    const client = fakeClient({
      blocks: { '100': block(100n, `0x${'9'.repeat(64)}`, 1_700_000_000n) },
      finalizedBlock: block(200n, BLOCK_HASH, 1_700_000_100n),
    });
    const reader = createConsumerChainReaderFromClient(client);
    const ok = await reader.verifyFinalized({
      chainId: 84532, blockNumber: '100', blockHash: BLOCK_HASH,
      timestamp: new Date(1_700_000_000_000).toISOString(), finalized: true,
    });
    expect(ok).toBe(false);
  });
});

describe('createConsumerChainReaderFromClient / observeTaskCreated', () => {
  function readyClient(): PublicClient {
    return fakeClient({
      receipts: { [TX]: { status: 'success', blockNumber: 100n, blockHash: BLOCK_HASH } },
      blocks: { '100': block(100n, BLOCK_HASH, 1_700_000_000n) },
      finalizedBlock: block(200n, BLOCK_HASH, 1_700_000_100n),
      events: {
        TaskCreated: [{
          transactionHash: TX,
          args: { creator: CREATOR, taskId: 7n, taskCidDigest: TASK_DIGEST_HEX, maxClaims: 1 },
        }],
      },
      reads: {
        getTask: { creator: CREATOR, taskCidDigest: TASK_DIGEST_HEX, policy: { maxClaims: 1, allowSolverSelfEvaluation: false } },
        taskPayments: [CREATOR, TASK_DIGEST_HEX, `0x${'0'.repeat(64)}`, 2n, 3n, 60n, 0n, 0n, false, false],
      },
    });
  }

  it('derives a canonical TaskCreated fact when the log, getTask, and taskPayments all agree', async () => {
    const reader = createConsumerChainReaderFromClient(readyClient());
    const observation = await reader.observeTaskCreated({
      coordinator: COORDINATOR, router: ROUTER, taskId: 7n, transactionHash: TX,
    });
    expect(observation).toMatchObject({
      creator: CREATOR,
      taskDigest: `sha256:${'c'.repeat(64)}`,
      maxClaims: 1,
      postingTerms: {
        solutionMaxDeliveryRateWei: '2',
        verdictMaxDeliveryRateWei: '3',
        responseTimeoutSeconds: '60',
        allowSolverSelfEvaluation: false,
      },
      transaction: { hash: TX, blockHash: BLOCK_HASH, blockNumber: '100', finalizedBlock: '200' },
    });
  });

  it('throws when getTask disagrees with the TaskCreated log', async () => {
    const client = fakeClient({
      receipts: { [TX]: { status: 'success', blockNumber: 100n, blockHash: BLOCK_HASH } },
      blocks: { '100': block(100n, BLOCK_HASH, 1_700_000_000n) },
      finalizedBlock: block(200n, BLOCK_HASH, 1_700_000_100n),
      events: {
        TaskCreated: [{
          transactionHash: TX,
          args: { creator: CREATOR, taskId: 7n, taskCidDigest: TASK_DIGEST_HEX, maxClaims: 1 },
        }],
      },
      reads: {
        getTask: { creator: OPERATOR, taskCidDigest: TASK_DIGEST_HEX, policy: { maxClaims: 1, allowSolverSelfEvaluation: false } },
        taskPayments: [CREATOR, TASK_DIGEST_HEX, `0x${'0'.repeat(64)}`, 2n, 3n, 60n, 0n, 0n, false, false],
      },
    });
    const reader = createConsumerChainReaderFromClient(client);
    await expect(reader.observeTaskCreated({
      coordinator: COORDINATOR, router: ROUTER, taskId: 7n, transactionHash: TX,
    })).rejects.toThrow(NativeConsumerChainFactsError);
  });

  it('throws when the transaction is not yet finalized', async () => {
    const client = fakeClient({
      receipts: { [TX]: { status: 'success', blockNumber: 900n, blockHash: BLOCK_HASH } },
      blocks: { '900': block(900n, BLOCK_HASH, 1_700_000_000n) },
      finalizedBlock: block(200n, BLOCK_HASH, 1_700_000_100n),
      events: {
        TaskCreated: [{
          transactionHash: TX,
          args: { creator: CREATOR, taskId: 7n, taskCidDigest: TASK_DIGEST_HEX, maxClaims: 1 },
        }],
      },
      reads: {
        getTask: { creator: CREATOR, taskCidDigest: TASK_DIGEST_HEX, policy: { maxClaims: 1, allowSolverSelfEvaluation: false } },
        taskPayments: [CREATOR, TASK_DIGEST_HEX, `0x${'0'.repeat(64)}`, 2n, 3n, 60n, 0n, 0n, false, false],
      },
    });
    const reader = createConsumerChainReaderFromClient(client);
    await expect(reader.observeTaskCreated({
      coordinator: COORDINATOR, router: ROUTER, taskId: 7n, transactionHash: TX,
    })).rejects.toThrow(NativeConsumerChainFactsError);
  });
});

describe('createConsumerChainReaderFromClient / settlement observations', () => {
  function settlementClient(): PublicClient {
    return fakeClient({
      receipts: { [TX]: { status: 'success', blockNumber: 120n, blockHash: BLOCK_HASH } },
      blocks: { '120': block(120n, BLOCK_HASH, 1_700_000_200n) },
      finalizedBlock: block(200n, BLOCK_HASH, 1_700_000_300n),
      events: {
        SolutionDeliveryClaimed: [{
          transactionHash: TX, blockNumber: 120n,
          args: { operator: OPERATOR, requestId: REQUEST_ID, taskId: 7n, attemptIndex: 0 },
        }],
        VerdictDeliveryClaimed: [{
          transactionHash: TX, blockNumber: 120n,
          args: { evaluator: EVALUATOR, requestId: REQUEST_ID, taskId: 7n, attemptIndex: 0, verdictCode: 1 },
        }],
        Deliver: [{
          args: { mech: MECH, mechServiceMultisig: OPERATOR, requestId: REQUEST_ID, deliveryRate: 1n, data: DELIVERY_DIGEST_HEX },
        }],
      },
      reads: {
        mapRequestIdInfos: [MECH, MECH, CREATOR, 60n, 1n, `0x${'0'.repeat(64)}`],
      },
    });
  }

  it('joins the solution settlement claim to the delivered digest', async () => {
    const reader = createConsumerChainReaderFromClient(settlementClient());
    const observation = await reader.observeSolutionSettlement({
      router: ROUTER, mechMarketplace: MECH_MARKETPLACE, taskId: 7n, expectedAttemptIndex: 0,
    });
    expect(observation).toMatchObject({
      attemptIndex: 0,
      operator: OPERATOR,
      deliveryDigest: `sha256:${'e'.repeat(64)}`,
      transaction: { hash: TX, blockNumber: '120', finalizedBlock: '200' },
    });
  });

  it('joins the verdict settlement claim, carrying the on-chain verdict code', async () => {
    const reader = createConsumerChainReaderFromClient(settlementClient());
    const observation = await reader.observeVerdictSettlement({
      router: ROUTER, mechMarketplace: MECH_MARKETPLACE, taskId: 7n, expectedAttemptIndex: 0,
    });
    expect(observation).toMatchObject({
      attemptIndex: 0,
      evaluator: EVALUATOR,
      verdictCode: 1,
      evaluationDeliveryDigest: `sha256:${'e'.repeat(64)}`,
    });
  });

  it('throws when the Mech Deliver log for the requestId is missing', async () => {
    const client = fakeClient({
      receipts: { [TX]: { status: 'success', blockNumber: 120n, blockHash: BLOCK_HASH } },
      blocks: { '120': block(120n, BLOCK_HASH, 1_700_000_200n) },
      finalizedBlock: block(200n, BLOCK_HASH, 1_700_000_300n),
      events: {
        SolutionDeliveryClaimed: [{
          transactionHash: TX, blockNumber: 120n,
          args: { operator: OPERATOR, requestId: REQUEST_ID, taskId: 7n, attemptIndex: 0 },
        }],
        Deliver: [],
      },
      reads: { mapRequestIdInfos: [MECH, MECH, CREATOR, 60n, 1n, `0x${'0'.repeat(64)}`] },
    });
    const reader = createConsumerChainReaderFromClient(client);
    await expect(reader.observeSolutionSettlement({
      router: ROUTER, mechMarketplace: MECH_MARKETPLACE, taskId: 7n, expectedAttemptIndex: 0,
    })).rejects.toThrow(NativeConsumerChainFactsError);
  });

  it('throws when more than one attempt-0 settlement claim exists', async () => {
    const client = fakeClient({
      receipts: { [TX]: { status: 'success', blockNumber: 120n, blockHash: BLOCK_HASH } },
      blocks: { '120': block(120n, BLOCK_HASH, 1_700_000_200n) },
      finalizedBlock: block(200n, BLOCK_HASH, 1_700_000_300n),
      events: {
        SolutionDeliveryClaimed: [
          { transactionHash: TX, blockNumber: 120n, args: { operator: OPERATOR, requestId: REQUEST_ID, taskId: 7n, attemptIndex: 0 } },
          { transactionHash: TX, blockNumber: 120n, args: { operator: EVALUATOR, requestId: REQUEST_ID, taskId: 7n, attemptIndex: 0 } },
        ],
      },
      reads: { mapRequestIdInfos: [MECH, MECH, CREATOR, 60n, 1n, `0x${'0'.repeat(64)}`] },
    });
    const reader = createConsumerChainReaderFromClient(client);
    await expect(reader.observeSolutionSettlement({
      router: ROUTER, mechMarketplace: MECH_MARKETPLACE, taskId: 7n, expectedAttemptIndex: 0,
    })).rejects.toThrow(NativeConsumerChainFactsError);
  });
});
