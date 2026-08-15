// SPDX-License-Identifier: MIT

// Feature-disabled today-mode verdict primitives. The future evaluator saga owns operation
// persistence and passes its stable identity into every write; this port never invents it.
import {
  JINN_ROUTER_V3_ABI,
  MECH_ABI,
  MECH_DELIVER_TO_MARKETPLACE_ABI,
  SAFE_ABI,
  SafeInnerRevertError,
  formatKnownRevertDetail,
  type VerdictCode,
} from "@jinn-network/marketplace-binding";
import {
  decodeEventLog,
  decodeFunctionData,
  encodeFunctionData,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from "viem";
import type { BaseVenueSafeBroadcaster, SafeBroadcastReceipt } from "./broadcast/safe-broadcaster.js";

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

export interface CanonicalVerdictSettlement {
  readonly requestId: Hex;
  readonly taskId: bigint;
  readonly attemptIndex: number;
  readonly verdictIndex: number;
  readonly evaluator: Address;
  readonly verdictCode: VerdictCode;
  /** Exact digest argument carried by the canonical claimVerdictDelivery transaction. */
  readonly verdictDigest: Hex;
  readonly transaction: VerdictTransactionIdentity & { readonly logIndex: number };
}

export interface CanonicalVerdictDelivery {
  readonly requestId: Hex;
  readonly deliveryDigest: Hex;
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
    /** Required only when the receipt cannot itself establish the delivery transaction. */
    readonly reconciliationFromBlock?: bigint;
  }) => Promise<{ readonly operationId: string; readonly transaction: VerdictTransactionIdentity }>;
  readonly claimVerdictDelivery: (input: {
    readonly operationId: string;
    readonly requestId: Hex;
    readonly verdictDigest: Hex;
    readonly verdictCode: VerdictCode;
    /** Required when recovering a prior settled operation. */
    readonly reconciliationFromBlock?: bigint;
  }) => Promise<
    | { readonly operationId: string; readonly status: "rejected" }
    | {
        readonly operationId: string;
        readonly status: "settled" | "already-settled";
        readonly transaction: VerdictTransactionIdentity;
      }
  >;
  /** Current canonical RPC view for recovering an already-broadcast evaluation claim. */
  readonly readCanonicalVerdictAttempt: (input: {
    readonly taskId: bigint;
    readonly attemptIndex: number;
    /** Caller-owned lower bound from the durable operation or canonical Task observation. */
    readonly fromBlock: bigint;
    readonly evaluator?: Address;
  }) => Promise<CanonicalVerdictAttempt | undefined>;
  /** Current canonical router settlement identity for a known verdict request. */
  readonly readVerdictSettlement: (input: {
    readonly requestId: Hex;
    readonly fromBlock: bigint;
  }) => Promise<CanonicalVerdictSettlement | undefined>;
  /** Current canonical Mech delivery identity for a known verdict request and digest. */
  readonly readCanonicalVerdictDelivery: (input: {
    readonly requestId: Hex;
    readonly deliveryDigest: Hex;
    readonly fromBlock: bigint;
  }) => Promise<CanonicalVerdictDelivery | undefined>;
}

export interface VerdictPortDeps {
  readonly publicClient: PublicClient;
  readonly broadcaster: BaseVenueSafeBroadcaster;
  readonly safeAddress: Address;
  readonly routerAddress: Address;
  readonly mechAddress: Address;
}

function requireTransactionIdentity(
  identity: VerdictTransactionIdentity,
  operationId: string,
): VerdictTransactionIdentity {
  if (
    !/^0x[0-9a-f]{64}$/iu.test(identity.hash)
    || !/^0x[0-9a-f]{64}$/iu.test(identity.blockHash)
    || identity.blockNumber <= 0n
  ) {
    throw new Error(`${operationId} has no real canonical transaction identity`);
  }
  return identity;
}

function transactionIdentity(receipt: SafeBroadcastReceipt, operationId: string): VerdictTransactionIdentity {
  return requireTransactionIdentity({
    hash: receipt.txHash,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
  }, operationId);
}

function transactionIdentityFromCanonical(
  transaction: VerdictTransactionIdentity & { readonly logIndex: number },
  operationId: string,
): VerdictTransactionIdentity {
  return requireTransactionIdentity({
    hash: transaction.hash,
    blockNumber: transaction.blockNumber,
    blockHash: transaction.blockHash,
  }, operationId);
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
  const isVerdictSettled = async (requestId: Hex): Promise<boolean> =>
    Boolean(await deps.publicClient.readContract({
      address: deps.routerAddress,
      abi: JINN_ROUTER_V3_ABI,
      functionName: "claimed",
      args: [requestId],
    }));

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

  const readVerdictSettlement: VerdictPorts["readVerdictSettlement"] = async (input) => {
    if (!await isVerdictSettled(input.requestId)) return undefined;
    const events = await deps.publicClient.getContractEvents({
      address: deps.routerAddress,
      abi: JINN_ROUTER_V3_ABI,
      eventName: "VerdictDeliveryClaimed",
      args: { requestId: input.requestId },
      fromBlock: input.fromBlock,
      toBlock: "latest",
    } as never) as readonly unknown[];
    const event = events
      .map((raw) => raw as {
        readonly args?: {
          readonly evaluator?: Address;
          readonly requestId?: Hex;
          readonly taskId?: bigint;
          readonly attemptIndex?: number | bigint;
          readonly verdictIndex?: number | bigint;
          readonly verdictCode?: VerdictCode | number | bigint;
        };
        readonly transactionHash?: Hex;
        readonly blockNumber?: bigint;
        readonly blockHash?: Hex;
        readonly logIndex?: number;
      })
      .filter((candidate) => candidate.args?.requestId === input.requestId)
      .at(-1);
    const args = event?.args;
    if (
      event === undefined
      || args?.evaluator === undefined
      || args.taskId === undefined
      || args.attemptIndex === undefined
      || args.verdictIndex === undefined
      || args.verdictCode === undefined
      || event.transactionHash === undefined
      || event.blockNumber === undefined
      || event.blockHash === undefined
      || event.logIndex === undefined
    ) {
      throw new Error(`settled verdict ${input.requestId} has no canonical transaction identity`);
    }
    const transaction = await deps.publicClient.getTransaction({ hash: event.transactionHash });
    let verdictDigest: Hex;
    try {
      const outer = decodeFunctionData({ abi: SAFE_ABI, data: transaction.input });
      if (outer.functionName !== "execTransaction") {
        throw new Error("canonical verdict transaction is not a Safe execTransaction");
      }
      const outerArgs = outer.args as readonly [Address, bigint, Hex, number, ...unknown[]];
      if (outerArgs[0].toLowerCase() !== deps.routerAddress.toLowerCase()
        || outerArgs[1] !== 0n
        || Number(outerArgs[3]) !== 0) {
        throw new Error("canonical Safe transaction does not call the router directly");
      }
      const decoded = decodeFunctionData({ abi: JINN_ROUTER_V3_ABI, data: outerArgs[2] });
      if (decoded.functionName !== "claimVerdictDelivery") {
        throw new Error("canonical Safe inner transaction did not call claimVerdictDelivery");
      }
      const decodedArgs = decoded.args as readonly [Hex, Hex, VerdictCode];
      if (decodedArgs[0].toLowerCase() !== input.requestId.toLowerCase()
        || Number(decodedArgs[2]) !== Number(args.verdictCode)) {
        throw new Error("canonical verdict transaction arguments contradict the emitted event");
      }
      verdictDigest = decodedArgs[1];
    } catch (cause) {
      throw new Error(`settled verdict ${input.requestId} has no exact canonical verdict digest: ${String(cause)}`);
    }
    return {
      requestId: input.requestId,
      taskId: args.taskId,
      attemptIndex: Number(args.attemptIndex),
      verdictIndex: Number(args.verdictIndex),
      evaluator: args.evaluator,
      verdictCode: Number(args.verdictCode) as VerdictCode,
      verdictDigest,
      transaction: {
        hash: event.transactionHash,
        blockNumber: event.blockNumber,
        blockHash: event.blockHash,
        logIndex: event.logIndex,
      },
    };
  };

  const readCanonicalVerdictDelivery: VerdictPorts["readCanonicalVerdictDelivery"] = async (input) => {
    const events = await deps.publicClient.getContractEvents({
      address: deps.mechAddress,
      abi: MECH_ABI,
      eventName: "Deliver",
      fromBlock: input.fromBlock,
      toBlock: "latest",
    } as never) as readonly unknown[];
    const event = events
      .map((raw) => raw as {
        readonly args?: { readonly requestId?: Hex; readonly data?: Hex };
        readonly transactionHash?: Hex;
        readonly blockNumber?: bigint;
        readonly blockHash?: Hex;
        readonly logIndex?: number;
      })
      .filter((candidate) =>
        candidate.args?.requestId === input.requestId
        && candidate.args.data?.toLowerCase() === input.deliveryDigest.toLowerCase(),
      )
      .at(-1);
    const args = event?.args;
    if (
      event === undefined
      || args?.data === undefined
      || event.transactionHash === undefined
      || event.blockNumber === undefined
      || event.blockHash === undefined
      || event.logIndex === undefined
    ) return undefined;
    return {
      requestId: input.requestId,
      deliveryDigest: args.data,
      transaction: {
        hash: event.transactionHash,
        blockNumber: event.blockNumber,
        blockHash: event.blockHash,
        logIndex: event.logIndex,
      },
    };
  };

  async function requireVerdictSettlementIdentity(input: {
    readonly requestId: Hex;
    readonly verdictDigest: Hex;
    readonly reconciliationFromBlock?: bigint;
  }): Promise<CanonicalVerdictSettlement> {
    if (input.reconciliationFromBlock === undefined) {
      throw new Error(`claimVerdictDelivery requires reconciliationFromBlock for ${input.requestId}`);
    }
    const settlement = await readVerdictSettlement({
      requestId: input.requestId,
      fromBlock: input.reconciliationFromBlock,
    });
    if (settlement === undefined) {
      throw new Error(`claimVerdictDelivery has no canonical settled verdict for ${input.requestId}`);
    }
    if (settlement.verdictDigest.toLowerCase() !== input.verdictDigest.toLowerCase()) {
      throw new Error(`claimVerdictDelivery canonical verdict digest contradicts ${input.verdictDigest}`);
    }
    return settlement;
  }

  async function requireVerdictDeliveryIdentity(input: {
    readonly requestId: Hex;
    readonly deliveryDigest: Hex;
    readonly reconciliationFromBlock?: bigint;
  }): Promise<CanonicalVerdictDelivery> {
    if (input.reconciliationFromBlock === undefined) {
      throw new Error(`deliverVerdictToMarketplace requires reconciliationFromBlock for ${input.requestId}`);
    }
    const delivery = await readCanonicalVerdictDelivery({
      requestId: input.requestId,
      deliveryDigest: input.deliveryDigest,
      fromBlock: input.reconciliationFromBlock,
    });
    if (delivery === undefined) {
      throw new Error(`deliverVerdictToMarketplace has no canonical delivery for ${input.requestId}`);
    }
    return delivery;
  }

  return Object.freeze({
    readVerdictSettlement,
    readCanonicalVerdictAttempt,
    readCanonicalVerdictDelivery,

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
        // Only a recognized on-chain revert is a genuine refusal (terminal). A transport blip
        // (429/5xx/network) carries no decodable revert data -- rethrowing it lets the coordinator
        // retry until the admission deadline rather than permanently failing a fresh CP6 claim on
        // the first RPC hiccup. Mirrors `classifyVerdictClaimRevert`'s `detail === null` split.
        if (detail === null) throw error;
        return {
          ok: false as const,
          reason: detail.reason,
          revertName: detail.name,
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
        transaction: reconciled === undefined ? transactionIdentity(receipt, input.operationId) : reconciled.transaction,
      };
    },

    async deliverVerdictToMarketplace(input: {
      readonly operationId: string;
      readonly requestId: Hex;
      readonly deliveryDigest: Hex;
      readonly reconciliationFromBlock?: bigint;
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
      if (receipt.alreadySettled) {
        const delivery = await requireVerdictDeliveryIdentity(input);
        return {
          operationId: input.operationId,
          transaction: transactionIdentityFromCanonical(delivery.transaction, input.operationId),
        };
      }
      return { operationId: input.operationId, transaction: transactionIdentity(receipt, input.operationId) };
    },

    async claimVerdictDelivery(input: {
      readonly operationId: string;
      readonly requestId: Hex;
      readonly verdictDigest: Hex;
      readonly verdictCode: VerdictCode;
      readonly reconciliationFromBlock?: bigint;
    }) {
      requireOperationId(input.operationId);
      if (input.verdictCode === undefined) {
        throw new Error(`claimVerdictDelivery is refusing to default a verdict code for ${input.requestId}`);
      }
      if (await isVerdictSettled(input.requestId)) {
        const settlement = await requireVerdictSettlementIdentity(input);
        return {
          operationId: input.operationId,
          status: "already-settled" as const,
          transaction: transactionIdentityFromCanonical(settlement.transaction, input.operationId),
        };
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
        if (receipt.alreadySettled) {
          const settlement = await requireVerdictSettlementIdentity(input);
          return {
            operationId: input.operationId,
            status: "already-settled" as const,
            transaction: transactionIdentityFromCanonical(settlement.transaction, input.operationId),
          };
        }
        return {
          operationId: input.operationId,
          status: "settled" as const,
          transaction: transactionIdentity(receipt, input.operationId),
        };
      } catch (error) {
        if (await isVerdictSettled(input.requestId)) {
          const settlement = await requireVerdictSettlementIdentity(input);
          return {
            operationId: input.operationId,
            status: "already-settled" as const,
            transaction: transactionIdentityFromCanonical(settlement.transaction, input.operationId),
          };
        }
        const status = classifyVerdictClaimRevert(error);
        if (status === undefined) throw error;
        if (status === "already-settled") {
          const settlement = await requireVerdictSettlementIdentity(input);
          return {
            operationId: input.operationId,
            status,
            transaction: transactionIdentityFromCanonical(settlement.transaction, input.operationId),
          };
        }
        return { operationId: input.operationId, status };
      }
    },
  });
}
