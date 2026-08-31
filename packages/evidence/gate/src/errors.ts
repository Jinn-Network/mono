// SPDX-License-Identifier: Apache-2.0

/**
 * Every way a request can be refused. A refusal is a value, never a thrown error: a gate
 * answers strangers, and a buyer who mistyped a rail identifier deserves the same shaped
 * answer as one whose payment has not landed yet.
 *
 * Deliberately not an HTTP status vocabulary. A transport binding maps these; the gate
 * itself has no transport.
 */
export const GATE_REFUSAL_CODES = [
  /** No offer with that digest is on this gate. Delisting looks exactly like this. */
  "unknown-offer",
  /** The offer source returned bytes that are not the offer that was asked for. */
  "offer-digest-mismatch",
  /** The offer source returned bytes that are not a well-formed sealed offer. */
  "offer-invalid",
  /** The offer names rails and the request named no payment. */
  "payment-required",
  /** The offer is free and the request named a payment; the request disagrees with the terms. */
  "payment-not-expected",
  /** The request named a rail this offer does not carry. */
  "rail-not-offered",
  /** The offer carries the rail but this gate has no adapter for it. */
  "rail-unsupported",
  /** The rail has not seen a payment referencing this offer under that reference. */
  "payment-not-found",
  /** A payment exists but does not match the sealed rail entry exactly. */
  "payment-mismatch",
  /** Payments on this rail are public, so pickup must prove payer control, and no proof came. */
  "payer-proof-required",
  /** The proof did not answer a live challenge issued by this gate. */
  "challenge-unknown",
  /** The rail refused the proof: whoever is asking is not the payer. */
  "payer-proof-invalid",
  /** The subject's bytes are not on this gate. */
  "subject-unavailable",
  /** The subject's bytes exceed this gate's per-subject bound. */
  "subject-too-large",
  /** The stored bytes do not hash to the subject digest, so they are not the subject. */
  "subject-digest-mismatch",
  /** The rail's own delivery act failed or was refused. */
  "rail-refused-delivery",
  /** Taking the payment failed, so the bytes are not handed over. */
  "claim-failed",
] as const;

export type GateRefusalCode = (typeof GATE_REFUSAL_CODES)[number];

/**
 * A non-blocking note attached to a delivery. The only one today is a delivery statement
 * that could not be sealed — the statement is optional by design, so its failure must not
 * cost a buyer the bytes they paid for, but it must not vanish silently either.
 */
export interface GateWarning {
  readonly code: "statement-not-emitted";
  readonly detail: string;
}

/**
 * Thrown when a gate is built out of parts that cannot honor the protocol — an adapter
 * whose self-description contradicts its methods, two adapters claiming one rail, a
 * publicly-visible rail with no payer-proof check.
 *
 * Thrown rather than returned because it is a deployment defect, not a request outcome:
 * there is no request that would have worked.
 */
export class GateConfigurationError extends Error {
  readonly category = "invalid-configuration" as const;
  override readonly name = "GateConfigurationError";

  constructor(message: string) {
    super(message);
  }
}
