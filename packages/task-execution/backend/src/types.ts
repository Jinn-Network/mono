import type {
  AttemptDescriptor,
  AttemptState,
  DispatchContext,
  ProtocolObservation,
  ResourceDescriptor,
} from "@jinn-network/task-execution-protocol";
import type { TaskExecutionError } from "./errors.js";

/** A minted Submission URI (§8). */
export type SubmissionUri = `urn:uuid:${string}`;
/** A minted Attempt URI (§9.2). */
export type AttemptUri = `urn:uuid:${string}`;

/**
 * The two-party engagement entry (TEP Addendum 2026-07-28-b, program §7.2/§7.22 — an authorized
 * widening of the frozen `submit` contract, marketplace-binding-design Finding F1). A two-party
 * binding (e.g. the marketplace) computes `attemptUri` deterministically via the protocol's
 * exported `deriveAttemptUri` + `TEP_ATTEMPT_NAMESPACE` and builds `dispatchContext` itself; the
 * backend adopts both instead of minting its own random Attempt URI. Single-party callers omit
 * this parameter entirely and observe unchanged single-party semantics.
 */
export interface TwoPartyEngagement {
  attemptUri: AttemptUri;
  dispatchContext: DispatchContext;
}

/**
 * The `submit` acknowledgement (§12.2 idempotency). On acceptance, carries the minted
 * Submission URI and the sealed-Submission digest (the accepted-ack refinement — field-level
 * per §22, pinned by the conformance kit). On rejection, carries the typed error.
 */
export type SubmissionAck =
  | { accepted: true; submission: SubmissionUri; digest: `sha256:${string}` }
  | { accepted: false; error: TaskExecutionError };

/** An opaque, resumable position in an Attempt's observation log. */
export interface ObservationCursor {
  sequence: string;
}

/**
 * The `observe` return (§14): the materialized `AttemptDescriptor` (program §7.16) alongside
 * the log position and the raw observation log. `descriptor.derived` carries the honest derived
 * state; `descriptor.task`/`descriptor.submission`/`descriptor.annotations` name the Attempt's
 * references without the caller re-scanning the observations.
 */
export interface ObservationSnapshot {
  descriptor: AttemptDescriptor;
  cursor: ObservationCursor;
  observations: readonly ProtocolObservation[];
}

/** `recover`'s reconciliation classification (§12.2) — fail loud on `contradictory`. */
export interface ReconciliationReport {
  classification: "matching" | "absent" | "contradictory";
  /**
   * Whether this backend still retains a durable record for the reconciled ref — and therefore
   * still HOLDS its idempotency key, so submitting different bytes under that key would be
   * refused `submission-conflict`.
   *
   * `classification` alone cannot answer that. `absent` is reached from two opposite states: a
   * ref the backend cannot resolve at all (nothing retained, the key is free) and an attempt it
   * fully remembers whose spawn intent left no recoverable shim or outcome (the key is held).
   * Both are honest `absent` reconciliations; only the second forbids re-sealing. Backends have
   * always distinguished them in free-form `detail`, which callers must not parse — this is that
   * same fact, typed.
   *
   * Additive and optional by design: a backend that does not report it leaves it `undefined`, and
   * callers fall back to whatever approximation they used before (see
   * `backendRetainsSubmission` in `@jinn-network/benchmark-product-core`). `undefined` is
   * therefore "not reported", never "not retained" — treat it fail-safe, as retained.
   */
  retained?: boolean;
  detail?: string;
}

/** Terminal-state-aware, idempotent `cancel` acknowledgement (§12.1). */
export interface CancelAck {
  requested: boolean;
  terminalState?: AttemptState;
}

/** A reference to a retrievable Delivery (§11, §14). */
export interface DeliveryRef {
  attempt: AttemptUri;
  digest: `sha256:${string}`;
  locators?: ResourceDescriptor;
}

/**
 * The fail-closed dry-run request (§14: "generalizes Autopilot's fail-closed dry run: prove the
 * configured backend end to end before real work is claimed"). Field-level refinement: an empty
 * request checks bare backend reachability; `taskProfile`/`requirements` scope the check to a
 * specific intended Submission shape, checked against `BackendCapabilities`.
 */
export interface PreflightRequest {
  taskProfile?: string;
  requirements?: Readonly<Record<string, unknown>>;
}

/** The dry-run outcome (§14). */
export interface PreflightReport {
  ready: boolean;
  detail?: string;
  error?: TaskExecutionError;
}
