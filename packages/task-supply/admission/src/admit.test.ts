import { sealEnvironmentRecord } from "@jinn-network/environment-record";
import { describe, expect, it } from "vitest";
import { admitCandidate, type AdmissionCandidate, type EnvironmentRunRequest } from "./admit.js";

const MANIFEST = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const PARSER = "sha256:3333333333333333333333333333333333333333333333333333333333333333";
const GOLD = "sha256:5555555555555555555555555555555555555555555555555555555555555555";
const D = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}`;

const recordBytes = sealEnvironmentRecord({
  kind: "https://jinn.network/records/environment/1.0",
  source: { repo: "owner/name", repoUrl: "https://github.com/owner/name", commit: "a".repeat(40) },
  image: { manifestDigest: MANIFEST, platform: "linux/amd64", reference: `ghcr.io/example/env@${MANIFEST}` },
  workspace: "/testbed",
  invocations: { test: [{ bin: "python", args: ["-m", "pytest", "-rA"], cwd: "/testbed" }] },
  parser: { id: "pytest-log", version: "3", digest: PARSER },
  build: { reproducibilityTier: 0, provider: { id: "upstream-import", version: "1" } },
  rights: { sourceLicense: "MIT" },
} as never);

const evaluationSpecBytes = new TextEncoder().encode(JSON.stringify({
  family: "deterministic-process",
  familyBlock: {
    image: { uri: `ghcr.io/example/env@${MANIFEST}`, digest: { sha256: MANIFEST.slice(7) } },
    platform: "linux/amd64",
    parser: { id: "pytest-log", version: "3", digest: PARSER },
    transitions: { failToPass: ["target"], passToPass: ["keeps"] },
    timeout: 1800,
  },
}));

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
    const result = await admitCandidate({ runInEnvironment: port, issuer: "https://jinn.network/agents/a" } as never, candidate, recordBytes);
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
    await admitCandidate({ runInEnvironment: port, issuer: "https://jinn.network/agents/a" } as never, candidate, recordBytes);
    for (const request of requests) {
      expect(JSON.stringify(request)).not.toContain("diff --git");
      expect(Object.keys(request.patch).sort()).toStrictEqual(
        request.patch.kind === "gold" ? ["digest", "kind"] : ["kind"],
      );
    }
  });

  it("binds the environment record by digest and targets the record's test command", async () => {
    const { port, requests } = runner();
    const result = await admitCandidate({ runInEnvironment: port, issuer: "https://jinn.network/agents/a" } as never, candidate, recordBytes);
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
    const result = await admitCandidate({ runInEnvironment: port, issuer: "https://jinn.network/agents/a" } as never, mismatched, recordBytes);
    expect(result).toStrictEqual({
      refusal: { code: "env-record-mismatch", detail: expect.stringContaining("inline image manifest digest") },
    });
  });

  it("refuses invalid-environment-record on unparseable record bytes", async () => {
    const { port } = runner();
    const result = await admitCandidate(
      { runInEnvironment: port, issuer: "https://jinn.network/agents/a" } as never,
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
    const result = await admitCandidate({ runInEnvironment: port, issuer: "https://jinn.network/agents/a" } as never, candidate, recordBytes);
    expect("refusal" in result && result.refusal.code).toBe("unstable-observations");
  });

  it("refuses no-discrimination when gold changes nothing", async () => {
    const inert = { passed: ["keeps"], failed: [], passedMatch: true };
    const port = async (request: EnvironmentRunRequest) => ({
      ...inert, appliedPatchDigest: request.patch.kind === "gold" ? GOLD : null,
    });
    const result = await admitCandidate({ runInEnvironment: port, issuer: "https://jinn.network/agents/a" } as never, candidate, recordBytes);
    expect("refusal" in result && result.refusal.code).toBe("no-discrimination");
  });

  it("refuses execution-failed when the runner applies material other than the declared gold patch", async () => {
    const port = async (request: EnvironmentRunRequest) => ({
      passed: [], failed: ["target"], passedMatch: false,
      appliedPatchDigest: request.patch.kind === "gold" ? D("9") : null,
    });
    const result = await admitCandidate({ runInEnvironment: port, issuer: "https://jinn.network/agents/a" } as never, candidate, recordBytes);
    expect("refusal" in result && result.refusal.code).toBe("execution-failed");
  });

  it("refuses execution-failed when the runner throws", async () => {
    const port = async () => { throw new Error("container runtime unavailable"); };
    const result = await admitCandidate({ runInEnvironment: port, issuer: "https://jinn.network/agents/a" } as never, candidate, recordBytes);
    expect("refusal" in result && result.refusal.code).toBe("execution-failed");
    expect("refusal" in result && result.refusal.detail).toContain("container runtime unavailable");
  });
});
