// SPDX-License-Identifier: MIT

// NO UUIDv5 CODE IN THIS FILE (must #2; program §7.2; design §6.2/§11.6). The deterministic
// Attempt URI is computed ONLY by calling the protocol package's exported `deriveAttemptUri`
// over `TEP_ATTEMPT_NAMESPACE`. This module is a thin adapter: it owns the marketplace binding
// name constant and the frozen tuple-normalization rule, then hands both to the protocol
// export. It never re-implements the namespace UUID, the name-construction delimiter, or the
// SHA-1-based UUIDv5 derivation -- see `attempt-uri.test.ts` case (a), which asserts
// byte-for-byte equality against a direct `deriveAttemptUri` call over the same normalized
// tuple.
import { deriveAttemptUri } from "@jinn-network/task-execution-protocol";

/** The marketplace binding name (frozen; matches the protocol package's own identifiers.test.ts pin). */
export const MARKETPLACE_BINDING_NAME = "jinn:marketplace";

/** The chain-tuple input identifying a marketplace claim (design §6.2). */
export interface MarketplaceAttemptTuple {
  readonly chainId: number;
  readonly coordinator: `0x${string}`;
  readonly taskId: bigint;
  readonly attemptIndex: number;
}

/**
 * The frozen tuple-normalization rule (design §6.2/§16.2): lowercasing the coordinator address
 * and decimal-stringifying `taskId`/`attemptIndex` so requester, operator, and any third party
 * derive byte-identical name bytes from the same public on-chain facts, regardless of checksum
 * casing or numeric-vs-string representation choices at each call site.
 */
export function normalizeAttemptTuple(
  input: MarketplaceAttemptTuple,
): readonly (string | number)[] {
  return [
    input.chainId,
    input.coordinator.toLowerCase(),
    input.taskId.toString(),
    input.attemptIndex.toString(),
  ];
}

/**
 * Derives the deterministic marketplace Attempt URI: a thin call into the protocol package's
 * exported `deriveAttemptUri`, over the normalized marketplace tuple. Consumed, never
 * re-derived.
 */
export function deriveMarketplaceAttemptUri(
  input: MarketplaceAttemptTuple,
): `urn:uuid:${string}` {
  return deriveAttemptUri(MARKETPLACE_BINDING_NAME, normalizeAttemptTuple(input));
}
