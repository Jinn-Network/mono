import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ProfilesError } from "../../errors.js";
import { loadFixtureFamily, runStructuralCheck } from "../../testing.js";
import { DECIMAL_STRING_PATTERN } from "../verdict-rule.js";
import {
  readExternalVerifierMeasurements,
  type ExternalVerifierMeasurementsInput,
} from "./measurements.js";

const familyDir = fileURLToPath(new URL("../../../fixtures/external-verifier-measurements", import.meta.url));

const reward = { name: "reward", type: "number", required: true } as const;

function read(rewards: unknown, measurements: ExternalVerifierMeasurementsInput["measurements"] = [reward]) {
  return readExternalVerifierMeasurements({ harness: "harbor", measurements, rewards });
}

function refusal(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return error instanceof ProfilesError ? error.code : `unexpected ${String(error)}`;
  }
  return undefined;
}

describe("external-verifier measurements", () => {
  it("passes every golden and adversarial fixture case", async () => {
    const cases = await loadFixtureFamily(familyDir);
    expect(cases.length).toBe(12);
    const results = runStructuralCheck(cases, (input) =>
      readExternalVerifierMeasurements(input as ExternalVerifierMeasurementsInput));
    for (const result of results) {
      expect(result, `${result.kind}/${result.case}: ${result.detail ?? ""}`).toMatchObject({ ok: true });
    }
  });

  it("carries a whole number as a number up to the safe-integer boundary, and as a string beyond it", () => {
    const boundary = 2 ** 53 - 1;
    expect(read({ reward: boundary })).toEqual({ reward: 9007199254740991 });
    expect(read({ reward: -boundary })).toEqual({ reward: -9007199254740991 });
    expect(read({ reward: 2 ** 53 })).toEqual({ reward: "9007199254740992" });
    expect(read({ reward: -(2 ** 53) })).toEqual({ reward: "-9007199254740992" });
    expect(read({ reward: 2 ** 53 + 2 })).toEqual({ reward: "9007199254740994" });
    expect(read({ reward: 0 })).toEqual({ reward: 0 });
    expect(Object.is(read({ reward: -0 })["reward"], 0)).toBe(true);
  });

  it("carries any other number as the shortest decimal string that reads back the same, with no exponent", () => {
    const cases: Array<[number, string]> = [
      [0.5, "0.5"],
      [-0.5, "-0.5"],
      [0.1, "0.1"],
      [0.30000000000000004, "0.30000000000000004"],
      [1e-7, "0.0000001"],
      [1.5e-7, "0.00000015"],
      [-1.5e-7, "-0.00000015"],
      [1e21, "1000000000000000000000"],
      [1.5e21, "1500000000000000000000"],
      [-1e21, "-1000000000000000000000"],
      [5e-324, `0.${"0".repeat(323)}5`],
      [1.7976931348623157e308, `17976931348623157${"0".repeat(292)}`],
      // Past 2^53 several strings of one length read back as the same value. The one carried
      // has the fewest significant digits, then zeros. It is not the exact integer value of the
      // binary64, which here is 1152921504606847232.
      [2 ** 60 + 256, "1152921504606847200"],
      [123456789012345680000, "123456789012345680000"],
    ];
    for (const [value, text] of cases) {
      expect(read({ reward: value }), String(value)).toEqual({ reward: text });
      expect(text).toMatch(DECIMAL_STRING_PATTERN);
      expect(Number(text), text).toBe(value);
    }
  });

  it("reads only declared keys, in declaration order, and supplies no default", () => {
    const declarations = [
      { name: "reward", type: "number", required: true },
      { name: "partial_credit", type: "number", required: false },
    ] as const;
    expect(Object.keys(read({ partial_credit: 0.25, reward: 1, undeclared: 7 }, declarations)))
      .toEqual(["reward", "partial_credit"]);
    expect(read({ partial_credit: 0.25 }, declarations)).toEqual({ partial_credit: "0.25" });
    expect(read({}, declarations)).toEqual({});
    expect(read({ reward: 1 }, [])).toEqual({});
  });

  it("does not inspect a key the specification does not declare", () => {
    expect(read({ reward: 1, note: "not a number" })).toEqual({ reward: 1 });
  });

  it("reads own keys only", () => {
    const declarations = [{ name: "toString", type: "number", required: false }] as const;
    expect(read({}, declarations)).toEqual({});
    expect(read(Object.create({ reward: 1 }) as object)).toEqual({});
  });

  it("refuses a reward map that is absent or is not an object", () => {
    for (const rewards of [undefined, null, [1], "1", 1, true]) {
      expect(refusal(() => read(rewards)), JSON.stringify(rewards)).toBe("invalid-document");
    }
  });

  it("refuses a declared key whose value is not a finite number", () => {
    for (const value of ["1", true, null, [1], { value: 1 }, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(refusal(() => read({ reward: value })), String(value)).toBe("invalid-document");
    }
  });

  it("refuses a harbor measurement that is not declared with type number", () => {
    for (const type of ["boolean", "string"] as const) {
      expect(refusal(() => read({ reward: 1 }, [{ name: "reward", type, required: true }])), type)
        .toBe("invalid-document");
    }
  });

  it("refuses a harness this version does not define", () => {
    expect(
      refusal(() =>
        readExternalVerifierMeasurements({
          harness: "example-harness" as "harbor",
          measurements: [reward],
          rewards: { reward: 1 },
        })),
    ).toBe("invalid-document");
  });
});
