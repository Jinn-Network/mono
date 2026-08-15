// SPDX-License-Identifier: Apache-2.0

export const EVIDENCE_CONTRIBUTION_ERROR_CODES = [
  "INVALID_INPUT",
  "SOURCE_NOT_FOUND",
  "SOURCE_DIGEST_MISMATCH",
  "SOURCE_NONCONFORMING",
  "RESOURCE_LIMIT_EXCEEDED",
  "POLICY_INVALID",
  "POLICY_DENIED",
  "REVIEW_REQUIRED",
  "WITHHELD",
  "AUTHORIZATION_REQUIRED",
  "AUTHORIZATION_DENIED",
  "AUTHORIZATION_EXPIRED",
  "AUTHORIZATION_REVOKED",
  "AUTHORIZATION_STALE",
  "DESTINATION_CONFLICT",
  "DESTINATION_UNSUPPORTED",
  "ACCESS_RETRYABLE",
  "STORE_CONFLICT",
  "STORE_CORRUPT",
  "WORK_CLAIM_HELD",
  "PUBLICATION_RETRYABLE",
  "PUBLICATION_TERMINAL",
  "DEACTIVATION_UNSUPPORTED",
  "DEACTIVATION_RETRYABLE",
  "PORT_PROTOCOL_VIOLATION",
  "OPERATION_ABORTED",
] as const;

export type EvidenceContributionErrorCode =
  (typeof EVIDENCE_CONTRIBUTION_ERROR_CODES)[number];

// Content-free, closed message vocabulary. Core selects a message from this
// map by code; it never forwards an upstream exception's message or stack.
const EVIDENCE_CONTRIBUTION_ERROR_MESSAGES: Readonly<
  Record<EvidenceContributionErrorCode, string>
> = {
  INVALID_INPUT: "The contribution input is invalid.",
  SOURCE_NOT_FOUND: "The source Evidence record was not found.",
  SOURCE_DIGEST_MISMATCH: "The source Evidence bytes do not match the requested digest.",
  SOURCE_NONCONFORMING: "The source Evidence record does not conform to its protocol family.",
  RESOURCE_LIMIT_EXCEEDED: "A declared contribution resource limit was exceeded.",
  POLICY_INVALID: "The disclosure-policy decision is invalid.",
  POLICY_DENIED: "The disclosure-policy authority denied this source.",
  REVIEW_REQUIRED: "The disclosure requires human safety review before it can be prepared.",
  WITHHELD: "The disclosure was withheld and produced no publishable payload.",
  AUTHORIZATION_REQUIRED: "This destination requires authorization before publication.",
  AUTHORIZATION_DENIED: "Authorization for this destination was denied.",
  AUTHORIZATION_EXPIRED: "Authorization for this destination has expired.",
  AUTHORIZATION_REVOKED: "Authorization for this destination has been revoked.",
  AUTHORIZATION_STALE: "Authorization no longer matches the current prepared disclosure.",
  DESTINATION_CONFLICT: "The destination configuration conflicts with the sealed request.",
  DESTINATION_UNSUPPORTED: "The destination does not support the requested operation.",
  ACCESS_RETRYABLE: "A dependency reported a retryable access failure.",
  STORE_CONFLICT: "The durable store rejected a stale or conflicting revision.",
  STORE_CORRUPT: "The durable store returned an impossible or corrupt record.",
  WORK_CLAIM_HELD: "Another worker currently holds the work claim for this request.",
  PUBLICATION_RETRYABLE: "Publication reported a retryable failure for this destination.",
  PUBLICATION_TERMINAL: "Publication reported a terminal failure for this destination.",
  DEACTIVATION_UNSUPPORTED: "This destination does not support deactivation.",
  DEACTIVATION_RETRYABLE: "Deactivation reported a retryable failure for this destination.",
  PORT_PROTOCOL_VIOLATION: "An injected port returned a value that violates its contract.",
  OPERATION_ABORTED: "The operation was aborted.",
};

export interface EvidenceContributionErrorOptions {
  /**
   * The Contribution error code that caused this error, if any. Bounded to
   * one hop: never an arbitrary exception, message, stack, or context
   * object -- only a code from the same closed vocabulary.
   */
  readonly causeCode?: EvidenceContributionErrorCode;
}

export class EvidenceContributionError extends Error {
  override readonly name = "EvidenceContributionError";
  readonly code: EvidenceContributionErrorCode;
  readonly causeChain: readonly EvidenceContributionErrorCode[];

  constructor(
    code: EvidenceContributionErrorCode,
    options: EvidenceContributionErrorOptions = {},
  ) {
    super(EVIDENCE_CONTRIBUTION_ERROR_MESSAGES[code]);
    this.code = code;
    this.causeChain =
      options.causeCode === undefined ? [] : [options.causeCode];
  }
}

export function isEvidenceContributionErrorCode(
  value: unknown,
  code: EvidenceContributionErrorCode,
): boolean {
  return (
    value instanceof EvidenceContributionError && value.code === code
  );
}
