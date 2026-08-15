import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadFixtureFamily, runStructuralCheck } from "../testing.js";
import { checkAllOfConstruction, resolveFamilyUri, type SubProfileChainEntry } from "./sub-profile.js";
import type { TaskProfileDocument } from "./schema.js";

const familyDir = fileURLToPath(new URL("../../fixtures/sub-profile", import.meta.url));

type SubProfileInput =
  | { op: "allOf"; sub: TaskProfileDocument; parentDoc: TaskProfileDocument }
  | { op: "familyUri"; chain: SubProfileChainEntry[] };

function checkSubProfile(raw: unknown) {
  const input = raw as SubProfileInput;
  if (input.op === "allOf") {
    const result = checkAllOfConstruction(input.sub, input.parentDoc);
    return result.ok ? { ok: true as const } : { ok: false as const, code: result.code };
  }
  return { ok: true as const, familyUri: resolveFamilyUri(input.chain) };
}

describe("sub-profile structural allOf + family-URI chain walk (design §6.3)", () => {
  it("passes every golden and adversarial fixture case", async () => {
    const cases = await loadFixtureFamily(familyDir);
    expect(cases.length).toBeGreaterThan(0);
    const results = runStructuralCheck(cases, checkSubProfile);
    for (const result of results) {
      expect(result, `${result.kind}/${result.case}: ${result.detail ?? ""}`).toMatchObject({ ok: true });
    }
  });

  it("a child-conforming payload also validates against the parent by construction", async () => {
    const raw = await (await import("node:fs/promises")).readFile(
      new URL("../../fixtures/sub-profile/golden/valid-subprofile.json", import.meta.url),
      "utf8",
    );
    const { sub, parentDoc } = JSON.parse(raw).input as { sub: TaskProfileDocument; parentDoc: TaskProfileDocument };
    expect(checkAllOfConstruction(sub, parentDoc)).toEqual({ ok: true });

    const { compilePayloadValidator } = await import("./payload-schema.js");
    const { canonicalJsonBytes } = await import("../bytes.js");

    const parentValidator = compilePayloadValidator(
      parentDoc.payloadSchema,
      canonicalJsonBytes(parentDoc.payloadSchema),
    );
    const subValidator = compilePayloadValidator(sub.payloadSchema, canonicalJsonBytes(sub.payloadSchema));

    const conformingChildPayload = { language: "typescript", extra: "present" };
    expect(subValidator(conformingChildPayload)).toEqual({ ok: true });
    // Substitutability, proven structurally: every conforming sub-profile payload is also a
    // conforming parent-profile payload, purely because allOf[0] IS the parent schema — no
    // separate validation pass against the parent is needed by a family-keyed consumer.
    expect(parentValidator(conformingChildPayload)).toEqual({ ok: true });
  });
});
