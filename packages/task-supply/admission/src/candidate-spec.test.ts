import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { describe, expect, it } from "vitest";
import { assertCanonicalSpecBytes, checkCandidateSpecConsistency } from "./candidate-spec.js";
import { AdmissionRefusalError } from "./refusals.js";

const MANIFEST = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const PARSER = "sha256:3333333333333333333333333333333333333333333333333333333333333333";
const MATERIAL = "sha256:4444444444444444444444444444444444444444444444444444444444444444";
const OTHER_MATERIAL = "sha256:9999999999999999999999999999999999999999999999999999999999999999";

const block = {
  image: { uri: `ghcr.io/example/env@${MANIFEST}`, digest: { sha256: MANIFEST.slice(7) } },
  platform: "linux/amd64",
  parser: { id: "pytest-log", version: "3", digest: PARSER },
  testMaterial: [{ name: "test-patch", digest: { sha256: MATERIAL.slice(7) }, accessClass: "public" }],
  transitions: { failToPass: ["target"], passToPass: ["keeps"] },
  timeout: 1800,
};

const spec = (overrides: Record<string, unknown> = {}) => ({
  family: "deterministic-process",
  familyBlock: { ...block, ...overrides },
});

const candidate = {
  transitions: { failToPass: ["target"], passToPass: ["keeps"] },
  testMaterialDigests: [MATERIAL as `sha256:${string}`],
};

function refusalOf(run: () => unknown): { code: string; detail: string } {
  try {
    run();
  } catch (error) {
    if (error instanceof AdmissionRefusalError) return error.refusal;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("assertCanonicalSpecBytes", () => {
  it("accepts the canonical sealing of a spec", () => {
    const bytes = canonicalJsonBytes(spec());
    expect(() => assertCanonicalSpecBytes(bytes, JSON.parse(new TextDecoder().decode(bytes)))).not.toThrow();
  });

  it("refuses semantically identical but non-canonical bytes", () => {
    const value = spec();
    const bytes = new TextEncoder().encode(JSON.stringify(value, null, 2));
    const refusal = refusalOf(() => assertCanonicalSpecBytes(bytes, value));
    expect(refusal.code).toBe("invalid-candidate");
    expect(refusal.detail).toContain("canonical");
  });
});

describe("checkCandidateSpecConsistency", () => {
  it("passes when the spec grades exactly what the candidate declares", () => {
    expect(() => checkCandidateSpecConsistency(spec(), candidate)).not.toThrow();
  });

  it("refuses transitions-mismatch when the inline transitions are not the declared ones", () => {
    const refusal = refusalOf(() => checkCandidateSpecConsistency(
      spec({ transitions: { failToPass: ["other"], passToPass: ["keeps"] } }),
      candidate,
    ));
    expect(refusal.code).toBe("transitions-mismatch");
    expect(refusal.detail).toContain("fail-to-pass");
  });

  it("refuses transitions-mismatch when the inline pass-to-pass set is not the declared one", () => {
    const refusal = refusalOf(() => checkCandidateSpecConsistency(
      spec({ transitions: { failToPass: ["target"], passToPass: [] } }),
      candidate,
    ));
    expect(refusal.code).toBe("transitions-mismatch");
    expect(refusal.detail).toContain("pass-to-pass");
  });

  it("refuses invalid-candidate when the inline test material is not the declared material", () => {
    const refusal = refusalOf(() => checkCandidateSpecConsistency(
      spec({ testMaterial: [{ name: "test-patch", digest: { sha256: OTHER_MATERIAL.slice(7) } }] }),
      candidate,
    ));
    expect(refusal.code).toBe("invalid-candidate");
    expect(refusal.detail).toContain("test material");
  });

  it("refuses a test-material DigestSet written in the sha256:-prefixed spelling", () => {
    const refusal = refusalOf(() => checkCandidateSpecConsistency(
      spec({ testMaterial: [{ name: "test-patch", digest: { sha256: MATERIAL } }] }),
      candidate,
    ));
    expect(refusal.code).toBe("invalid-candidate");
    expect(refusal.detail).toContain("bare lowercase hex");
  });

  it("refuses a deterministic-process block that declares no test material or transitions", () => {
    const bare = { family: "deterministic-process", familyBlock: {
      image: block.image, platform: block.platform, parser: block.parser,
    } };
    const refusal = refusalOf(() => checkCandidateSpecConsistency(bare, candidate));
    expect(refusal.code).toBe("invalid-candidate");
  });
});
