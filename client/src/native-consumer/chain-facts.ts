/**
 * Independently reads the three Base Sepolia facts `verifyNativeVertical` cross-checks against
 * the signed public graph: the `TaskCreated` posting, and the two settlement claims
 * (`SolutionDeliveryClaimed`, `VerdictDeliveryClaimed`). Every observation comes straight from
 * public RPC -- transaction receipts, block headers, and the router/mech-marketplace event logs
 * -- using only the public contract ABIs and addresses. No producer state, wallet, or private
 * config is read here.
 *
 * "Today" mode does not place the delivered digest on the router event, so the solution/verdict
 * settlement observations join the router's settlement claim to the specific Mech's `Deliver` log
 * (bounded to the blocks at-or-before the claim) and compare its raw `data` field to the digest
 * the consumer already fetched and hashed from the public graph.
 */
import {
  JINN_ROUTER_V3_ABI,
  MECH_ABI,
  MECH_MARKETPLACE_ABI,
  TASK_COORDINATOR_ABI,
} from '@jinn-network/marketplace-binding';
import { DEFAULT_MECH_DELIVER_LOOKBACK_BLOCKS } from '@jinn-network/marketplace-venue-base';
import { createPublicClient, http, type Hex, type PublicClient } from 'viem';
import { baseSepolia } from 'viem/chains';

export class NativeConsumerChainFactsError extends Error {
  override readonly name = 'NativeConsumerChainFactsError';
  constructor(readonly reason: string, detail?: string) {
    super(detail === undefined ? reason : `${reason}: ${detail}`);
  }
}

export interface FinalizedAuthorityTimeAnchor {
  readonly chainId: 84532;
  readonly blockNumber: string;
  readonly blockHash: `0x${string}`;
  readonly timestamp: string;
  readonly finalized: true;
}

export interface FinalizedTransactionObservation {
  readonly hash: `0x${string}`;
  readonly blockHash: `0x${string}`;
  readonly blockNumber: string;
  readonly finalizedBlock: string;
  readonly blockTime: string;
}

export interface ChainTaskCreatedObservation {
  readonly creator: `0x${string}`;
  readonly taskDigest: `sha256:${string}`;
  readonly maxClaims: number;
  readonly postingTerms: {
    readonly solutionMaxDeliveryRateWei: string;
    readonly verdictMaxDeliveryRateWei: string;
    readonly responseTimeoutSeconds: string;
    readonly allowSolverSelfEvaluation: false;
  };
  readonly transaction: FinalizedTransactionObservation;
}

export interface ChainSolutionSettlementObservation {
  readonly attemptIndex: number;
  readonly operator: `0x${string}`;
  readonly deliveryDigest: `sha256:${string}`;
  readonly transaction: FinalizedTransactionObservation;
}

export interface ChainVerdictSettlementObservation {
  readonly attemptIndex: number;
  readonly evaluator: `0x${string}`;
  readonly verdictCode: number;
  readonly evaluationDeliveryDigest: `sha256:${string}`;
  readonly transaction: FinalizedTransactionObservation;
}

export interface NativeConsumerChainReader {
  verifyFinalized(anchor: FinalizedAuthorityTimeAnchor): Promise<boolean>;
  observeTaskCreated(input: {
    readonly coordinator: `0x${string}`;
    readonly router: `0x${string}`;
    readonly taskId: bigint;
    readonly transactionHash: `0x${string}`;
  }): Promise<ChainTaskCreatedObservation>;
  observeSolutionSettlement(input: {
    readonly router: `0x${string}`;
    readonly mechMarketplace: `0x${string}`;
    readonly taskId: bigint;
    readonly expectedAttemptIndex: number;
  }): Promise<ChainSolutionSettlementObservation>;
  observeVerdictSettlement(input: {
    readonly router: `0x${string}`;
    readonly mechMarketplace: `0x${string}`;
    readonly taskId: bigint;
    readonly expectedAttemptIndex: number;
  }): Promise<ChainVerdictSettlementObservation>;
}

function sha256Digest(value: Hex): `sha256:${string}` {
  if (!/^0x[0-9a-fA-F]{64}$/u.test(value)) throw new NativeConsumerChainFactsError('chain-fact-shape-invalid', 'expected a bytes32 digest');
  return `sha256:${value.slice(2).toLowerCase()}`;
}

function sameHex(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

async function finalizedTransaction(
  publicClient: PublicClient,
  transactionHash: `0x${string}`,
): Promise<FinalizedTransactionObservation> {
  const [receipt, finalizedBlock] = await Promise.all([
    publicClient.getTransactionReceipt({ hash: transactionHash }),
    publicClient.getBlock({ blockTag: 'finalized' }),
  ]);
  if (receipt.status !== 'success') {
    throw new NativeConsumerChainFactsError('transaction-not-successful', transactionHash);
  }
  const [canonicalBlock] = await Promise.all([publicClient.getBlock({ blockNumber: receipt.blockNumber })]);
  if (canonicalBlock.hash === null || !sameHex(canonicalBlock.hash, receipt.blockHash)) {
    throw new NativeConsumerChainFactsError('transaction-block-not-canonical', transactionHash);
  }
  if (receipt.blockNumber > finalizedBlock.number) {
    throw new NativeConsumerChainFactsError('transaction-not-finalized', transactionHash);
  }
  return {
    hash: receipt.transactionHash,
    blockHash: receipt.blockHash,
    blockNumber: receipt.blockNumber.toString(10),
    finalizedBlock: finalizedBlock.number.toString(10),
    blockTime: new Date(Number(canonicalBlock.timestamp) * 1_000).toISOString(),
  };
}

/** Joins a settlement claim to the exact delivered bytes via the specific Mech's `Deliver` log. */
async function deliveredDigest(input: {
  readonly publicClient: PublicClient;
  readonly mechMarketplace: `0x${string}`;
  readonly requestId: `0x${string}`;
  readonly atOrBeforeBlock: bigint;
}): Promise<`sha256:${string}`> {
  const requestInfo = await input.publicClient.readContract({
    address: input.mechMarketplace,
    abi: MECH_MARKETPLACE_ABI,
    functionName: 'mapRequestIdInfos',
    args: [input.requestId],
  }) as unknown as readonly [`0x${string}`, `0x${string}`, `0x${string}`, bigint, bigint, `0x${string}`];
  const deliveryMech = requestInfo[1];
  if (/^0x0{40}$/iu.test(deliveryMech)) {
    throw new NativeConsumerChainFactsError('settlement-delivery-mech-missing', input.requestId);
  }
  const fromBlock = input.atOrBeforeBlock > DEFAULT_MECH_DELIVER_LOOKBACK_BLOCKS
    ? input.atOrBeforeBlock - DEFAULT_MECH_DELIVER_LOOKBACK_BLOCKS
    : 0n;
  const events = await input.publicClient.getContractEvents({
    address: deliveryMech,
    abi: MECH_ABI,
    eventName: 'Deliver',
    fromBlock,
    toBlock: input.atOrBeforeBlock,
  });
  const matches = events.filter((event) => {
    const args = event.args as unknown as { readonly requestId?: `0x${string}` };
    return args.requestId !== undefined && sameHex(args.requestId, input.requestId);
  });
  if (matches.length !== 1) {
    throw new NativeConsumerChainFactsError('settlement-delivery-log-ambiguous', `expected 1, got ${matches.length}`);
  }
  const args = matches[0]!.args as unknown as { readonly data: Hex };
  return sha256Digest(args.data as Hex);
}

/** The testable core: every RPC call goes through the injected client, real or fake. */
export function createConsumerChainReaderFromClient(publicClient: PublicClient): NativeConsumerChainReader {
  return {
    async verifyFinalized(anchor) {
      if (anchor.chainId !== 84532 || anchor.finalized !== true || !/^(?:0|[1-9][0-9]*)$/u.test(anchor.blockNumber)) {
        return false;
      }
      const number = BigInt(anchor.blockNumber);
      const [block, finalized] = await Promise.all([
        publicClient.getBlock({ blockNumber: number }).catch(() => undefined),
        publicClient.getBlock({ blockTag: 'finalized' }),
      ]);
      return block !== undefined
        && block.hash !== null
        && number <= finalized.number
        && sameHex(block.hash, anchor.blockHash)
        && new Date(Number(block.timestamp) * 1_000).toISOString() === anchor.timestamp;
    },

    async observeTaskCreated(taskInput) {
      const receipt = await publicClient.getTransactionReceipt({ hash: taskInput.transactionHash });
      const events = await publicClient.getContractEvents({
        address: taskInput.router,
        abi: JINN_ROUTER_V3_ABI,
        eventName: 'TaskCreated',
        args: { taskId: taskInput.taskId },
        fromBlock: receipt.blockNumber,
        toBlock: receipt.blockNumber,
      });
      const matching = events.filter((event) => event.transactionHash !== null && sameHex(event.transactionHash, taskInput.transactionHash));
      if (matching.length !== 1) {
        throw new NativeConsumerChainFactsError('task-created-log-ambiguous', `expected 1, got ${matching.length}`);
      }
      const args = matching[0]!.args as unknown as {
        readonly creator: `0x${string}`;
        readonly taskId: bigint;
        readonly taskCidDigest: Hex;
        readonly maxClaims: number;
      };
      if (args.taskId !== taskInput.taskId) throw new NativeConsumerChainFactsError('task-created-log-mismatch');

      const [taskValue, paymentValue] = await Promise.all([
        publicClient.readContract({
          address: taskInput.coordinator, abi: TASK_COORDINATOR_ABI, functionName: 'getTask', args: [taskInput.taskId],
        }),
        publicClient.readContract({
          address: taskInput.router, abi: JINN_ROUTER_V3_ABI, functionName: 'taskPayments', args: [taskInput.taskId],
        }),
      ]);
      const task = taskValue as unknown as {
        readonly creator: `0x${string}`;
        readonly taskCidDigest: Hex;
        readonly policy: { readonly maxClaims: number; readonly allowSolverSelfEvaluation: boolean };
      };
      const payment = paymentValue as unknown as readonly [
        `0x${string}`, Hex, Hex, bigint, bigint, bigint, bigint, bigint, boolean, boolean,
      ];
      if (!sameHex(task.creator, args.creator)
        || sha256Digest(task.taskCidDigest) !== sha256Digest(args.taskCidDigest)
        || task.policy.maxClaims !== args.maxClaims
        || task.policy.allowSolverSelfEvaluation !== false
        || !sameHex(payment[0], args.creator)
        || sha256Digest(payment[1]) !== sha256Digest(args.taskCidDigest)) {
        throw new NativeConsumerChainFactsError('task-created-correspondence-failed');
      }
      return {
        creator: args.creator,
        taskDigest: sha256Digest(args.taskCidDigest),
        maxClaims: Number(args.maxClaims),
        postingTerms: {
          solutionMaxDeliveryRateWei: payment[3].toString(10),
          verdictMaxDeliveryRateWei: payment[4].toString(10),
          responseTimeoutSeconds: payment[5].toString(10),
          allowSolverSelfEvaluation: false,
        },
        transaction: await finalizedTransaction(publicClient, taskInput.transactionHash),
      };
    },

    async observeSolutionSettlement(solutionInput) {
      const events = await publicClient.getContractEvents({
        address: solutionInput.router,
        abi: JINN_ROUTER_V3_ABI,
        eventName: 'SolutionDeliveryClaimed',
        args: { taskId: solutionInput.taskId },
      });
      const matching = events.filter((event) => {
        const args = event.args as unknown as { readonly attemptIndex?: number };
        return Number(args.attemptIndex) === solutionInput.expectedAttemptIndex
          && event.transactionHash !== null && event.blockNumber !== null;
      });
      if (matching.length !== 1) {
        throw new NativeConsumerChainFactsError('solution-settlement-log-ambiguous', `expected 1, got ${matching.length}`);
      }
      const event = matching[0]!;
      const args = event.args as unknown as { readonly requestId: `0x${string}`; readonly operator: `0x${string}` };
      const [transaction, deliveryDigest] = await Promise.all([
        finalizedTransaction(publicClient, event.transactionHash!),
        deliveredDigest({
          publicClient, mechMarketplace: solutionInput.mechMarketplace, requestId: args.requestId,
          atOrBeforeBlock: event.blockNumber!,
        }),
      ]);
      return { attemptIndex: solutionInput.expectedAttemptIndex, operator: args.operator, deliveryDigest, transaction };
    },

    async observeVerdictSettlement(verdictInput) {
      const events = await publicClient.getContractEvents({
        address: verdictInput.router,
        abi: JINN_ROUTER_V3_ABI,
        eventName: 'VerdictDeliveryClaimed',
        args: { taskId: verdictInput.taskId },
      });
      const matching = events.filter((event) => {
        const args = event.args as unknown as { readonly attemptIndex?: number };
        return Number(args.attemptIndex) === verdictInput.expectedAttemptIndex
          && event.transactionHash !== null && event.blockNumber !== null;
      });
      if (matching.length !== 1) {
        throw new NativeConsumerChainFactsError('verdict-settlement-log-ambiguous', `expected 1, got ${matching.length}`);
      }
      const event = matching[0]!;
      const args = event.args as unknown as {
        readonly requestId: `0x${string}`; readonly evaluator: `0x${string}`; readonly verdictCode: number;
      };
      if (!Number.isInteger(args.verdictCode) || args.verdictCode < 1 || args.verdictCode > 4) {
        throw new NativeConsumerChainFactsError('verdict-code-invalid', String(args.verdictCode));
      }
      const [transaction, evaluationDeliveryDigest] = await Promise.all([
        finalizedTransaction(publicClient, event.transactionHash!),
        deliveredDigest({
          publicClient, mechMarketplace: verdictInput.mechMarketplace, requestId: args.requestId,
          atOrBeforeBlock: event.blockNumber!,
        }),
      ]);
      return {
        attemptIndex: verdictInput.expectedAttemptIndex,
        evaluator: args.evaluator,
        verdictCode: args.verdictCode,
        evaluationDeliveryDigest,
        transaction,
      };
    },
  };
}

export function createBaseSepoliaConsumerChainReader(input: { readonly rpcUrl: string }): NativeConsumerChainReader {
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(input.rpcUrl) }) as PublicClient;
  return createConsumerChainReaderFromClient(publicClient);
}
