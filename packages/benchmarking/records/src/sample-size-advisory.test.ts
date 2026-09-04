import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  ANCHOR_INTENT_EXTENSION,
  BEACON_SOURCE_EXTENSION,
  SAMPLE_SIZE_ADVISORY_EXTENSION,
  TASK_SELECTION_EXTENSION,
} from "./identifiers.js";
import { InvalidDocumentError } from "./sealing.js";
import { parseRun, sealRun } from "./run/schema.js";
import {
  RunSampleSizeAdvisoryExtensionSchema,
  readRunSampleSizeAdvisory,
  runSampleSizeAdvisoryExtension,
  withRunSampleSizeAdvisoryExtension,
} from "./sample-size-advisory.js";

function minimalRun(): Record<string, unknown> {
  const url = new URL("../fixtures/run/minimal.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>;
}

const ADVISORY = { n: 24, expectedIntervalWidth: "0.3928" } as const;

describe("the sample-size-advisory extension key", () => {
  test("is a namespaced extension URI, distinct from the other Run extensions", () => {
    expect(SAMPLE_SIZE_ADVISORY_EXTENSION)
      .toBe("https://spec.jinn.network/extensions/sample-size-advisory/v1");
    expect(new Set([
      SAMPLE_SIZE_ADVISORY_EXTENSION,
      BEACON_SOURCE_EXTENSION,
      TASK_SELECTION_EXTENSION,
      ANCHOR_INTENT_EXTENSION,
    ]).size).toBe(4);
  });
});

describe("the advisory's shape", () => {
  test("refuses an n that is not a positive whole count of trials", () => {
    for (const n of [0, -1, 2.5]) {
      expect(RunSampleSizeAdvisoryExtensionSchema.safeParse({ ...ADVISORY, n }).success).toBe(false);
    }
  });

  test("refuses a width that is not the canonical 4-decimal spelling", () => {
    for (const expectedIntervalWidth of ["0.39", "0.39280", ".3928", "1", "abc"]) {
      expect(RunSampleSizeAdvisoryExtensionSchema.safeParse({ ...ADVISORY, expectedIntervalWidth }).success)
        .toBe(false);
    }
    expect(RunSampleSizeAdvisoryExtensionSchema.safeParse({ ...ADVISORY, expectedIntervalWidth: "1.0000" }).success)
      .toBe(true);
  });

  test("refuses either field's absence: half an advisory records nothing", () => {
    expect(RunSampleSizeAdvisoryExtensionSchema.safeParse({ n: 24 }).success).toBe(false);
    expect(RunSampleSizeAdvisoryExtensionSchema.safeParse({ expectedIntervalWidth: "0.3928" }).success).toBe(false);
  });

  test("refuses a key it cannot honor, so the sealed bytes carry nothing readers ignore", () => {
    expect(() => runSampleSizeAdvisoryExtension({ ...ADVISORY, note: "but really" })).toThrow();
  });
});

describe("attaching and reading the advisory", () => {
  test("round-trips through a sealed Run record", () => {
    const acknowledged = withRunSampleSizeAdvisoryExtension(minimalRun(), ADVISORY);
    const parsed = parseRun(sealRun(acknowledged).bytes) as unknown as Record<string, unknown>;
    expect(readRunSampleSizeAdvisory(parsed)).toEqual(ADVISORY);
  });

  test("an unacknowledged Run reads as undefined rather than as a synthesized advisory", () => {
    expect(readRunSampleSizeAdvisory(minimalRun())).toBeUndefined();
  });

  test("an unacknowledged Run seals byte-identical bytes to before the extension existed", () => {
    expect(Object.keys(minimalRun())).not.toContain(SAMPLE_SIZE_ADVISORY_EXTENSION);
    expect(sealRun(minimalRun()).digest).toBe(sealRun(minimalRun()).digest);
  });

  test("acknowledging changes the sealed bytes, so the width is fixed at the lock", () => {
    expect(sealRun(withRunSampleSizeAdvisoryExtension(minimalRun(), ADVISORY)).digest)
      .not.toBe(sealRun(minimalRun()).digest);
  });
});

describe("the Run record schema", () => {
  test("refuses a malformed advisory as a malformed RECORD, pathed at the extension", () => {
    const bad = { ...minimalRun(), [SAMPLE_SIZE_ADVISORY_EXTENSION]: { n: 0, expectedIntervalWidth: "0.3928" } };
    expect(() => sealRun(bad)).toThrow(InvalidDocumentError);
    try {
      sealRun(bad);
      expect.unreachable();
    } catch (error) {
      const issues = (error as InvalidDocumentError).errors;
      expect(issues.some((issue) => issue.path.startsWith(SAMPLE_SIZE_ADVISORY_EXTENSION))).toBe(true);
    }
  });

  test("reading a malformed advisory throws rather than silently reporting undefined", () => {
    expect(() => readRunSampleSizeAdvisory({
      ...minimalRun(),
      [SAMPLE_SIZE_ADVISORY_EXTENSION]: { n: 24, expectedIntervalWidth: 0.3928 },
    })).toThrow();
  });
});
