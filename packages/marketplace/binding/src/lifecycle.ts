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
/** Cancellation is a requester signal; it never revokes a live attempt on chain. */
export async function signalCancel(taskId: bigint, attemptIndex: number, ports: { signal: (input: { taskId: bigint; attemptIndex: number }) => Promise<void> }): Promise<void> { await ports.signal({ taskId, attemptIndex }); }
