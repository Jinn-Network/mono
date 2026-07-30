// SPDX-License-Identifier: MIT

// The claim writer -- the chain-facing half of `ClaimPorts` (design §6.1). Every write funnels
// through the single Safe broadcaster (Task 8); the per-engagement fields (`taskDigest`,
// `submission`, `nonce`, `capabilityMatch`) are host-supplied and spread over this writer's
// output by the facade (Task 17), matching `claimAttempt`'s own call shape.
import {
  JINN_ROUTER_V3_ABI,
  JINN_ROUTER_V4_ABI,
  formatKnownRevertDetail,
  type ClaimPorts,
  type MarketplaceChainConfig,
  type PreClaimResult,
} from "@jinn-network/marketplace-binding";
import { REVISED_COMMON_PROJECTOR_EVENTS_ABI } from "@jinn-network/marketplace-projector";
import {
  decodeEventLog, encodeFunctionData, type Abi, type Address, type Hex, type Log, type PublicClient,
} from "viem";
import { flattenError } from "../broadcast/classify.js";
import type { BaseVenueSafeBroadcaster } from "../broadcast/safe-broadcaster.js";

/**
 * The function-only ABI slice `claimTask` calldata is encoded against. Both generations declare
 * the function; only its return shape differs (today returns `(attemptIndex, requestId)`,
 * revised returns `attemptIndex` alone) -- neither difference matters for encoding.
 */
function routerCallAbi(chain: MarketplaceChainConfig): Abi {
  return chain.generation === "revised" ? JINN_ROUTER_V4_ABI : JINN_ROUTER_V3_ABI;
}

/**
 * The event ABI that decodes `TaskAttemptCreated`. `JINN_ROUTER_V4_ABI` (binding) is a
 * function-only slice -- it declares no events at all -- so revised-generation decode reads the
 * projector's frozen V4 router event contract instead (`REVISED_COMMON_PROJECTOR_EVENTS_ABI`,
 * Addendum 2026-07-29-f / ruling §7.29), which is the ABI `chain.jinnRouter` actually emits logs
 * against on chain. Today generation's `TaskAttemptCreated` already lives on `JINN_ROUTER_V3_ABI`.
 */
function attemptEventAbi(chain: MarketplaceChainConfig): Abi {
  return chain.generation === "revised" ? REVISED_COMMON_PROJECTOR_EVENTS_ABI : JINN_ROUTER_V3_ABI;
}

export function encodeClaimTaskCalldata(
  chain: MarketplaceChainConfig,
  taskId: bigint,
  priorityMech: Address,
): Hex {
  return encodeFunctionData({
    abi: routerCallAbi(chain),
    functionName: "claimTask",
    args: [taskId, priorityMech],
  });
}

export function decodeAttemptFromLogs(
  chain: MarketplaceChainConfig,
  logs: readonly Log[],
): { readonly attemptIndex: number; readonly requestId?: Hex } | undefined {
  for (const log of logs) {
    try {
      const decoded = decodeEventLog({
        abi: attemptEventAbi(chain), data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true,
      });
      if (decoded.eventName !== "TaskAttemptCreated") continue;
      const args = decoded.args as unknown as { attemptIndex: number | bigint; requestId?: Hex };
      return {
        attemptIndex: Number(args.attemptIndex),
        // Today claims bind a requestId; revised claims bind only monotonic attempt identity.
        ...(chain.generation === "today" && args.requestId !== undefined
          ? { requestId: args.requestId }
          : {}),
      };
    } catch {
      // Not a router event; a Safe receipt carries unrelated logs.
    }
  }
  return undefined;
}

export interface ClaimWriterInput {
  readonly chain: MarketplaceChainConfig;
  readonly publicClient: PublicClient;
  readonly safeAddress: Address;
  readonly broadcaster: BaseVenueSafeBroadcaster;
  readonly priorityMech: Address;
}

/**
 * Recovers a replayed claim's attempt from the router's already-mined `TaskAttemptCreated`
 * history. The broadcaster's `already-settled` verdict is derived from a decoded inner revert
 * (e.g. `TCAttemptAlreadyRegistered`), but `execute()` does not carry that revert's decoded args
 * back to the caller (`classify.ts`'s "already-settled" branch is a boolean, not a value) -- and
 * the receipt it does return carries no usable logs (a reverted inner call emits none; the
 * fast-exit `writeContract`-failure path never has a receipt at all). So a replayed claim reads
 * the on-chain record directly rather than fabricate an index from an empty log set.
 */
async function readSettledAttemptFromChain(
  input: Pick<ClaimWriterInput, "chain" | "publicClient" | "safeAddress">,
  taskId: bigint,
): Promise<{ readonly attemptIndex: number; readonly requestId?: Hex }> {
  const events = await input.publicClient.getContractEvents({
    address: input.chain.jinnRouter,
    abi: attemptEventAbi(input.chain),
    eventName: "TaskAttemptCreated",
    args: { taskId },
    fromBlock: 0n,
    toBlock: "latest",
  });
  const mine = events.filter((event) => {
    const args = event.args as unknown as { operator?: Address };
    return args.operator !== undefined
      && args.operator.toLowerCase() === input.safeAddress.toLowerCase();
  });
  const last = mine.at(-1);
  if (last === undefined) {
    throw new Error(
      `already-settled claim for task ${taskId} has no on-chain TaskAttemptCreated record for `
      + `operator ${input.safeAddress} — cannot recover the attempt index`,
    );
  }
  const args = last.args as unknown as { attemptIndex: number | bigint; requestId?: Hex };
  return {
    attemptIndex: Number(args.attemptIndex),
    ...(input.chain.generation === "today" && args.requestId !== undefined
      ? { requestId: args.requestId }
      : {}),
  };
}

export function createClaimWriter(
  input: ClaimWriterInput,
): Pick<ClaimPorts, "claimTask" | "preflight" | "priorityMech"> {
  return {
    priorityMech: input.priorityMech,

    async preflight(): Promise<PreClaimResult> {
      return { ok: true };
    },

    async claimTask({ taskId, priorityMech }) {
      const data = encodeClaimTaskCalldata(input.chain, taskId, priorityMech);
      const receipt = await input.broadcaster.execute({
        to: input.chain.jinnRouter, value: 0n, data, logicalTx: `claim.claimTask:${taskId}`,
      });
      const attempt = receipt.alreadySettled
        ? await readSettledAttemptFromChain(input, taskId)
        : decodeAttemptFromLogs(input.chain, receipt.logs);
      if (attempt === undefined) {
        throw new Error(
          `no TaskAttemptCreated event for task ${taskId} (txHash=${receipt.txHash}) — refusing to `
          + "fabricate an attempt index",
        );
      }
      return {
        attemptIndex: attempt.attemptIndex,
        ...(attempt.requestId === undefined ? {} : { requestId: attempt.requestId }),
        txHash: receipt.txHash,
      };
    },
  };
}

/**
 * Builds the pre-claim simulation the host binds per engagement (this taskId is not available to
 * `ClaimPorts.preflight`, which takes no arguments) before spending a claim slot.
 */
export function createClaimPreflight(
  input: ClaimWriterInput,
  taskId: bigint,
): () => Promise<PreClaimResult> {
  return async () => {
    try {
      await input.publicClient.simulateContract({
        account: input.safeAddress,
        address: input.chain.jinnRouter,
        abi: routerCallAbi(input.chain),
        functionName: "claimTask",
        args: [taskId, input.priorityMech],
      });
      return { ok: true };
    } catch (error) {
      const detail = formatKnownRevertDetail(error);
      return { ok: false, reason: detail?.reason ?? flattenError(error) };
    }
  };
}
