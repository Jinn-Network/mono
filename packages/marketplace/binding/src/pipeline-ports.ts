// SPDX-License-Identifier: MIT

// Port-type home (operator-daemon composition design §6.1, program §6 contract 8). These three
// ports are *declared* by `@jinn-network/marketplace-pipeline` and *implemented* by
// `@jinn-network/marketplace-venue-base`. Re-homing the declarations here keeps the tier-3
// adapter tree depending on binding types only, off the application-shaped pipeline package.
// They are re-declared, not imported: the binding may never import the pipeline (that would
// invert the tree's DAG, and the source-boundary guard forbids it). `pipeline-ports.test.ts`
// in the pipeline package pins the two declarations structurally equal.
import type { AttemptUri, TaskExecutionBackend } from "@jinn-network/task-execution-backend";
import type { AttemptState } from "@jinn-network/task-execution-protocol";
import type { Hex } from "viem";

export type FinalityAwaitResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: "reorged" | "failed" };

/** Required injected port: gate expensive execution on finalized claim facts (design §8, N2). */
export interface FinalityPort {
  awaitFinalized(input: {
    readonly taskId: bigint;
    readonly attemptIndex: number;
    readonly claimTxHash: Hex;
  }): Promise<FinalityAwaitResult>;
}

export type DeliveryWaitResult =
  | { readonly ok: true; readonly deliveryBytes: Uint8Array }
  | {
      readonly ok: false;
      readonly kind: "timeout" | "cancelled" | "backend-terminal";
      readonly state?: AttemptState;
    };

/** Cancel/timeout-aware delivery wait — the library owns no poll timer policy. */
export interface DeliveryWaitPort {
  waitForDelivery(input: {
    readonly attemptUri: AttemptUri;
    readonly backend: TaskExecutionBackend;
    readonly signal?: AbortSignal;
  }): Promise<DeliveryWaitResult>;
}

export interface ReleaseAttemptPort {
  releaseAttempt(input: {
    readonly taskId: bigint;
    readonly attemptIndex: number;
  }): Promise<void | { readonly ok: false; readonly kind: "unsupported" }>;
  forfeitDeliveredReservation?(input: {
    readonly taskId: bigint;
    readonly attemptIndex: number;
    readonly verdictIndex: number;
    readonly legKind: 1 | 2;
  }): Promise<void>;
}
