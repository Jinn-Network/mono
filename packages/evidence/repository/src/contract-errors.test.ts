import { describe, expect, test } from "vitest";

import { assertContentTooLargeRepositoryError } from "./contract-errors.js";
import { EvidenceRepositoryError } from "./errors.js";

describe("internal bounded-contract error validation", () => {
  test("accepts only an actual content-too-large repository error", () => {
    expect(() =>
      assertContentTooLargeRepositoryError(
        new EvidenceRepositoryError("CONTENT_TOO_LARGE", "too large"),
      ),
    ).not.toThrow();

    expect(() =>
      assertContentTooLargeRepositoryError({
        name: "EvidenceRepositoryError",
        code: "CONTENT_TOO_LARGE",
      }),
    ).toThrowError(/actual EvidenceRepositoryError/u);

    expect(() =>
      assertContentTooLargeRepositoryError(
        new EvidenceRepositoryError("IO_FAILURE", "wrong code"),
      ),
    ).toThrowError(/exact code CONTENT_TOO_LARGE/u);
  });
});
