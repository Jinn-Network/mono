import type { ProtocolObservation, ResourceDescriptor } from "@jinn-network/task-execution-protocol";
import type { BackendCapabilities } from "./capabilities.js";
import type {
  AttemptUri,
  CancelAck,
  DeliveryRef,
  ObservationCursor,
  ObservationSnapshot,
  PreflightReport,
  PreflightRequest,
  ReconciliationReport,
  SubmissionAck,
  SubmissionUri,
} from "./types.js";

/**
 * The Task Execution Protocol v1 backend contract (design §14). Names and responsibilities are
 * frozen at this granularity (§22); field-level refinement of the supporting types happens at
 * implementation without changing this interface's shape.
 *
 * The contract must never expose: shared-mutation capability (no repository pushes, no GitHub
 * verbs), credential passthrough, application-lifecycle authority, or settlement operations.
 */
export interface TaskExecutionBackend {
  capabilities(): Promise<BackendCapabilities>;

  /** Optional capability. Generalizes Autopilot's fail-closed dry run: prove the configured backend end to end before real work is claimed. */
  preflight?(request: PreflightRequest): Promise<PreflightReport>;

  /**
   * Takes **both sealed documents as exact bytes** — never parsed-and-reserialized objects —
   * because both carry byte identity and, under signing profiles, DSSE signatures over those
   * exact bytes. Idempotent per §12.2: byte-identical resubmission under the same
   * (requester, backend, idempotencyKey) scope returns the existing acknowledgement; a
   * same-key/different-bytes resubmission is a typed `submission-conflict` rejection.
   */
  submit(taskBytes: Uint8Array, submissionBytes: Uint8Array): Promise<SubmissionAck>;

  /**
   * Returns the derived state plus the observation log position. It is honest: it distinguishes
   * running, terminal, and unknown; it never infers success from liveness. `observe` materializes
   * the `AttemptDescriptor` it returns (program §7.16): it folds the observation log (passing
   * `{ now, effectiveDeadline }` so provisional `expired` derives when due) and fills the
   * descriptor's reference fields — the one Task digest, the one Submission URI, and correlation
   * annotations — from the Submission + dispatch context the backend already holds, never from a
   * re-scan by the caller.
   */
  observe(ref: SubmissionUri | AttemptUri): Promise<ObservationSnapshot>;

  /** Optional capability. A resumable, cursor-based push view over the same observation log. No callback topology is imposed; applications may poll `observe` instead. */
  watch?(ref: SubmissionUri | AttemptUri, cursor?: ObservationCursor): AsyncIterable<ProtocolObservation>;

  /** Optional capability. Terminal-state-aware and idempotent (§12.1): cancelling an already-terminal Attempt returns the terminal state, never an error. */
  cancel?(attempt: AttemptUri, reason: string): Promise<CancelAck>;

  /**
   * Mandatory. Rebuilds from durable records, reconciles against backend-native state, and
   * returns the `matching | absent | contradictory` classification (§12.2). A backend that
   * cannot recover is not a conforming backend.
   */
  recover(ref: SubmissionUri | AttemptUri): Promise<ReconciliationReport>;

  /** The result path (§11): lists the Deliveries recorded for an Attempt. */
  deliveries(attempt: AttemptUri): Promise<DeliveryRef[]>;

  /** Returns exact bytes. `result-unavailable` is a loud error for a terminal Attempt whose content cannot be retrieved, never a shrug. */
  fetchDelivery(ref: DeliveryRef): Promise<Uint8Array>;

  /** Optional capability. Additional artifact retrieval beyond what the caller can resolve from locators. */
  fetchArtifact?(descriptor: ResourceDescriptor): Promise<Uint8Array>;
}
