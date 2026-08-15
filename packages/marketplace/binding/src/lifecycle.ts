// SPDX-License-Identifier: MIT

import type { MarketplaceChainConfig } from "./addresses.js";

export async function closeSubmission(taskId: bigint, config: MarketplaceChainConfig, ports: { refundUnusedTaskBudget?: (input: { taskId: bigint }) => Promise<void>; closeTask?: (input: { taskId: bigint }) => Promise<void>; withdrawAnnouncement: (input: { taskId: bigint }) => Promise<void> }): Promise<void> {
  if (config.generation === "revised") {
    if (ports.closeTask === undefined) throw new Error("revised closeTask port is required");
    await ports.closeTask({ taskId });
  } else {
    if (ports.refundUnusedTaskBudget === undefined) throw new Error("today refundUnusedTaskBudget port is required");
    await ports.refundUnusedTaskBudget({ taskId });
  }
  await ports.withdrawAnnouncement({ taskId });
}
export async function releaseAttempt(taskId: bigint, attemptIndex: number, config: MarketplaceChainConfig, ports: { releaseAttempt?: (input: { taskId: bigint; attemptIndex: number }) => Promise<void> }): Promise<void | { ok: false; kind: "unsupported" }> {
  if (config.generation === "today") return { ok: false, kind: "unsupported" };
  if (ports.releaseAttempt === undefined) throw new Error("revised releaseAttempt port is required");
  await ports.releaseAttempt({ taskId, attemptIndex });
}

export async function forfeitDeliveredReservation(
  input: {
    readonly taskId: bigint;
    readonly attemptIndex: number;
    readonly verdictIndex: number;
    readonly legKind: 1 | 2;
  },
  config: MarketplaceChainConfig,
  ports: {
    readonly forfeitDeliveredReservation?: (input: {
      readonly taskId: bigint;
      readonly attemptIndex: number;
      readonly verdictIndex: number;
      readonly legKind: 1 | 2;
    }) => Promise<void>;
  },
): Promise<void | { ok: false; kind: "unsupported" }> {
  if (config.generation === "today") {
    return { ok: false, kind: "unsupported" };
  }
  if (ports.forfeitDeliveredReservation === undefined) {
    throw new Error("revised forfeitDeliveredReservation port is required");
  }
  await ports.forfeitDeliveredReservation(input);
}

/** Cancellation is a durable, idempotent requester signal; it never revokes a live attempt. */
export async function signalCancel(
  attempt: `urn:uuid:${string}`,
  taskId: bigint,
  attemptIndex: number,
  reason: string,
  ports: {
    requestCancel(input: {
      readonly attempt: `urn:uuid:${string}`;
      readonly taskId: bigint;
      readonly attemptIndex: number;
      readonly reason: string;
    }): Promise<"requested" | "already-requested">;
  },
): Promise<"requested" | "already-requested"> {
  return ports.requestCancel({ attempt, taskId, attemptIndex, reason });
}
