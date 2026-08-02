// SPDX-License-Identifier: MIT

// Feature-disabled today-mode verdict primitives. The future evaluator saga owns operation
// persistence and passes its stable identity into every write; this port never invents it.
import {
  JINN_ROUTER_V3_ABI,
  SafeInnerRevertError,
  formatKnownRevertDetail,
  type VerdictCode,
} from "@jinn-network/marketplace-binding";
import {
  decodeEventLog,
  encodeFunctionData,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from "viem";
import { flattenError } from "./broadcast/classify.js";
import type { BaseVenueSafeBroadcaster, SafeBroadcastReceipt } from "./broadcast/safe-broadcaster.js";

const MECH_DELIVER_TO_MARKETPLACE_ABI = [{
  name: "deliverToMarketplace",
  type: "function",
  stateMutability: "nonpayable",
  inputs: [
    { name: "requestIds", type: "bytes32[]" },
    { name: "datas", type: "bytes[]" },
  ],
  outputs: [],
}] as const;

const ALREADY_SETTLED_INNER = new Set(["RouterAlreadyClaimed", "TCVerdictAlreadyDelivered"]);

export interface VerdictTransactionIdentity {
  readonly hash: Hex;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
}

export interface CanonicalVerdictAttempt {
  readonly taskId: bigint;
  readonly attemptIndex: number;
  readonly verdictIndex: number;
  readonly requestId: Hex;
  readonly evaluator: Address;
  readonly transaction: VerdictTransactionIdentity & { readonly logIndex: number };
}

export interface VerdictPorts {
  readonly openVerdictAttempt: (input: {
    readonly operationId: string;
    readonly taskId: bigint;
    readonly attemptIndex: number;
    readonly evaluationTaskCidDigest: Hex;
    /** Required only when recovering an already-settled operation receipt. */
    readonly reconciliationFromBlock?: bigint;
  }) => Promise<{
    readonly operationId: string;
    readonly requestId: Hex;
    readonly verdictIndex: number;
    readonly transaction: VerdictTransactionIdentity;
  }>;
  readonly canOpenVerdictAttempt: (input: {
    readonly taskId: bigint;
    readonly attemptIndex: number;
  }) => Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly reason: string; readonly revertName: string | null }
  >;
  readonly deliverVerdictToMarketplace: (input: {
    readonly operationId: string;
    readonly requestId: Hex;
    readonly deliveryDigest: Hex;
  }) => Promise<{ readonly operationId: string; readonly transaction: VerdictTransactionIdentity }>;
  readonly claimVerdictDelivery: (input: {
    readonly operationId: string;
    readonly requestId: Hex;
    readonly verdictDigest: Hex;
    readonly verdictCode: VerdictCode;
  }) => Promise<{
    readonly operationId: string;
    readonly status: "settled" | "already-settled" | "rejected";
    readonly transaction?: VerdictTransactionIdentity;
  }>;
  /** Current canonical RPC view for recovering an already-broadcast evaluation claim. */
  readonly readCanonicalVerdictAttempt: (input: {
    readonly taskId: bigint;
    readonly attemptIndex: number;
    /** Caller-owned lower bound from the durable operation or canonical Task observation. */
    readonly fromBlock: bigint;
    readonly evaluator?: Address;
  }) => Promise<CanonicalVerdictAttempt | undefined>;
  /** Current router settlement state for a known verdict request. */
  readonly readVerdictSettlement: (input: { readonly requestId: Hex }) => Promise<{ readonly settled: boolean }>;
}

export interface VerdictPortDeps {
  readonly publicClient: PublicClient;
  readonly broadcaster: BaseVenueSafeBroadcaster;
  readonly safeAddress: Address;
  readonly routerAddress: Address;
  readonly mechAddress: Address;
}

function transactionIdentity(receipt: SafeBroadcastReceipt): VerdictTransactionIdentity {
  return {
    hash: receipt.txHash,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
  };
}

function requireOperationId(operationId: string): void {
  if (operationId.trim().length === 0) {
    throw new Error("verdict operationId must be a stable non-empty identity");
  }
}

function decodeEvaluationAttemptFromLogs(
  logs: readonly Log[],
): { readonly requestId: Hex; readonly verdictIndex: number } | undefined {
  for (const log of logs) {
    try {
      const decoded = decodeEventLog({
        abi: JINN_ROUTER_V3_ABI,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
        strict: true,
      });
      if (decoded.eventName !== "EvaluationAttemptCreated") continue;
      const args = decoded.args as unknown as { requestId: Hex; verdictIndex: number | bigint };
      return { requestId: args.requestId, verdictIndex: Number(args.verdictIndex) };
    } catch {
      // A Safe receipt also contains unrelated logs.
    }
  }
  return undefined;
}

function classifyVerdictClaimRevert(error: unknown): "already-settled" | "rejected" | undefined {
  if (error instanceof SafeInnerRevertError && error.decodedName !== null) {
    return ALREADY_SETTLED_INNER.has(error.decodedName) ? "already-settled" : "rejected";
  }
  const detail = formatKnownRevertDetail(error);
  if (detail?.name === "RouterAlreadyClaimed") return "already-settled";
  return detail === null ? undefined : "rejected";
}

export function createVerdictPorts(deps: VerdictPortDeps): VerdictPorts {
  const readVerdictSettlement: VerdictPorts["readVerdictSettlement"] = async ({ requestId }) => ({
    settled: Boolean(await deps.publicClient.readContract({
      address: deps.routerAddress,
      abi: JINN_ROUTER_V3_ABI,
      functionName: "claimed",
      args: [requestId],
    })),
  });

  const readCanonicalVerdictAttempt: VerdictPorts["readCanonicalVerdictAttempt"] = async (input) => {
    const events = await deps.publicClient.getContractEvents({
      address: deps.routerAddress,
      abi: JINN_ROUTER_V3_ABI,
      eventName: "EvaluationAttemptCreated",
      args: { taskId: input.taskId, attemptIndex: input.attemptIndex },
      fromBlock: input.fromBlock,
      toBlock: "latest",
    } as never) as readonly unknown[];
    const event = events
      .map((raw) => raw as {
        readonly args?: {
          readonly taskId?: bigint;
          readonly attemptIndex?: number | bigint;
          readonly verdictIndex?: number | bigint;
          readonly requestId?: Hex;
          readonly evaluator?: Address;
        };
        readonly transactionHash?: Hex;
        readonly blockNumber?: bigint;
        readonly blockHash?: Hex;
        readonly logIndex?: number;
      })
      .filter((candidate) => {
        const args = candidate.args;
        return args?.taskId === input.taskId
          && Number(args.attemptIndex) === input.attemptIndex
          && args.requestId !== undefined
          && args.evaluator !== undefined
          && (input.evaluator === undefined || args.evaluator.toLowerCase() === input.evaluator.toLowerCase());
      })
      .at(-1);
    if (event === undefined) return undefined;
    const args = event.args!;
    if (
      args.verdictIndex === undefined
      || args.requestId === undefined
      || args.evaluator === undefined
      || event.transactionHash === undefined
      || event.blockNumber === undefined
      || event.blockHash === undefined
      || event.logIndex === undefined
    ) {
      throw new Error("canonical EvaluationAttemptCreated is missing a required reconciliation identity");
    }
    return {
      taskId: input.taskId,
      attemptIndex: input.attemptIndex,
      verdictIndex: Number(args.verdictIndex),
      requestId: args.requestId,
      evaluator: args.evaluator,
      transaction: {
        hash: event.transactionHash,
        blockNumber: event.blockNumber,
        blockHash: event.blockHash,
        logIndex: event.logIndex,
      },
    };
  };

  return Object.freeze({
    readVerdictSettlement,
    readCanonicalVerdictAttempt,

    async canOpenVerdictAttempt(input: { readonly taskId: bigint; readonly attemptIndex: number }) {
      try {
        await deps.publicClient.simulateContract({
          account: deps.safeAddress,
          address: deps.routerAddress,
          abi: JINN_ROUTER_V3_ABI,
          functionName: "claimEvaluation",
          args: [
            input.taskId,
            input.attemptIndex,
            deps.mechAddress,
            `0x${"11".repeat(32)}` as Hex,
          ],
        } as never);
        return { ok: true } as const;
      } catch (error) {
        const detail = formatKnownRevertDetail(error);
        return {
          ok: false as const,
          reason: detail?.reason ?? flattenError(error),
          revertName: detail?.name ?? null,
        };
      }
    },

    async openVerdictAttempt(input: {
      readonly operationId: string;
      readonly taskId: bigint;
      readonly attemptIndex: number;
      readonly evaluationTaskCidDigest: Hex;
      readonly reconciliationFromBlock?: bigint;
    }) {
      requireOperationId(input.operationId);
      const data = encodeFunctionData({
        abi: JINN_ROUTER_V3_ABI,
        functionName: "claimEvaluation",
        args: [input.taskId, input.attemptIndex, deps.mechAddress, input.evaluationTaskCidDigest],
      });
      const receipt = await deps.broadcaster.execute({
        to: deps.routerAddress,
        value: 0n,
        data,
        logicalTx: input.operationId,
      });
      let reconciled: CanonicalVerdictAttempt | undefined;
      if (receipt.alreadySettled) {
        if (input.reconciliationFromBlock === undefined) {
          throw new Error(
            `openVerdictAttempt requires reconciliationFromBlock for already-settled ${input.operationId}`,
          );
        }
        reconciled = await readCanonicalVerdictAttempt({
          taskId: input.taskId,
          attemptIndex: input.attemptIndex,
          fromBlock: input.reconciliationFromBlock,
          evaluator: deps.safeAddress,
        });
      }
      const claimed = reconciled ?? decodeEvaluationAttemptFromLogs(receipt.logs);
      if (claimed === undefined) {
        throw new Error(`openVerdictAttempt has no canonical EvaluationAttemptCreated for ${input.operationId}`);
      }
      return {
        operationId: input.operationId,
        requestId: claimed.requestId,
        verdictIndex: claimed.verdictIndex,
        transaction: reconciled === undefined ? transactionIdentity(receipt) : reconciled.transaction,
      };
    },

    async deliverVerdictToMarketplace(input: {
      readonly operationId: string;
      readonly requestId: Hex;
      readonly deliveryDigest: Hex;
    }) {
      requireOperationId(input.operationId);
      const data = encodeFunctionData({
        abi: MECH_DELIVER_TO_MARKETPLACE_ABI,
        functionName: "deliverToMarketplace",
        args: [[input.requestId], [input.deliveryDigest]],
      });
      const receipt = await deps.broadcaster.execute({
        to: deps.mechAddress,
        value: 0n,
        data,
        logicalTx: input.operationId,
      });
      return { operationId: input.operationId, transaction: transactionIdentity(receipt) };
    },

    async claimVerdictDelivery(input: {
      readonly operationId: string;
      readonly requestId: Hex;
      readonly verdictDigest: Hex;
      readonly verdictCode: VerdictCode;
    }) {
      requireOperationId(input.operationId);
      if (input.verdictCode === undefined) {
        throw new Error(`claimVerdictDelivery is refusing to default a verdict code for ${input.requestId}`);
      }
      if ((await readVerdictSettlement({ requestId: input.requestId })).settled) {
        return { operationId: input.operationId, status: "already-settled" as const };
      }
      const data = encodeFunctionData({
        abi: JINN_ROUTER_V3_ABI,
        functionName: "claimVerdictDelivery",
        args: [input.requestId, input.verdictDigest, input.verdictCode],
      });
      try {
        const receipt = await deps.broadcaster.execute({
          to: deps.routerAddress,
          value: 0n,
          data,
          logicalTx: input.operationId,
        });
        if (receipt.alreadySettled) return { operationId: input.operationId, status: "already-settled" as const };
        return {
          operationId: input.operationId,
          status: "settled" as const,
          transaction: transactionIdentity(receipt),
        };
      } catch (error) {
        if ((await readVerdictSettlement({ requestId: input.requestId })).settled) {
          return { operationId: input.operationId, status: "already-settled" as const };
        }
        const status = classifyVerdictClaimRevert(error);
        if (status === undefined) throw error;
        return { operationId: input.operationId, status };
      }
    },
  });
}
