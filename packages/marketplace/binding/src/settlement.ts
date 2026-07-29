// SPDX-License-Identifier: MIT

import type { AttemptState } from "@jinn-network/task-execution-protocol";
import type { Hex } from "viem";
import { convergeDelivery } from "./delivery.js";
import type { IpfsPinPort } from "./venue/ipfs.js";

export function mapRaceLoss(chainOutcome: "rejected" | "delivered-unsettled"): AttemptState {
  return chainOutcome === "rejected" ? "rejected" : "delivered";
}
export async function settleDelivery(attempt: { requestId: Hex }, sealedDeliveryBytes: Uint8Array, ports: { pin: IpfsPinPort["pin"]; claimSolutionDelivery: (input: { requestId: Hex; solutionDigest: Hex }) => Promise<{ status: "settled" | "already-settled" | "rejected" | "delivered-unsettled" }> }): Promise<{ settled: boolean; state: AttemptState }> {
  const delivery = await convergeDelivery(sealedDeliveryBytes, { pin: ports.pin });
  const result = await ports.claimSolutionDelivery({ requestId: attempt.requestId, solutionDigest: delivery.keccakEvidenceHash });
  if (result.status === "settled" || result.status === "already-settled") return { settled: true, state: "delivered" };
  return { settled: false, state: mapRaceLoss(result.status) };
}
