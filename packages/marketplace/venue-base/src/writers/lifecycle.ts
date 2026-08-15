// SPDX-License-Identifier: MIT

// The lifecycle writers -- `MarketplaceLifecyclePorts` (creator-side close/cancel) and
// `ReleaseAttemptPort` (operator-side release), generation-conditional per §7 ruling "standard
// cancellation/close wiring supplied by the chain-generation host". Every chain write funnels
// through the single Safe broadcaster (Task 8), matching the claim (Task 11) and settlement
// (Task 12) writers' established pattern: generation-specific ABI selection and
// `logicalTx: "lifecycle.<verb>:<id>"` naming. Properties absent for a generation are omitted
// entirely from the returned object, never a stub that throws.
//
// `withdrawAnnouncement` is a no-op that only resolves: announcement withdrawal is the
// projector's append-only signed retraction, not a chain write, and this port must not invent
// one. `requestCancel` persists the requester signal durably in the `cancel_signals` table (the
// row IS the signal); a restart or replay reads it back and returns `already-requested` without
// emitting a second one.
import {
  JINN_ROUTER_V3_ABI,
  JINN_ROUTER_V4_ABI,
  type MarketplaceChainConfig,
  type MarketplaceLifecyclePorts,
  type ReleaseAttemptPort,
} from "@jinn-network/marketplace-binding";
import { encodeFunctionData, type PublicClient } from "viem";
import type { BaseVenueSafeBroadcaster } from "../broadcast/safe-broadcaster.js";
import type { VenueStateDatabase } from "../state/database.js";

export interface LifecycleWriterInput {
  readonly chain: MarketplaceChainConfig;
  readonly publicClient: PublicClient;
  readonly broadcaster: BaseVenueSafeBroadcaster;
  readonly state: VenueStateDatabase;
  readonly resolveAttempt: (
    attempt: `urn:uuid:${string}`,
  ) => Promise<{ readonly taskId: bigint; readonly attemptIndex: number }>;
}

type BroadcastInput = Pick<LifecycleWriterInput, "chain" | "broadcaster">;

async function broadcastRefundUnusedTaskBudget(input: BroadcastInput, taskId: bigint): Promise<void> {
  const data = encodeFunctionData({
    abi: JINN_ROUTER_V3_ABI, functionName: "refundUnusedTaskBudget", args: [taskId],
  });
  await input.broadcaster.execute({
    to: input.chain.jinnRouter, value: 0n, data, logicalTx: `lifecycle.refundUnusedTaskBudget:${taskId}`,
  });
}

async function broadcastCloseTask(input: BroadcastInput, taskId: bigint): Promise<void> {
  const data = encodeFunctionData({
    abi: JINN_ROUTER_V4_ABI, functionName: "closeTask", args: [taskId],
  });
  await input.broadcaster.execute({
    to: input.chain.jinnRouter, value: 0n, data, logicalTx: `lifecycle.closeTask:${taskId}`,
  });
}

async function broadcastReleaseAttempt(
  input: BroadcastInput,
  args: { readonly taskId: bigint; readonly attemptIndex: number },
): Promise<void> {
  const data = encodeFunctionData({
    abi: JINN_ROUTER_V4_ABI, functionName: "releaseAttempt", args: [args.taskId, args.attemptIndex],
  });
  await input.broadcaster.execute({
    to: input.chain.jinnRouter, value: 0n, data,
    logicalTx: `lifecycle.releaseAttempt:${args.taskId}:${args.attemptIndex}`,
  });
}

async function broadcastForfeitDeliveredReservation(
  input: BroadcastInput,
  args: {
    readonly taskId: bigint;
    readonly attemptIndex: number;
    readonly verdictIndex: number;
    readonly legKind: 1 | 2;
  },
): Promise<void> {
  const data = encodeFunctionData({
    abi: JINN_ROUTER_V4_ABI, functionName: "forfeitDeliveredReservation",
    args: [args.taskId, args.attemptIndex, args.verdictIndex, args.legKind],
  });
  await input.broadcaster.execute({
    to: input.chain.jinnRouter, value: 0n, data,
    logicalTx: `lifecycle.forfeitDeliveredReservation:${args.taskId}:${args.attemptIndex}:${args.verdictIndex}`,
  });
}

/** Creator-side close/cancel wiring: `refundUnusedTaskBudget` (today) xor `closeTask`+`releaseAttempt` (revised). */
export function createLifecyclePorts(input: LifecycleWriterInput): MarketplaceLifecyclePorts {
  const insertCancelSignal = input.state.db.prepare(
    "INSERT INTO cancel_signals (attempt, task_id, attempt_index, reason, requested_at_ms)"
    + " VALUES (?, ?, ?, ?, ?) ON CONFLICT(attempt) DO NOTHING",
  );

  const base: MarketplaceLifecyclePorts = {
    resolveAttempt: input.resolveAttempt,

    async requestCancel(args) {
      const inserted = insertCancelSignal.run(
        args.attempt, args.taskId.toString(), args.attemptIndex, args.reason, Date.now(),
      );
      return inserted.changes === 1 ? "requested" : "already-requested";
    },

    async withdrawAnnouncement() {
      // No chain write: announcement withdrawal is the projector's append-only signed
      // retraction, not something this port may invent.
    },
  };

  if (input.chain.generation === "revised") {
    return {
      ...base,
      closeTask: ({ taskId }) => broadcastCloseTask(input, taskId),
      releaseAttempt: (args) => broadcastReleaseAttempt(input, args),
    };
  }

  return {
    ...base,
    refundUnusedTaskBudget: ({ taskId }) => broadcastRefundUnusedTaskBudget(input, taskId),
  };
}

/** Operator-side release wiring. Today generation has no on-chain release; revised broadcasts it. */
export function createReleasePort(input: BroadcastInput): ReleaseAttemptPort {
  if (input.chain.generation !== "revised") {
    return {
      async releaseAttempt() {
        return { ok: false, kind: "unsupported" };
      },
    };
  }

  return {
    releaseAttempt: (args) => broadcastReleaseAttempt(input, args),
    forfeitDeliveredReservation: (args) => broadcastForfeitDeliveredReservation(input, args),
  };
}
