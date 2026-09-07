import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const verifyPublicBundleMock = vi.hoisted(() => vi.fn());
vi.mock("@colophon-claims/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@colophon-claims/core")>()),
  verifyPublicBundle: verifyPublicBundleMock,
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { guidedVerifyBundleAction } = await import("@/app/actions");

const DIGEST = "a".repeat(64);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  verifyPublicBundleMock.mockReset();
});

function bundleForm(): FormData {
  const root = mkdtempSync(join(tmpdir(), "colophon-web-verify-"));
  roots.push(root);
  const data = new FormData();
  data.set("bundle", root);
  return data;
}

function evidenceNativeResult(): unknown {
  return {
    format: "benchmark-product-public-bundle/5",
    profile: "https://spec.jinn.network/profiles/benchmark-product-public-bundle/5",
    // The evidence-native line's identity already carries the prefix (issue #3312).
    identity: `sha256:${DIGEST}`,
    checks: [
      "manifest", "evidence-closure", "artifact-integrity", "signature-validity",
      "matrix-rederivation", "report-verification", "claim-consistency",
    ],
    artifactContent: { status: "verified", verified: 2, notFetched: 0, notFetchedDigests: [] },
    benchmarkDigest: `sha256:${DIGEST}`, manifestDigest: `sha256:${DIGEST}`,
    cohortDigest: `sha256:${DIGEST}`, matrixDigest: `sha256:${DIGEST}`, reportDigest: `sha256:${DIGEST}`,
    evidenceRecords: 3, artifacts: 2, verifiedSignerKeyIds: [],
  };
}

function legacyResult(): unknown {
  return {
    format: "benchmark-product-public-bundle/2",
    // The legacy line returns a bare digest.
    identity: DIGEST,
    checks: ["manifest", "evidence-closure", "trust", "matrix-rederivation", "report-verification", "claim-consistency"],
    benchmarkSha256: DIGEST, runSha256: DIGEST, matrixSha256: DIGEST,
    reportSha256: DIGEST, reportEnvelopeSha256: DIGEST,
  };
}

describe("guided verify bundle action", () => {
  test("renders one sha256 prefix for an evidence-native identity", async () => {
    verifyPublicBundleMock.mockResolvedValue(evidenceNativeResult());
    const state = await guidedVerifyBundleAction({ status: "idle" }, bundleForm());
    expect(state.status).toBe("success");
    expect(state).toMatchObject({ result: { identity: `sha256:${DIGEST}` } });
  });

  test("renders one sha256 prefix for a legacy bare-digest identity", async () => {
    verifyPublicBundleMock.mockResolvedValue(legacyResult());
    const state = await guidedVerifyBundleAction({ status: "idle" }, bundleForm());
    expect(state.status).toBe("success");
    expect(state).toMatchObject({ result: { identity: `sha256:${DIGEST}` } });
  });

  test("states no check count on the failure path, where no format is known", async () => {
    verifyPublicBundleMock.mockRejectedValue(new Error("record-integrity"));
    const state = await guidedVerifyBundleAction({ status: "idle" }, bundleForm());
    expect(state.status).toBe("error");
    const detail = state.status === "error" ? state.error.detail : "";
    expect(detail).toContain("did not pass the bundle checks");
    expect(detail).not.toMatch(/\b(?:six|seven|[0-9]+)\s+(?:bundle\s+)?checks\b/iu);
  });
});
