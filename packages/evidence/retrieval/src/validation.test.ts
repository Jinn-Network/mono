import { createRecordReference } from "@jinn-network/evidence-repository";
import { describe, expect, test } from "vitest";

import { loadProtocolFixture } from "./test-support.js";
import { validateCanonicalRecord } from "./validation.js";

const cases = [
  "execution-evidence",
  "result-evaluation",
  "execution-verification",
] as const;

describe("canonical record validation", () => {
  test.each(cases)("validates %s with its existing Protocol validator", async (
    family,
  ) => {
    const bytes = await loadProtocolFixture(family);
    const reference = createRecordReference(family, bytes);
    const result = validateCanonicalRecord(reference, bytes, bytes.byteLength);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.validatedRecord.family).toBe(family);
      expect(result.canonicalBytes).toEqual(bytes);
      expect(result.canonicalBytes).not.toBe(bytes);
    }
  });

  test("rejects bytes that do not match the supplied reference", async () => {
    const bytes = await loadProtocolFixture("execution-evidence");
    const reference = createRecordReference(
      "execution-evidence",
      new TextEncoder().encode("different bytes"),
    );
    const result = validateCanonicalRecord(reference, bytes, bytes.byteLength);
    expect(result).toMatchObject({
      ok: false,
      failure: { code: "RECORD_DIGEST_MISMATCH", stage: "record" },
    });
    expect(result).not.toHaveProperty("canonicalBytes");
  });

  test("rejects an oversized record before Protocol parsing", () => {
    const bytes = new TextEncoder().encode("{}");
    const reference = createRecordReference("execution-evidence", bytes);
    expect(validateCanonicalRecord(reference, bytes, 1)).toMatchObject({
      ok: false,
      failure: { code: "RECORD_TOO_LARGE" },
    });
  });

  test("reports Protocol diagnostics without returning unvalidated bytes", () => {
    const bytes = new TextEncoder().encode("{}");
    const reference = createRecordReference("execution-evidence", bytes);
    const result = validateCanonicalRecord(reference, bytes, bytes.byteLength);
    expect(result).toMatchObject({
      ok: false,
      failure: {
        code: "PROTOCOL_NONCONFORMING",
        stage: "validation",
      },
    });
    if (!result.ok) {
      expect(result.failure.conformanceDiagnostics?.length).toBeGreaterThan(0);
    }
    expect(result).not.toHaveProperty("canonicalBytes");
  });
});
