import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { ANCHOR_INTENT_EXTENSION, BEACON_SOURCE_EXTENSION, TASK_SELECTION_EXTENSION } from "./identifiers.js";
import { InvalidDocumentError } from "./sealing.js";
import { parseRun, sealRun } from "./run/schema.js";
import {
  RunBeaconSourceExtensionSchema,
  readBeaconSource,
  readRunBeaconSourceExtension,
  runBeaconSourceExtension,
  withRunBeaconSourceExtension,
} from "./beacon-source.js";

function minimalRun(): Record<string, unknown> {
  const url = new URL("../fixtures/run/minimal.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>;
}

/** `sealRun(minimalRun()).digest` as it stood before `beacon-source/v1` existed. */
const UNDECLARED_MINIMAL_RUN_DIGEST = "sha256:cf9266be44722aa97a2da6d461ae761445022e6fafdd2d709bbeaeb6a69b5ed5";

describe("the beacon-source extension key", () => {
  test("is a namespaced extension URI, distinct from the other Run extensions", () => {
    expect(BEACON_SOURCE_EXTENSION).toBe("https://spec.jinn.network/extensions/beacon-source/v1");
    expect(new Set([BEACON_SOURCE_EXTENSION, TASK_SELECTION_EXTENSION, ANCHOR_INTENT_EXTENSION]).size).toBe(3);
  });
});

describe("the declaration's shape", () => {
  test("refuses an empty or absent source", () => {
    expect(RunBeaconSourceExtensionSchema.safeParse({ source: "" }).success).toBe(false);
    expect(RunBeaconSourceExtensionSchema.safeParse({}).success).toBe(false);
  });

  test("refuses a key it cannot honor, so the sealed bytes carry nothing readers ignore", () => {
    expect(() => runBeaconSourceExtension({ source: "drand/quicknet", note: "but really" })).toThrow();
  });

  test("admits any source id: the admitted-source registry lives in the verifier, not here", () => {
    // Deliberate. This package cannot import the reference verifier -- the verifier depends on it --
    // and a mirrored id list would be a second list free to drift from the one the derivation uses.
    // The producer refuses a source no procedure admits before it seals one.
    expect(RunBeaconSourceExtensionSchema.safeParse({ source: "drand/nonesuch" }).success).toBe(true);
  });
});

describe("attaching and reading the declaration", () => {
  test("round-trips through a sealed Run record", () => {
    const declared = withRunBeaconSourceExtension(minimalRun(), { source: "drand/quicknet" });
    const parsed = parseRun(sealRun(declared).bytes) as unknown as Record<string, unknown>;
    expect(readRunBeaconSourceExtension(parsed)).toEqual({ source: "drand/quicknet" });
    expect(readBeaconSource(parsed)).toBe("drand/quicknet");
  });

  test("an undeclared Run reads as undefined rather than as a default source", () => {
    expect(readBeaconSource(minimalRun())).toBeUndefined();
    expect(readRunBeaconSourceExtension(minimalRun())).toBeUndefined();
  });

  test("an undeclared Run seals byte-identical bytes to before the extension existed", () => {
    expect(Object.keys(minimalRun())).not.toContain(BEACON_SOURCE_EXTENSION);
    // A fixed constant, not the sealer compared to itself: this test's whole claim is that the
    // extension moved nobody's bytes, and only a digest recorded before it existed can fail if it
    // did. Comparing two calls asserts `sealRun` determinism instead, and would pass with the
    // feature removed. Regenerate this only alongside a deliberate, documented Run-record change.
    expect(sealRun(minimalRun()).digest).toBe(UNDECLARED_MINIMAL_RUN_DIGEST);
  });

  test("declaring changes the sealed bytes, so the beacon is fixed at the lock", () => {
    const undeclared = sealRun(minimalRun()).digest;
    const declared = sealRun(withRunBeaconSourceExtension(minimalRun(), { source: "drand/quicknet" })).digest;
    expect(declared).not.toBe(undeclared);
  });
});

describe("the Run record schema", () => {
  test("refuses a malformed declaration as a malformed RECORD, pathed at the extension", () => {
    const bad = { ...minimalRun(), [BEACON_SOURCE_EXTENSION]: { source: 7 } };
    expect(() => sealRun(bad)).toThrow(InvalidDocumentError);
    try {
      sealRun(bad);
      expect.unreachable();
    } catch (error) {
      const issues = (error as InvalidDocumentError).errors;
      expect(issues.some((issue) => issue.path.startsWith(BEACON_SOURCE_EXTENSION))).toBe(true);
    }
  });

  test("reading a malformed declaration throws rather than silently reporting undefined", () => {
    expect(() => readBeaconSource({ ...minimalRun(), [BEACON_SOURCE_EXTENSION]: { source: "" } })).toThrow();
  });
});
