import { sealEnvironmentRecord } from "@jinn-network/environment-record";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { describe, expect, it } from "vitest";
import { admitCandidate, type AdmissionCandidate, type EnvironmentRunRequest } from "./admit.js";

const MANIFEST = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const PARSER = "sha256:3333333333333333333333333333333333333333333333333333333333333333";
const GOLD = "sha256:5555555555555555555555555555555555555555555555555555555555555555";
const D = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}`;

const recordBytes = sealEnvironmentRecord({
  kind: "https://spec.jinn.network/records/environment/v1",
  source: { repo: "owner/name", repoUrl: "https://github.com/owner/name", commit: "a".repeat(40) },
  image: { manifestDigest: MANIFEST, platform: "linux/amd64", reference: `ghcr.io/example/env@${MANIFEST}` },
  workspace: "/testbed",
  invocations: { test: [{ bin: "python", args: ["-m", "pytest", "-rA"], cwd: "/testbed" }] },
  parser: { id: "pytest-log", version: "3", digest: PARSER },
  build: { reproducibilityTier: 0, provider: { id: "upstream-import", version: "1" } },
  rights: { sourceLicense: "MIT" },
} as never);

/** Sealed EvaluationSpec bytes are canonical bytes — exactly what `sealEvaluationSpec` emits. */
const specValue = (blockOverrides: Record<string, unknown> = {}) => ({
  family: "deterministic-process",
  familyBlock: {
    image: { uri: `ghcr.io/example/env@${MANIFEST}`, digest: { sha256: MANIFEST.slice(7) } },
    platform: "linux/amd64",
    parser: { id: "pytest-log", version: "3", digest: PARSER },
    testMaterial: [{ name: "test-patch", digest: { sha256: D("4").slice(7) }, accessClass: "public" }],
    transitions: { failToPass: ["target"], passToPass: ["keeps"] },
    timeout: 1800,
    ...blockOverrides,
  },
});

const evaluationSpecBytes = canonicalJsonBytes(specValue());

const candidate: AdmissionCandidate = {
  taskDocumentDigest: D("1") as `sha256:${string}`,
  statementDigest: D("3") as `sha256:${string}`,
  testMaterialDigests: [D("4") as `sha256:${string}`],
  transitions: { failToPass: ["target"], passToPass: ["keeps"] },
  goldPatchHash: GOLD,
  evaluationSpecBytes,
  testPaths: ["tests/unit/test_thing.py"],
  evalSemanticsVersion: "4",
};

function runner(overrides: Partial<Record<"gold" | "none", unknown>> = {}) {
  const requests: EnvironmentRunRequest[] = [];
  const port = async (request: EnvironmentRunRequest) => {
    requests.push(request);
    const gold = request.patch.kind === "gold";
    return (overrides[request.patch.kind] as never) ?? {
      passed: gold ? ["keeps", "target"] : ["keeps"],
      failed: gold ? [] : ["target"],
      passedMatch: gold,
      appliedPatchDigest: gold ? GOLD : null,
    };
  };
  return { port, requests };
}

describe("admitCandidate", () => {
  it("admits a discriminating candidate and returns a policy-valid receipt", async () => {
    const { port, requests } = runner();
    const result = await admitCandidate({ runInEnvironment: port, issuer: "https://spec.jinn.network/agents/a" } as never, candidate, recordBytes);
    expect("receipt" in result).toBe(true);
    if (!("receipt" in result)) return;
    expect(requests).toHaveLength(4);
    expect(requests.map((request) => request.patch.kind)).toStrictEqual(["none", "none", "gold", "gold"]);
    expect(result.receipt.testPaths[0]?.failToPass).toStrictEqual(["target"]);
    expect(result.receipt.testPaths[0]?.passToPass).toStrictEqual(["keeps"]);
    expect(result.receipt.environment.inlineMatch).toStrictEqual({
      fields: ["image", "parser", "platform"], specKeyPresent: false,
    });
    expect(result.receipt.goldPatchHash).toBe(GOLD);
  });

  it("passes the gold patch to the runner as a selector, never as bytes", async () => {
    const { port, requests } = runner();
    await admitCandidate({ runInEnvironment: port, issuer: "https://spec.jinn.network/agents/a" } as never, candidate, recordBytes);
    for (const request of requests) {
      expect(JSON.stringify(request)).not.toContain("diff --git");
      expect(Object.keys(request.patch).sort()).toStrictEqual(
        request.patch.kind === "gold" ? ["digest", "kind"] : ["kind"],
      );
    }
  });

  it("binds the environment record by digest and targets the record's test command", async () => {
    const { port, requests } = runner();
    const result = await admitCandidate({ runInEnvironment: port, issuer: "https://spec.jinn.network/agents/a" } as never, candidate, recordBytes);
    if (!("receipt" in result)) throw new Error("expected a receipt");
    expect(requests[0]?.environmentRecordDigest).toBe(result.receipt.environment.recordDigest);
    expect(requests[0]?.command.args).toStrictEqual(["-m", "pytest", "-rA", "tests/unit/test_thing.py"]);
  });

  it("refuses env-record-mismatch when the inline image is not the record's", async () => {
    const { port } = runner();
    const mismatched = {
      ...candidate,
      evaluationSpecBytes: new TextEncoder().encode(
        new TextDecoder().decode(evaluationSpecBytes).replaceAll("1111", "2222"),
      ),
    };
    const result = await admitCandidate({ runInEnvironment: port, issuer: "https://spec.jinn.network/agents/a" } as never, mismatched, recordBytes);
    expect(result).toStrictEqual({
      refusal: { code: "env-record-mismatch", detail: expect.stringContaining("inline image manifest digest") },
    });
  });

  it("refuses invalid-environment-record on unparseable record bytes", async () => {
    const { port } = runner();
    const result = await admitCandidate(
      { runInEnvironment: port, issuer: "https://spec.jinn.network/agents/a" } as never,
      candidate,
      new TextEncoder().encode("{not json"),
    );
    expect("refusal" in result && result.refusal.code).toBe("invalid-environment-record");
  });

  it("refuses unstable-observations when a side's repeats differ", async () => {
    let call = 0;
    // The runner honors the patch binding on both sides, so the *only* defect it introduces is
    // the flaky first repeat — otherwise the gold side's binding check refuses first.
    const port = async (request: EnvironmentRunRequest) => ({
      passed: call++ === 0 ? ["keeps"] : ["keeps", "flake"],
      failed: ["target"],
      passedMatch: false,
      appliedPatchDigest: request.patch.kind === "gold" ? GOLD : null,
    });
    const result = await admitCandidate({ runInEnvironment: port, issuer: "https://spec.jinn.network/agents/a" } as never, candidate, recordBytes);
    expect("refusal" in result && result.refusal.code).toBe("unstable-observations");
  });

  it("refuses no-discrimination when gold changes nothing", async () => {
    const inert = { passed: ["keeps"], failed: [], passedMatch: true };
    const port = async (request: EnvironmentRunRequest) => ({
      ...inert, appliedPatchDigest: request.patch.kind === "gold" ? GOLD : null,
    });
    const result = await admitCandidate({ runInEnvironment: port, issuer: "https://spec.jinn.network/agents/a" } as never, candidate, recordBytes);
    expect("refusal" in result && result.refusal.code).toBe("no-discrimination");
  });

  it("refuses execution-failed when the runner applies material other than the declared gold patch", async () => {
    const port = async (request: EnvironmentRunRequest) => ({
      passed: [], failed: ["target"], passedMatch: false,
      appliedPatchDigest: request.patch.kind === "gold" ? D("9") : null,
    });
    const result = await admitCandidate({ runInEnvironment: port, issuer: "https://spec.jinn.network/agents/a" } as never, candidate, recordBytes);
    expect("refusal" in result && result.refusal.code).toBe("execution-failed");
  });

  it("refuses execution-failed when the runner throws", async () => {
    const port = async () => { throw new Error("container runtime unavailable"); };
    const result = await admitCandidate({ runInEnvironment: port, issuer: "https://spec.jinn.network/agents/a" } as never, candidate, recordBytes);
    expect("refusal" in result && result.refusal.code).toBe("execution-failed");
    expect("refusal" in result && result.refusal.detail).toContain("container runtime unavailable");
  });

  it("UNSOLVABLE-PAIR FIXTURE: refuses when gold flips something other than the declared fail-to-pass", async () => {
    // Design 7.1, first bullet: gold applied -> *the candidate's* fail-to-pass tests pass. A
    // gold patch that leaves `target` failing and flips an unrelated assertion instead seals an
    // unsolvable pair, so it must never earn a receipt.
    const port = async (request: EnvironmentRunRequest) => ({
      passed: request.patch.kind === "gold" ? ["keeps", "brand_new"] : ["keeps"],
      failed: request.patch.kind === "gold" ? ["target"] : ["target", "brand_new"],
      passedMatch: false,
      appliedPatchDigest: request.patch.kind === "gold" ? GOLD : null,
    });
    const result = await admitCandidate({ runInEnvironment: port, issuer: "https://spec.jinn.network/agents/a" } as never, candidate, recordBytes);
    expect("refusal" in result && result.refusal.code).toBe("transitions-mismatch");
    expect("refusal" in result && result.refusal.detail).toContain("target");
  });

  it("refuses when gold regresses the declared pass-to-pass assertion", async () => {
    const port = async (request: EnvironmentRunRequest) => ({
      passed: request.patch.kind === "gold" ? ["target"] : [],
      failed: request.patch.kind === "gold" ? ["keeps"] : ["keeps", "target"],
      passedMatch: false,
      appliedPatchDigest: request.patch.kind === "gold" ? GOLD : null,
    });
    const result = await admitCandidate({ runInEnvironment: port, issuer: "https://spec.jinn.network/agents/a" } as never, candidate, recordBytes);
    expect("refusal" in result && result.refusal.code).toBe("transitions-mismatch");
    expect("refusal" in result && result.refusal.detail).toContain("keeps");
  });

  it("BLIND-EMPTY-SIDE FIXTURE: refuses when the empty side produced no reading at all", async () => {
    // A collection error or a broken container reads as `{passed: [], failed: []}`; absence is
    // not discrimination (design 7.1, second bullet).
    const port = async (request: EnvironmentRunRequest) => ({
      passed: request.patch.kind === "gold" ? ["keeps", "target"] : [],
      failed: [],
      passedMatch: request.patch.kind === "gold",
      appliedPatchDigest: request.patch.kind === "gold" ? GOLD : null,
    });
    const result = await admitCandidate({ runInEnvironment: port, issuer: "https://spec.jinn.network/agents/a" } as never, candidate, recordBytes);
    expect("refusal" in result && result.refusal.code).toBe("no-discrimination");
  });

  it("refuses transitions-mismatch when the spec grades a different set than the candidate declares", async () => {
    const { port, requests } = runner();
    const result = await admitCandidate(
      { runInEnvironment: port, issuer: "https://spec.jinn.network/agents/a" } as never,
      { ...candidate, evaluationSpecBytes: canonicalJsonBytes(specValue({
        transitions: { failToPass: ["something_else"], passToPass: ["keeps"] },
      })) },
      recordBytes,
    );
    expect("refusal" in result && result.refusal.code).toBe("transitions-mismatch");
    expect(requests).toHaveLength(0);
  });

  it("refuses invalid-candidate when the spec grades material the candidate does not declare", async () => {
    const { port, requests } = runner();
    const result = await admitCandidate(
      { runInEnvironment: port, issuer: "https://spec.jinn.network/agents/a" } as never,
      { ...candidate, evaluationSpecBytes: canonicalJsonBytes(specValue({
        testMaterial: [{ name: "test-patch", digest: { sha256: D("9").slice(7) }, accessClass: "public" }],
      })) },
      recordBytes,
    );
    expect("refusal" in result && result.refusal.code).toBe("invalid-candidate");
    expect("refusal" in result && result.refusal.detail).toContain("test material");
    expect(requests).toHaveLength(0);
  });

  it("refuses non-canonical EvaluationSpec bytes before spending a single container run", async () => {
    const { port, requests } = runner();
    const result = await admitCandidate(
      { runInEnvironment: port, issuer: "https://spec.jinn.network/agents/a" } as never,
      { ...candidate, evaluationSpecBytes: new TextEncoder().encode(JSON.stringify(specValue(), null, 2)) },
      recordBytes,
    );
    expect("refusal" in result && result.refusal.code).toBe("invalid-candidate");
    expect("refusal" in result && result.refusal.detail).toContain("canonical");
    expect(requests).toHaveLength(0);
  });

  it("refuses a candidate with no test material before spending a single container run", async () => {
    const { port, requests } = runner();
    const result = await admitCandidate(
      { runInEnvironment: port, issuer: "https://spec.jinn.network/agents/a" } as never,
      { ...candidate, testMaterialDigests: [] },
      recordBytes,
    );
    expect("refusal" in result && result.refusal.code).toBe("invalid-candidate");
    expect(requests).toHaveLength(0);
  });

  it("stops issuing runs when the caller aborts", async () => {
    const controller = new AbortController();
    const { port, requests } = runner();
    controller.abort();
    await expect(admitCandidate(
      { runInEnvironment: port, issuer: "https://spec.jinn.network/agents/a", signal: controller.signal } as never,
      candidate,
      recordBytes,
    )).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });

  it("records one entry per run on each side", async () => {
    const { port } = runner();
    const result = await admitCandidate({ runInEnvironment: port, issuer: "https://spec.jinn.network/agents/a" } as never, candidate, recordBytes);
    if (!("receipt" in result)) throw new Error("expected a receipt");
    const path = result.receipt.testPaths[0];
    expect(path?.broken).toStrictEqual([
      { passed: ["keeps"], failed: ["target"], passedMatch: false },
      { passed: ["keeps"], failed: ["target"], passedMatch: false },
    ]);
    expect(path?.fixed).toStrictEqual([
      { passed: ["keeps", "target"], failed: [], passedMatch: true },
      { passed: ["keeps", "target"], failed: [], passedMatch: true },
    ]);
  });
});
