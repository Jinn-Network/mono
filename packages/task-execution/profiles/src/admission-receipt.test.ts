import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadFixtureFamily, runStructuralCheck } from "./testing.js";
import { checkAdmissionReceipt } from "./admission-receipt.js";

const familyDir = fileURLToPath(new URL("../fixtures/admission-receipt", import.meta.url));

// Fixtures assert the `{ ok, issuer }` / `{ ok, code }` shape; the human-readable `reason` string
// on a rejection is a real part of the return type but not pinned by fixture equality (same
// convention as verdict-consistency.test.ts).
function checkReceipt(input: unknown) {
  const { envelope, expectedTaskDigest, expectedEvaluationSpecDigest } = input as {
    envelope: unknown;
    expectedTaskDigest: string;
    expectedEvaluationSpecDigest: string;
  };
  const result = checkAdmissionReceipt({ envelope, expectedTaskDigest, expectedEvaluationSpecDigest });
  return result.ok ? { ok: true as const, issuer: result.issuer } : { ok: false as const, code: result.code };
}

describe("DSSE admission-receipt shape", () => {
  it("passes every golden and adversarial fixture case", async () => {
    const cases = await loadFixtureFamily(familyDir);
    expect(cases.length).toBeGreaterThan(0);
    const results = runStructuralCheck(cases, checkReceipt);
    for (const result of results) {
      expect(result, `${result.kind}/${result.case}: ${result.detail ?? ""}`).toMatchObject({ ok: true });
    }
  });
});
