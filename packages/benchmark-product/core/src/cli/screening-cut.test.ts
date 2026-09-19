import { describe, expect, test } from "vitest";
import * as operations from "../operations/index.js";
import * as entry from "../index.js";
import { CLI_VERB_NAMES, USAGE } from "./main.js";
import { OPERATION_TO_ACTION, OPERATION_TO_GUI, OPERATION_TO_VERB } from "./parity-map.js";

const CUT_OPERATIONS = [
  "importBinaryItemBank",
  "createHumanReviewPackets",
  "signHumanReviewResponse",
  "admitHumanTruth",
] as const;

const CUT_VERBS = [
  "import item-bank",
  "human-review packet create",
  "human-review response sign",
  "human-review admit",
] as const;

describe("screening workflow cut (#3987)", () => {
  test("CLI verbs, facade operations, and USAGE no longer carry the screening surface", () => {
    for (const name of CUT_OPERATIONS) {
      expect(operations, name).not.toHaveProperty(name);
      expect(entry, name).not.toHaveProperty(name);
      expect(OPERATION_TO_VERB[name]).toBeUndefined();
      expect(OPERATION_TO_ACTION[name]).toBeUndefined();
      expect(OPERATION_TO_GUI[name]).toBeUndefined();
    }
    for (const verb of CUT_VERBS) {
      expect(CLI_VERB_NAMES).not.toContain(verb);
      expect(USAGE).not.toContain(verb);
    }
    expect(OPERATION_TO_VERB.compileBinaryInstrumentProfile).toBeUndefined();
    expect(typeof operations.importSweBenchRows).toBe("function");
    expect(CLI_VERB_NAMES).toContain("import swebench");
  });
});
