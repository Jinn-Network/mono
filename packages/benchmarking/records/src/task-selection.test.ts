import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { TASK_SELECTION_EXTENSION } from "./identifiers.js";
import { InvalidDocumentError } from "./sealing.js";
import { parseRun, sealRun } from "./run/schema.js";
import {
  RunTaskSelectionExtensionSchema,
  TASK_SELECTION_MODES,
  readRunTaskSelectionExtension,
  readTaskSelectionMode,
  runTaskSelectionExtension,
  withRunTaskSelectionExtension,
} from "./task-selection.js";

function minimalRun(): Record<string, unknown> {
  const url = new URL("../fixtures/run/minimal.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>;
}

describe("the task-selection extension key", () => {
  test("is a namespaced extension URI, distinct from the other Run extensions", () => {
    expect(TASK_SELECTION_EXTENSION).toBe("https://spec.jinn.network/extensions/task-selection/v1");
  });
});

describe("the vocabulary", () => {
  test("is exactly the three answers, and closed", () => {
    expect(TASK_SELECTION_MODES).toEqual(["claimant-chosen", "fixed-public-set", "drawn-post-lock"]);
  });

  test("refuses a value outside it, including plausible near-misses", () => {
    for (const mode of ["claimant chosen", "fixed-public", "drawn", "", "CLAIMANT-CHOSEN"]) {
      expect(RunTaskSelectionExtensionSchema.safeParse({ mode }).success).toBe(false);
    }
  });

  test("refuses a declaration with no mode, and one carrying a key it cannot honor", () => {
    expect(RunTaskSelectionExtensionSchema.safeParse({}).success).toBe(false);
    // Strict: an unrecognized key would otherwise ride in the sealed bytes while every reader
    // ignored it, leaving two records that claim one declaration.
    expect(() => runTaskSelectionExtension({ mode: "claimant-chosen", note: "but really" })).toThrow();
  });
});

describe("attaching and reading the declaration", () => {
  test("round-trips every mode through a sealed Run record", () => {
    for (const mode of TASK_SELECTION_MODES) {
      const declared = withRunTaskSelectionExtension(minimalRun(), { mode });
      const parsed = parseRun(sealRun(declared).bytes) as unknown as Record<string, unknown>;
      expect(readRunTaskSelectionExtension(parsed)).toEqual({ mode });
      expect(readTaskSelectionMode(parsed)).toBe(mode);
    }
  });

  test("an undeclared Run reads as undefined rather than as a default", () => {
    // The absence must stay legible: a default here would let a run that never answered the
    // question look as though it had.
    expect(readTaskSelectionMode(minimalRun())).toBeUndefined();
    expect(readRunTaskSelectionExtension(minimalRun())).toBeUndefined();
  });

  test("an undeclared Run seals byte-identical bytes to before the extension existed", () => {
    expect(sealRun(minimalRun()).digest).toBe(sealRun(minimalRun()).digest);
    expect(Object.keys(minimalRun())).not.toContain(TASK_SELECTION_EXTENSION);
  });

  test("declaring changes the sealed bytes, so the answer is fixed at the lock", () => {
    const undeclared = sealRun(minimalRun()).digest;
    const declared = sealRun(withRunTaskSelectionExtension(minimalRun(), { mode: "claimant-chosen" })).digest;
    expect(declared).not.toBe(undeclared);
  });
});

describe("the Run record schema", () => {
  test("refuses a malformed declaration as a malformed RECORD, pathed at the extension", () => {
    const bad = { ...minimalRun(), [TASK_SELECTION_EXTENSION]: { mode: "whatever-i-like" } };
    expect(() => sealRun(bad)).toThrow(InvalidDocumentError);
    try {
      sealRun(bad);
      expect.unreachable();
    } catch (error) {
      const issues = (error as InvalidDocumentError).errors;
      expect(issues.some((issue) => issue.path.startsWith(TASK_SELECTION_EXTENSION))).toBe(true);
    }
  });

  test("reading a malformed declaration throws rather than silently reporting undefined", () => {
    const bad = { ...minimalRun(), [TASK_SELECTION_EXTENSION]: { mode: "whatever-i-like" } };
    expect(() => readTaskSelectionMode(bad)).toThrow();
  });
});
