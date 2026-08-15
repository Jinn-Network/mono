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
  TwoPartyEngagement,
} from "@jinn-network/task-execution-backend";
import type { ProtocolObservation } from "@jinn-network/task-execution-protocol";
import type { Address } from "viem";
import type { PostingPorts, PostingTerms } from "./posting.js";
import type { PostingOutcome } from "./broadcast-intent.js";

type AttemptUri = `urn:uuid:${string}`;

/** Durable requester-scope completion record for TEP §12.2 idempotent resubmission (must match by exact bytes, never by field equality). */
export interface SubmissionScopeRecord {
  readonly submissionUri: SubmissionUri;
  readonly digest: `sha256:${string}`;
  readonly submissionBytes: Uint8Array;
  /** Present for Phase C scopes. Absent only on pre-v5 durable rows. */
  readonly taskDigest?: `sha256:${string}`;
  /** Present for Phase C scopes. Absent only on pre-v5 durable rows. */
  readonly creatorSafe?: Address;
  /** Exact venue namespace and command digest bound before any external effect. */
  readonly venueNamespace?: string;
  readonly commandDigest?: `sha256:${string}`;
  /** Stable textual form of the full Phase C posting WAL key. */
  readonly postingIntentKey?: string;
  /** The exact WAL outcome adopted by this logical requester scope. */
  readonly outcome?: PostingOutcome;
  /** A pre-v5 unresolved row cannot be joined safely to a posting intent. */
  readonly legacyScopeUnrecoverable?: true;
}

export interface ClaimSubmissionScopeInput {
  readonly submissionUri: SubmissionUri;
  readonly digest: `sha256:${string}`;
  readonly submissionBytes: Uint8Array;
  readonly requester: string;
  readonly idempotencyKey: string;
  readonly taskDigest: `sha256:${string}`;
  readonly creatorSafe: Address;
  readonly venueNamespace: string;
  readonly commandDigest: `sha256:${string}`;
  readonly postingIntentKey: string;
}

export interface PendingSubmissionScopeRecord extends ClaimSubmissionScopeInput {}

export interface ResolveRecoveredSubmissionScopeInput extends ClaimSubmissionScopeInput {}

declare const submissionScopeOwnerTokenBrand: unique symbol;
/** Durable, unguessable authority held only by the atomically accepted requester-scope owner. */
export type SubmissionScopeOwnerToken = string & {
  readonly [submissionScopeOwnerTokenBrand]: "SubmissionScopeOwnerToken";
};

export type SubmissionScopeClaim =
  | { readonly kind: "owner"; readonly ownerToken: SubmissionScopeOwnerToken }
  | { readonly kind: "pending" }
  | { readonly kind: "resolved"; readonly record: SubmissionScopeRecord }
  | { readonly kind: "conflict" };

export type RecoveredSubmissionScopeResolution =
  | "resolved"
  | "already-resolved"
  | "no-intent"
  | "pending-intent"
  | "conflict"
  | "legacy-scope-unrecoverable";

export interface RecordSubmissionInput {
  readonly taskDigest: `sha256:${string}`;
  readonly submissionDigest: `sha256:${string}`;
  readonly submissionBytes: Uint8Array;
  readonly submission: unknown; // the parsed SubmissionRecord (kept `unknown` here to avoid a protocol-type import cycle; `observe-store.ts` narrows it)
  readonly outcome: PostingOutcome;
  /**
   * When present (TEP Addendum 2026-07-28-b), the observe port adopts the caller-minted
   * Attempt URI and records `dispatchContext` verbatim instead of minting a deterministic
   * self-claim URI for the stub/conformance path.
   */
  readonly engagement?: TwoPartyEngagement;
}

/**
 * The projector's `observe` surface, injected so `backend.ts` does not depend on
 * `@jinn-network/marketplace-projector` (Milestone M4, not yet built). `observe-store.ts` ships
 * the reference in-memory implementation used by this milestone's own tests and by
 * `marketplace-testing`'s stubbed-chain conformance run (M2.5); the real M4 projector-backed
 * implementation replaces it without changing this shape.
 */
export interface MarketplaceObservePort {
  /**
   * Linearizable requester/idempotency ownership. The exact Submission bytes and digest are
   * bound before callers may upload, create a posting intent, or exercise wallet authority.
   */
  claimSubmissionScope(input: ClaimSubmissionScopeInput): Promise<SubmissionScopeClaim>;
  /** Read without claiming; used by the outcome-bearing requester API after a generic submit. */
  readSubmissionScope(requester: string, idempotencyKey: string): Promise<SubmissionScopeRecord | undefined>;
  /** Enumerate unresolved logical scopes so a restarted backend can join resolved WAL outcomes. */
  scanPendingSubmissionScopes(): Promise<readonly (PendingSubmissionScopeRecord | (SubmissionScopeRecord & {
    readonly requester: string;
    readonly idempotencyKey: string;
    readonly legacyScopeUnrecoverable: true;
  }))[]>;
  /**
   * Replace a dead logical-scope owner only after the backend proved that no matching posting WAL
   * exists. This never authorizes a broadcast; `postTask` must still claim and fence the WAL.
   */
  reclaimSubmissionScope(input: ClaimSubmissionScopeInput): Promise<SubmissionScopeClaim>;
  /**
   * Join an already-resolved WAL outcome to the exact pending logical scope after restart. The
   * durable implementation must read the WAL and update the scope atomically; callers never
   * supply an outcome as evidence.
   */
  resolveRecoveredSubmissionScope(
    input: ResolveRecoveredSubmissionScopeInput,
  ): Promise<RecoveredSubmissionScopeResolution>;
  /** Only the owner returned by `claimSubmissionScope` may publish the durable completion. */
  resolveSubmissionScope(input: RecordSubmissionInput, ownerToken: SubmissionScopeOwnerToken): Promise<void>;
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
