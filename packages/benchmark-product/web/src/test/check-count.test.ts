import { describe, expect, test } from "vitest";
import { CHECK_COUNT_PATTERN } from "./check-count";

describe("CHECK_COUNT_PATTERN", () => {
  test.each([
    "standalone eight-check verifier",
    "the six bundle checks",
    "seven checks",
    "10 checks",
    "ten-check verifier",
    "Eight Checks",
  ])("rejects %s", (copy) => {
    expect(copy).toMatch(CHECK_COUNT_PATTERN);
  });

  test.each(["did not pass the bundle checks", "run the checks", "a check of the bundle"])(
    "allows %s",
    (copy) => {
      expect(copy).not.toMatch(CHECK_COUNT_PATTERN);
    },
  );
});
