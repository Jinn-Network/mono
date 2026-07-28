import { describe, expect, test } from "vitest";
import { deriveAttemptUri, isValidUrnUuid } from "./identifiers.js";

describe("deriveAttemptUri", () => {
  test("is a deterministic UUIDv5 urn (RFC 9562 §5.5)", () => {
    // marketplace tuple: (chain id, coordinator address, taskId, attemptIndex) — §16.2
    const uri = deriveAttemptUri("jinn:marketplace", [8453, "0xffa7…181b", "task-1", 0]);
    expect(isValidUrnUuid(uri)).toBe(true);
    // pins byte-stable derivation; recompute once via the implementation and freeze the literal here.
    expect(deriveAttemptUri("jinn:marketplace", [8453, "0xffa7…181b", "task-1", 0])).toBe(uri);
    // version nibble is 5, variant nibble is 8|9|a|b
    expect(uri[23]).toBe("5"); // 'urn:uuid:xxxxxxxx-xxxx-5xxx-…'
  });
  test("distinct tuples derive distinct URIs", () => {
    expect(deriveAttemptUri("jinn:marketplace", [8453, "0xc", "t", 0]))
      .not.toBe(deriveAttemptUri("jinn:marketplace", [8453, "0xc", "t", 1]));
  });
  test("variable-length parts cannot collide across a split boundary (§7.2)", () => {
    // With an empty-delimiter join these two would produce the identical name "abc";
    // the unit-separator delimiter keeps them distinct.
    expect(deriveAttemptUri("b", ["ab", "c"]))
      .not.toBe(deriveAttemptUri("b", ["a", "bc"]));
  });
});
