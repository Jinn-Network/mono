// SPDX-License-Identifier: MIT

// The verdict writer -- the chain-facing half of `VerdictPorts` (stage-2 evaluator flow). Every
// write funnels through the single Safe broadcaster; today-mode `claimEvaluation` opens and
// claims the verdict request in one transaction, then the mech deliver leg and
// `claimVerdictDelivery` close the loop.
import {
  JINN_ROUTER_V3_ABI,
  SafeInnerRevertError,
  formatKnownRevertDetail,
  type VerdictCode,
} from "@jinn-network/marketplace-binding";
import { decodeEventLog, encodeFunctionData, type Address, type Hex, type PublicClient } from "viem";
import { flattenError } from "./broadcast/classify.js";
import type { BaseVenueSafeBroadcaster } from "./broadcast/safe-broadcaster.js";

/**
 * `JinnRouterV3.claimEvaluation` -- confirmed on the deployed contract but not yet part of the
 * binding's exported `JINN_ROUTER_V3_ABI` function slice (same pattern as `deliver-leg.ts`).
 */
const CLAIM_EVALUATION_ABI = [
  {
    name: "claimEvaluation",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "taskId", type: "uint256" },
      { name: "attemptIndex", type: "uint32" },
      { name: "evaluatorMech", type: "address" },
      { name: "evaluationTaskCidDigest", type: "bytes32" },
    ],
    outputs: [
      { name: "verdictIndex", type: "uint32" },
      { name: "verdictRequestId", type: "bytes32" },
    ],
  },
] as const;

/** `AgentMech.deliverToMarketplace` -- local slice; binding `MECH_ABI` carries only the event. */
const MECH_DELIVER_TO_MARKETPLACE_ABI = [
  {
    name: "deliverToMarketplace",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "requestIds", type: "bytes32[]" },
      { name: "datas", type: "bytes[]" },
    ],
    outputs: [],
  },
] as const;

const CLAIMED_VIEW_ABI = [{
  name: "claimed", type: "function", stateMutability: "view",
  inputs: [{ name: "requestId", type: "bytes32" }],
  outputs: [{ name: "", type: "bool" }],
}] as const;

const ALREADY_SETTLED_INNER = new Set(["RouterAlreadyClaimed", "TCVerdictAlreadyDelivered"]);

export interface VerdictPorts {
  readonly openVerdictAttempt: (input: {
    readonly taskId: bigint;
    readonly attemptIndex: number;
    readonly evaluationTaskCidDigest: Hex;
  }) => Promise<{ readonly requestId: Hex; readonly verdictIndex: number; readonly txHash: Hex }>;
  readonly canOpenVerdictAttempt: (input: {
    readonly taskId: bigint;
    readonly attemptIndex: number;
  }) => Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly reason: string; readonly revertName: string | null }
  >;
  readonly deliverVerdictToMarketplace: (input: {
    readonly requestId: Hex;
    readonly deliveryDigest: Hex;
  }) => Promise<{ readonly txHash: Hex }>;
  readonly claimVerdictDelivery: (input: {
    readonly requestId: Hex;
    readonly verdictDigest: Hex;
    readonly verdictCode: VerdictCode;
  }) => Promise<{ readonly status: "settled" | "already-settled" | "rejected" }>;
}

export interface VerdictPortDeps {
  readonly publicClient: PublicClient;
  readonly broadcaster: BaseVenueSafeBroadcaster;
  readonly safeAddress: Address;
  readonly routerAddress: Address;
  readonly mechAddress: Address;
}

function decodeEvaluationAttemptFromLogs(
  logs: readonly { readonly data: Hex; readonly topics: readonly Hex[] }[],
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
      // Not a router event; a Safe receipt carries unrelated logs.
    }
  }
  return undefined;
}

function classifyVerdictClaimRevert(error: unknown): "already-settled" | "rejected" | undefined {
  if (error instanceof SafeInnerRevertError && error.decodedName !== null) {
    if (ALREADY_SETTLED_INNER.has(error.decodedName)) return "already-settled";
    return "rejected";
  }
  const detail = formatKnownRevertDetail(error);
  if (detail?.name === "RouterAlreadyClaimed") return "already-settled";
  return detail === null ? undefined : "rejected";
}

export function createVerdictPorts(deps: VerdictPortDeps): VerdictPorts {
  const alreadyClaimed = async (requestId: Hex): Promise<boolean> =>
    Boolean(await deps.publicClient.readContract({
      address: deps.routerAddress,
      abi: CLAIMED_VIEW_ABI,
      functionName: "claimed",
      args: [requestId],
    }));

  return Object.freeze({
    async canOpenVerdictAttempt(input: { readonly taskId: bigint; readonly attemptIndex: number }) {
      try {
        await deps.publicClient.simulateContract({
          account: deps.safeAddress,
          address: deps.routerAddress,
          abi: CLAIM_EVALUATION_ABI,
          functionName: "claimEvaluation",
          args: [
            input.taskId,
            input.attemptIndex,
            deps.mechAddress,
            `0x${"11".repeat(32)}` as Hex,
          ],
        });
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
      readonly taskId: bigint;
      readonly attemptIndex: number;
      readonly evaluationTaskCidDigest: Hex;
    }) {
      const data = encodeFunctionData({
        abi: CLAIM_EVALUATION_ABI,
        functionName: "claimEvaluation",
        args: [input.taskId, input.attemptIndex, deps.mechAddress, input.evaluationTaskCidDigest],
      });
      const receipt = await deps.broadcaster.execute({
        to: deps.routerAddress,
        value: 0n,
        data,
        logicalTx: `verdict.openVerdictAttempt:${input.taskId}:${input.attemptIndex}`,
      });
      const attempt = decodeEvaluationAttemptFromLogs(receipt.logs);
      if (attempt === undefined) {
        throw new Error(
          `openVerdictAttempt: no EvaluationAttemptCreated in receipt for ${receipt.txHash}`,
        );
      }
      return { requestId: attempt.requestId, verdictIndex: attempt.verdictIndex, txHash: receipt.txHash };
    },

    async deliverVerdictToMarketplace(input: { readonly requestId: Hex; readonly deliveryDigest: Hex }) {
      const data = encodeFunctionData({
        abi: MECH_DELIVER_TO_MARKETPLACE_ABI,
        functionName: "deliverToMarketplace",
        args: [[input.requestId], [input.deliveryDigest]],
      });
      const receipt = await deps.broadcaster.execute({
        to: deps.mechAddress,
        value: 0n,
        data,
        logicalTx: `verdict.deliver:${input.requestId}`,
      });
      return { txHash: receipt.txHash };
    },

    async claimVerdictDelivery(input: {
      readonly requestId: Hex;
      readonly verdictDigest: Hex;
      readonly verdictCode: VerdictCode;
    }) {
      if (input.verdictCode === undefined) {
        throw new Error(
          `claimVerdictDelivery: verdictCode is required — refusing to default for ${input.requestId}`,
        );
      }
      if (await alreadyClaimed(input.requestId)) return { status: "already-settled" as const };

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
          logicalTx: `verdict.claimVerdictDelivery:${input.requestId}`,
        });
        return { status: receipt.alreadySettled ? "already-settled" as const : "settled" as const };
      } catch (error) {
        if (await alreadyClaimed(input.requestId)) return { status: "already-settled" as const };
        const classified = classifyVerdictClaimRevert(error);
        if (classified === undefined) throw error;
        return { status: classified };
      }
    },
  });
}
