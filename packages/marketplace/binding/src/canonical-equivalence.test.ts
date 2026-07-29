// The marketplace tree's own backend-internal canonical bytes (broadcast-intent WAL record,
// correspondence-assertion payload) are the ONLY thing `serializeCanonical` seals. This fixture
// pins two digest-sensitive record shapes so a future refactor of `serializeCanonical` cannot
// silently change the emitted bytes.
//
// Documented assertion (program §7.15 discipline): the marketplace tree produces NO new sealed
// TEP or discovery document family. TEP Task/Submission/Delivery documents are sealed by
// `@jinn-network/task-execution-protocol` (`sealTask`/`sealSubmission`/`sealDelivery`); signed
// discovery announcements are sealed by `@jinn-network/record-discovery-serve`. Nobody should add
// a duplicate serializer for either family under `packages/marketplace/` -- this test exists so a
// reviewer can point at it as the record of that decision, not to enforce it mechanically (there
// is no importable symbol to assert an "absence" of).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, test } from "vitest";
import { serializeCanonical, type JsonValue } from "./canonical-json.js";

function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "canonical-equivalence.json",
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  keySortSensitive: { record: JsonValue; sha256Hex: string };
  integerLikeKeys: { record: JsonValue; sha256Hex: string };
};

describe("canonical-equivalence fixture (pinned digests)", () => {
  test("the object-key-sort-sensitive record seals to its pinned digest", () => {
    const bytes = new TextEncoder().encode(serializeCanonical(fixture.keySortSensitive.record));
    expect(sha256Hex(bytes)).toBe(fixture.keySortSensitive.sha256Hex);
  });

  test("the integer-like-key record seals to its pinned digest", () => {
    const bytes = new TextEncoder().encode(serializeCanonical(fixture.integerLikeKeys.record));
    expect(sha256Hex(bytes)).toBe(fixture.integerLikeKeys.sha256Hex);
  });

  test("pinned digests are real sha256 hex, not placeholders", () => {
    expect(fixture.keySortSensitive.sha256Hex).toMatch(/^[0-9a-f]{64}$/);
    expect(fixture.integerLikeKeys.sha256Hex).toMatch(/^[0-9a-f]{64}$/);
  });
});
