// SPDX-License-Identifier: MIT

// Written fresh against the venue kit's fixture table (design §6.6). The legacy
// `client/src/tx-retry.ts` is the behavioral oracle those fixtures were derived from; no line of
// it is ported here.
import { KNOWN_INNER_ERRORS, SafeInnerRevertError } from "@jinn-network/marketplace-binding";

export type VenueRevertClassification = "permanent" | "retryable" | "already-settled";

export const BROADCAST_DEFAULTS = {
  maxAttempts: 6,
  baseDelayMs: 400,
  maxDelayMs: 12_000,
  /** Extra bump per retry attempt after the first, in basis points. */
  feeBumpBpsPerAttempt: 1500,
  /** Minimum bump over the previously submitted fee for same-nonce replacement. */
  replacementBumpBps: 1500,
  stuckNonceAfterMs: 120_000,
  lockLeaseMs: 60_000,
} as const;

/**
 * Inner reverts whose effect is already on chain. The caller treats them as success rather
 * than as failure -- a replayed settlement or a duplicate registration is the intended state.
 */
const ALREADY_SETTLED_INNER = new Set([
  "RouterAlreadyClaimed",
  "TCAttemptAlreadyRegistered",
  "TCAttemptAlreadySubmitted",
  "TCAttemptAlreadyFinalized",
  "TCRequestAlreadyRegistered",
  "TCVerdictAlreadyRegistered",
  "TCVerdictAlreadyDelivered",
]);

/** The one inner revert that clears by waiting: the Mech delivery has not landed yet. */
const RETRYABLE_INNER = new Set(["RouterNotDelivered"]);

const PERMANENT_SUBSTRINGS = [
  "insufficient funds",
  "user rejected",
  "user denied",
  "rejected the request",
  "gs013",
  "gs026",
];

const RETRYABLE_SUBSTRINGS = [
  "nonce too low",
  "already known",
  "could not coalesce",
  "replacement transaction underpriced",
  "replacement fee too low",
  "transaction underpriced",
  "fee cap less than block base fee",
  "max fee per gas less than block base fee",
  "econnreset",
  "etimedout",
  "socket hang up",
  "fetch failed",
  "network error",
  "connection refused",
  "connect timeout",
  "all rpc providers in the fallback chain failed",
  'returned no data ("0x")',
  "cannot decode zero data",
  "the address is not a contract",
  "429",
  "rate limit",
  "too many requests",
  "-32603",
  "internal json-rpc error",
  "-32005",
  "request timed out",
  "timeout",
  "bad gateway",
  "service unavailable",
  "502",
  "503",
];

/** Flattens an error and its `cause` chain into one lowercase-matchable string. */
export function flattenError(error: unknown): string {
  if (error === null || error === undefined) return String(error);
  if (typeof error === "string") return error;
  if (error instanceof Error) {
    const withCause = error as Error & { cause?: unknown };
    return withCause.cause === undefined || withCause.cause === null
      ? error.message
      : `${error.message} | ${flattenError(withCause.cause)}`;
  }
  if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    const parts = [record["shortMessage"], record["details"], record["message"]]
      .filter((part): part is string => typeof part === "string");
    if (parts.length > 0) return [...new Set(parts)].join(" | ");
  }
  return String(error);
}

export function isNonceTooLow(error: unknown): boolean {
  return flattenError(error).toLowerCase().includes("nonce too low");
}

export function isReplacementUnderpriced(error: unknown): boolean {
  const lower = flattenError(error).toLowerCase();
  return lower.includes("replacement transaction underpriced")
    || lower.includes("replacement fee too low")
    || lower.includes("transaction underpriced");
}

function classifyInnerRevert(error: SafeInnerRevertError): VenueRevertClassification {
  const { decodedName } = error;
  if (decodedName !== null) {
    if (ALREADY_SETTLED_INNER.has(decodedName)) return "already-settled";
    if (RETRYABLE_INNER.has(decodedName)) return "retryable";
    if (KNOWN_INNER_ERRORS[error.innerSelector?.toLowerCase() ?? ""] !== undefined) return "permanent";
    return "permanent";
  }
  // No decoded name but a captured selector: the inner call reverts deterministically and will
  // revert identically on every retry. Classifying it permanent is what stops the wrapping
  // GS013 from being retried forever.
  if (error.innerSelector !== null) return "permanent";
  return "retryable";
}

export function classifyBroadcastError(error: unknown): VenueRevertClassification {
  if (error instanceof SafeInnerRevertError) return classifyInnerRevert(error);
  const lower = flattenError(error).toLowerCase();
  for (const substring of PERMANENT_SUBSTRINGS) {
    if (lower.includes(substring)) return "permanent";
  }
  for (const substring of RETRYABLE_SUBSTRINGS) {
    if (lower.includes(substring)) return "retryable";
  }
  return "permanent";
}
