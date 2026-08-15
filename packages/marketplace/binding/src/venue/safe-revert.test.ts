import { encodeAbiParameters, keccak256, parseAbiParameters, toBytes } from "viem";
import { describe, expect, test } from "vitest";
import { KNOWN_INNER_ERRORS, formatDecodedRevert, formatKnownRevertDetail } from "./safe-revert.js";

function selectorFor(signature: string): string {
  return keccak256(toBytes(signature)).slice(0, 10);
}

describe("KNOWN_INNER_ERRORS", () => {
  test("every hardcoded selector matches the keccak256 of its canonical error signature", () => {
    for (const [selector, { name, params }] of Object.entries(KNOWN_INNER_ERRORS)) {
      const paramTypes = params === "" ? "" : params
        .split(",")
        .map((p) => p.trim().split(" ")[0])
        .join(",");
      expect(selectorFor(`${name}(${paramTypes})`)).toBe(selector);
    }
  });
});

describe("formatDecodedRevert", () => {
  test("formats a no-arg revert as just the name", () => {
    expect(formatDecodedRevert("RouterZeroValue", null)).toBe("RouterZeroValue");
  });

  test("formats args, stringifying bigints without a trailing 'n'", () => {
    expect(formatDecodedRevert("RouterInsufficientTaskBudget", [1n, 2n, 3n])).toBe(
      "RouterInsufficientTaskBudget(1, 2, 3)",
    );
  });
});

describe("formatKnownRevertDetail", () => {
  test("decodes a known selector + args out of an error-shaped object carrying revert data", () => {
    const data = `${selectorFor("RouterTaskNotFound(uint256)")}${encodeAbiParameters(
      parseAbiParameters("uint256"),
      [42n],
    ).slice(2)}`;
    const detail = formatKnownRevertDetail({ data });
    expect(detail).toEqual({ name: "RouterTaskNotFound", reason: "RouterTaskNotFound(42)" });
  });

  test("returns null for an unrecognized selector", () => {
    expect(formatKnownRevertDetail({ data: "0xdeadbeef" })).toBeNull();
  });

  test("returns null when no revert data can be extracted", () => {
    expect(formatKnownRevertDetail(new Error("network timeout"))).toBeNull();
  });
});
