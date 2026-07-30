// SPDX-License-Identifier: MIT

// Legacy behavior as fixtures (operator-daemon composition design §6.6). Every case below is
// derived by READING the legacy oracles -- `client/src/tx-retry.ts`'s PERMANENT set and its
// recoverable-substring ladder, `client/src/adapters/mech/safe.ts`'s GS013/GS026 handling, and
// `client/src/adapters/mech/contracts.ts`'s claimDelivery ladder -- and re-expressing them as
// data. No legacy code is ported; the fresh venue-base implementation must satisfy these.
import { KNOWN_INNER_ERRORS, SafeInnerRevertError } from "@jinn-network/marketplace-binding";
import { describe, expect, test } from "vitest";
import type { Hex } from "viem";

/**
 * `permanent`   — reverts identically on every retry; fail fast and surface the reason.
 * `retryable`   — clears by waiting, refreshing nonce/fees, or hitting a healthy provider.
 * `already-settled` — the intended effect is already on chain; the caller treats it as success.
 */
export type VenueRevertClassification = "permanent" | "retryable" | "already-settled";

export interface VenueRevertFixture {
  readonly name: string;
  /** `0x` marks a string-only case with no inner selector. */
  readonly selector: Hex | "0x";
  readonly error: unknown;
  readonly expected: VenueRevertClassification;
}

const ALREADY_SETTLED = new Set([
  "RouterAlreadyClaimed",
  "TCAttemptAlreadySubmitted",
  "TCAttemptAlreadyFinalized",
  "TCVerdictAlreadyDelivered",
  "TCRequestAlreadyRegistered",
  "TCAttemptAlreadyRegistered",
  "TCVerdictAlreadyRegistered",
]);

function innerRevert(name: string, selector: Hex): SafeInnerRevertError {
  return new SafeInnerRevertError(
    `Safe execTransaction inner revert: ${name}`,
    selector,
    selector,
    name,
    null,
    null,
  );
}

/** One fixture per decodable inner error, plus the undecoded-selector and string-only ladder. */
export const VENUE_REVERT_FIXTURES: readonly VenueRevertFixture[] = [
  ...Object.entries(KNOWN_INNER_ERRORS).map(([selector, entry]): VenueRevertFixture => ({
    name: entry.name,
    selector: selector as Hex,
    error: innerRevert(entry.name, selector as Hex),
    expected: entry.name === "RouterNotDelivered"
      ? "retryable"
      : ALREADY_SETTLED.has(entry.name)
        ? "already-settled"
        : "permanent",
  })),
  {
    // A deterministic inner revert whose selector we do not decode still reverts identically on
    // every retry (tx-retry.ts: "classify it terminal instead of retrying the wrapping GS013").
    name: "undecoded-inner-selector",
    selector: "0x33f626d3",
    error: new SafeInnerRevertError(
      "Safe execTransaction inner revert (undecoded selector 0x33f626d3)",
      "0x33f626d3",
      "0x33f626d3",
      null,
      null,
      null,
    ),
    expected: "permanent",
  },
  {
    // Bare GS013 with no recoverable inner data: the Safe's inner call reverted deterministically.
    name: "bare-GS013",
    selector: "0x",
    error: new Error("execution reverted: GS013"),
    expected: "permanent",
  },
  {
    // GS026 reaching the shared classifier is terminal; the broadcaster distinguishes a
    // non-owner (terminal) from a valid owner with a stale signed nonce before it gets here.
    name: "bare-GS026",
    selector: "0x",
    error: new Error("execution reverted: GS026"),
    expected: "permanent",
  },
  { name: "insufficient-funds", selector: "0x", error: new Error("insufficient funds for gas * price + value"), expected: "permanent" },
  { name: "user-rejected", selector: "0x", error: new Error("User rejected the request"), expected: "permanent" },
  { name: "nonce-too-low", selector: "0x", error: new Error("nonce too low"), expected: "retryable" },
  { name: "already-known", selector: "0x", error: new Error("already known"), expected: "retryable" },
  { name: "could-not-coalesce", selector: "0x", error: new Error("could not coalesce error"), expected: "retryable" },
  { name: "replacement-underpriced", selector: "0x", error: new Error("replacement transaction underpriced"), expected: "retryable" },
  { name: "replacement-fee-too-low", selector: "0x", error: new Error("replacement fee too low"), expected: "retryable" },
  { name: "transaction-underpriced", selector: "0x", error: new Error("transaction underpriced"), expected: "retryable" },
  { name: "fee-cap-below-base-fee", selector: "0x", error: new Error("fee cap less than block base fee"), expected: "retryable" },
  { name: "max-fee-below-base-fee", selector: "0x", error: new Error("max fee per gas less than block base fee"), expected: "retryable" },
  { name: "econnreset", selector: "0x", error: new Error("read ECONNRESET"), expected: "retryable" },
  { name: "etimedout", selector: "0x", error: new Error("connect ETIMEDOUT"), expected: "retryable" },
  { name: "socket-hang-up", selector: "0x", error: new Error("socket hang up"), expected: "retryable" },
  { name: "fetch-failed", selector: "0x", error: new Error("fetch failed"), expected: "retryable" },
  { name: "connection-refused", selector: "0x", error: new Error("connection refused"), expected: "retryable" },
  { name: "all-providers-failed", selector: "0x", error: new Error("All RPC providers in the fallback chain failed"), expected: "retryable" },
  { name: "no-data-returned", selector: "0x", error: new Error('The contract function "nonce" returned no data ("0x").'), expected: "retryable" },
  { name: "cannot-decode-zero-data", selector: "0x", error: new Error('Cannot decode zero data ("0x") with ABI parameters.'), expected: "retryable" },
  { name: "address-is-not-a-contract", selector: "0x", error: new Error("The address is not a contract."), expected: "retryable" },
  { name: "rate-limited-429", selector: "0x", error: new Error("HTTP 429 Too Many Requests"), expected: "retryable" },
  { name: "internal-json-rpc", selector: "0x", error: new Error("Internal JSON-RPC error (-32603)"), expected: "retryable" },
  { name: "limit-exceeded-32005", selector: "0x", error: new Error("limit exceeded (-32005)"), expected: "retryable" },
  { name: "request-timed-out", selector: "0x", error: new Error("request timed out"), expected: "retryable" },
  { name: "bad-gateway-502", selector: "0x", error: new Error("502 Bad Gateway"), expected: "retryable" },
  { name: "service-unavailable-503", selector: "0x", error: new Error("503 Service Unavailable"), expected: "retryable" },
];

export interface VenueRevertClassifier {
  classify(error: unknown): VenueRevertClassification;
}

/** Drives every fixture through a candidate classifier. */
export function describeVenueRevertClassification(classifier: VenueRevertClassifier): void {
  describe("venue revert classification conformance", () => {
    for (const fixture of VENUE_REVERT_FIXTURES) {
      test(`${fixture.name} classifies ${fixture.expected}`, () => {
        expect(classifier.classify(fixture.error)).toBe(fixture.expected);
      });
    }
  });
}
