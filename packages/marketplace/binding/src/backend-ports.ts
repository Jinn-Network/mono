// SPDX-License-Identifier: MIT

// The ports `makeMarketplaceBackend` (backend.ts) depends on. Kept in their own module so
// `observe-store.ts` (the reference in-memory implementation) and `backend.ts` (the orchestrator)
// can both import the shapes without a circular dependency.
import type {
  DeliveryRef,
  ObservationCursor,
  ObservationSnapshot,
  ReconciliationReport,
  SubmissionUri,
} from "@jinn-network/task-execution-backend";
import type { ProtocolObservation } from "@jinn-network/task-execution-protocol";
import type { Address } from "viem";
import type { PostingPorts, PostingTerms } from "./posting.js";
import type { PostingOutcome } from "./broadcast-intent.js";

type AttemptUri = `urn:uuid:${string}`;

/** What `observe.lookupSubmissionByScope` needs to answer TEP §12.2 idempotent-resubmission (must match by exact bytes, never by field equality). */
export interface SubmissionScopeRecord {
  readonly submissionUri: SubmissionUri;
  readonly digest: `sha256:${string}`;
  readonly submissionBytes: Uint8Array;
}

export interface RecordSubmissionInput {
  readonly taskDigest: `sha256:${string}`;
  readonly submissionDigest: `sha256:${string}`;
  readonly submissionBytes: Uint8Array;
  readonly submission: unknown; // the parsed SubmissionRecord (kept `unknown` here to avoid a protocol-type import cycle; `observe-store.ts` narrows it)
  readonly outcome: PostingOutcome;
}

/**
 * The projector's `observe` surface, injected so `backend.ts` does not depend on
 * `@jinn-network/marketplace-projector` (Milestone M4, not yet built). `observe-store.ts` ships
 * the reference in-memory implementation used by this milestone's own tests and by
 * `marketplace-testing`'s stubbed-chain conformance run (M2.5); the real M4 projector-backed
 * implementation replaces it without changing this shape.
 */
export interface MarketplaceObservePort {
  lookupSubmissionByScope(requester: string, idempotencyKey: string): Promise<SubmissionScopeRecord | undefined>;
  recordSubmission(input: RecordSubmissionInput): Promise<void>;
  observe(ref: SubmissionUri | AttemptUri): Promise<ObservationSnapshot>;
  recover(ref: SubmissionUri | AttemptUri): Promise<ReconciliationReport>;
  drive(attempt: AttemptUri, observations: readonly ProtocolObservation[]): Promise<void>;
  recordDelivery(attempt: AttemptUri, deliveryBytes: Uint8Array): Promise<void>;
  simulateReconciliation(ref: SubmissionUri | AttemptUri, outcome: ReconciliationReport): void;
  deliveries(attempt: AttemptUri): Promise<DeliveryRef[]>;
  fetchDelivery(ref: DeliveryRef): Promise<Uint8Array>;
}

/** Standard cancellation/close wiring supplied by the chain-generation host (program §7.54). */
export interface MarketplaceLifecyclePorts {
  resolveAttempt(
    attempt: AttemptUri,
  ): Promise<{ readonly taskId: bigint; readonly attemptIndex: number }>;
  /**
   * Atomically persists the requester signal by Attempt. Durable adapters return
   * `already-requested` after restart/replay without emitting a second signal.
   */
  requestCancel(input: {
    readonly attempt: AttemptUri;
    readonly taskId: bigint;
    readonly attemptIndex: number;
    readonly reason: string;
  }): Promise<"requested" | "already-requested">;
  withdrawAnnouncement(input: { readonly taskId: bigint }): Promise<void>;
  refundUnusedTaskBudget?(input: { readonly taskId: bigint }): Promise<void>;
  closeTask?(input: { readonly taskId: bigint }): Promise<void>;
  releaseAttempt?(input: {
    readonly taskId: bigint;
    readonly attemptIndex: number;
  }): Promise<void>;
}

/** Every port `makeMarketplaceBackend` needs. */
export interface MarketplaceBackendPorts {
  readonly creatorSafe: Address;
  readonly terms: PostingTerms;
  readonly posting: PostingPorts;
  readonly observe: MarketplaceObservePort;
  lifecycle?: MarketplaceLifecyclePorts;
}

export type { ObservationCursor };
