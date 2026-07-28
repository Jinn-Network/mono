import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadFixtureFamily, runStructuralCheck } from "../testing.js";
import { PayloadValidatorCache } from "./compiled-cache.js";
import { resolveProfile } from "./resolve.js";
import { sealTaskProfile } from "./seal.js";
import type { TaskProfileDocument } from "./schema.js";

const familyDir = fileURLToPath(new URL("../../fixtures/resolution", import.meta.url));

type ResolutionInput =
  | { op: "resolve"; descriptorUri: string; doc: TaskProfileDocument; corruptDigestHex?: string }
  | { op: "drift"; doc: TaskProfileDocument; differentDoc: TaskProfileDocument };

function checkResolution(raw: unknown) {
  const input = raw as ResolutionInput;

  if (input.op === "drift") {
    const pinnedDigest = sealTaskProfile(input.doc).digest;
    new PayloadValidatorCache().checkDrift(input.doc.profile, pinnedDigest, input.differentDoc);
    return { ok: true as const };
  }

  const realDigest = sealTaskProfile(input.doc).digest;
  const hex = input.corruptDigestHex ?? realDigest.slice("sha256:".length);
  const descriptor = { uri: input.descriptorUri, digest: { sha256: hex } };
  const store = { get: (digest: string) => (digest === realDigest ? input.doc : undefined) };
  const resolved = resolveProfile(descriptor, store);
  return { ok: true as const, profile: resolved.profile };
}

describe("profile resolution + digest-drift refusal (design §6.2)", () => {
  it("passes every golden and adversarial fixture case", async () => {
    const cases = await loadFixtureFamily(familyDir);
    expect(cases.length).toBeGreaterThan(0);
    const results = runStructuralCheck(cases, checkResolution);
    for (const result of results) {
      expect(result, `${result.kind}/${result.case}: ${result.detail ?? ""}`).toMatchObject({ ok: true });
    }
  });
});
