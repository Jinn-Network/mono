import { EvidenceRepositoryError } from "./errors.js";

export function assertContentTooLargeRepositoryError(
  value: unknown,
): asserts value is EvidenceRepositoryError {
  if (!(value instanceof EvidenceRepositoryError)) {
    throw new TypeError(
      "Expected an actual EvidenceRepositoryError.",
    );
  }
  if (value.code !== "CONTENT_TOO_LARGE") {
    throw new TypeError(
      "Expected EvidenceRepositoryError with exact code CONTENT_TOO_LARGE.",
    );
  }
}
