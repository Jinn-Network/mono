// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { KNOWN_INNER_ERRORS, SafeInnerRevertError } from "@jinn-network/marketplace-binding";
import {
  VENUE_REVERT_FIXTURES,
  describeVenueRevertClassification,
  type VenueRevertClassification,
} from "./venue-fixtures.js";

// The one selector-derived fixture that is deliberately undecoded (it proves an unrecognized
// selector still classifies "permanent" -- see venue-fixtures.ts); it is excluded from the
// "every fixture selector is decodable" sweep below by construction, not by accident.
const UNDECODED_SELECTOR_FIXTURE_NAME = "undecoded-inner-selector";

// Mirrors venue-fixtures.ts's ALREADY_SETTLED set. Duplicated here (rather than imported) because
// the reference classifier below must independently reconstruct the classification -- if it
// imported the answer key, the fixture-per-case sweep would not "prove the driver actually
// asserts" the way the file's own comment promises.
const ALREADY_SETTLED_NAMES = new Set([
  "RouterAlreadyClaimed",
  "TCAttemptAlreadySubmitted",
  "TCAttemptAlreadyFinalized",
  "TCVerdictAlreadyDelivered",
  "TCRequestAlreadyRegistered",
  "TCAttemptAlreadyRegistered",
  "TCVerdictAlreadyRegistered",
]);

describe("venue revert-classification fixtures (design §6.6: legacy tables enter as test cases)", () => {
  test("every fixture selector is a decodable inner error the binding already knows", () => {
    for (const fixture of VENUE_REVERT_FIXTURES) {
      if (fixture.selector === "0x" || fixture.name === UNDECODED_SELECTOR_FIXTURE_NAME) continue;
      expect(KNOWN_INNER_ERRORS[fixture.selector], fixture.name).toBeDefined();
    }
  });

  test("the permanent and already-settled sets together cover every router and coordinator custom error the binding decodes", () => {
    const nonRetryable = new Set(
      VENUE_REVERT_FIXTURES.filter((f) => f.expected !== "retryable").map((f) => f.name),
    );
    const decodable = Object.values(KNOWN_INNER_ERRORS).map((entry) => entry.name);
    const missing = decodable.filter(
      (name) => name !== "RouterNotDelivered" && !nonRetryable.has(name),
    );
    expect(missing).toEqual([]);
  });

  test("RouterNotDelivered is retryable, not permanent (marketplace state may not have settled yet)", () => {
    const fixture = VENUE_REVERT_FIXTURES.find((f) => f.name === "RouterNotDelivered");
    expect(fixture?.expected).toBe<VenueRevertClassification>("retryable");
  });

  test("RouterAlreadyClaimed classifies already-settled, so an idempotent replay is not an error", () => {
    const fixture = VENUE_REVERT_FIXTURES.find((f) => f.name === "RouterAlreadyClaimed");
    expect(fixture?.expected).toBe<VenueRevertClassification>("already-settled");
  });

  describeVenueRevertClassification({
    classify(error) {
      // A deliberately wrong reference classifier proves the driver actually asserts.
      if (error instanceof SafeInnerRevertError && error.decodedName === "RouterNotDelivered") {
        return "retryable";
      }
      if (
        error instanceof SafeInnerRevertError &&
        error.decodedName &&
        ALREADY_SETTLED_NAMES.has(error.decodedName)
      ) {
        return "already-settled";
      }
      if (error instanceof SafeInnerRevertError) return "permanent";
      const message = error instanceof Error ? error.message : String(error);
      const lower = message.toLowerCase();
      if (lower.includes("gs013") || lower.includes("gs026")) return "permanent";
      if (lower.includes("insufficient funds")) return "permanent";
      if (lower.includes("user rejected")) return "permanent";
      return "retryable";
    },
  });
});
