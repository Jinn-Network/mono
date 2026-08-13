import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { createRuntimeEvidenceAdapter } from "../adapter.js";
import { getSealedBytes } from "../../workspace/sealed-store.js";
import { harborSelectionManifestBytes, harborSelectionManifestSha256, type HarborSelectionManifest } from "./manifest.js";
import {
  HARBOR_ATIF_ROLE, HARBOR_CORRELATION_ROLE, HARBOR_JOB_CONFIG_ROLE, HARBOR_JOB_RESULT_ROLE,
  HARBOR_REWARD_ROLE, HARBOR_SELECTION_ROLE, HARBOR_TRIAL_CONFIG_ROLE, HARBOR_TRIAL_RESULT_ROLE,
  HarborDirectVenue, harborEvidenceContribution, readHarborArchiveOnly, type HarborCommandRunner,
} from "./venue.js";

const encode = new TextEncoder();
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const base64 = (value: string | Uint8Array) => Buffer.from(typeof value === "string" ? encode.encode(value) : value).toString("base64");
const artifact = (role: string, name: string, bytes: string | Uint8Array) => ({ role, name, mediaType: "application/json", base64: base64(bytes) });
const manifest: HarborSelectionManifest = {
  schema: "jinn.network/benchmark-product/harbor-selection/1",
  adapter: { id: "harbor", version: "1" },
  harbor: { version: "0.21.4", executableSha256: "a".repeat(64) },
  dataset: { reference: "harbor://datasets/demo", revision: "r1", checksum: "b".repeat(64) },
  task: { reference: "harbor://tasks/demo", revision: "r2", checksum: "c".repeat(64) },
  agent: { id: "agent", configuration: { system: "pinned" } }, model: { id: "model", configuration: { temperature: 0 } },
  environment: { image: "registry.example/env@sha256:abc", configuration: {} },
  retryPolicy: { nAttempts: 1, nConcurrent: 1, maxRetries: 0 },
};

function output(jobId: string, trialId: string, options: { readonly atif?: boolean; readonly collectionFailure?: boolean } = {}) {
  return {
    job: { id: jobId, config: artifact(HARBOR_JOB_CONFIG_ROLE, "job-config.json", "job-config"), result: artifact(HARBOR_JOB_RESULT_ROLE, "job-result.json", "job-result") },
    trial: { id: trialId, config: artifact(HARBOR_TRIAL_CONFIG_ROLE, "trial-config.json", "trial-config"), result: artifact(HARBOR_TRIAL_RESULT_ROLE, "trial-result.json", "trial-result") },
    reward: artifact(HARBOR_REWARD_ROLE, "reward.json", "reward-map"),
    ...(options.atif ? { atif: artifact(HARBOR_ATIF_ROLE, "trajectory.json", new Uint8Array([0, 255, 1])) } : {}),
    ...(options.collectionFailure ? { collectionFailures: [{ role: HARBOR_ATIF_ROLE, reason: "Harbor collector timed out" }] } : {}),
  };
}

function fakeRunner(result: unknown, calls: string[][], code = 0): HarborCommandRunner {
  return { async run(_command, args) {
    calls.push([...args]);
    if (args[0] === "--version") return { code: 0, stdout: encode.encode("harbor 0.21.4\n"), stderr: new Uint8Array() };
    return { code, stdout: encode.encode(JSON.stringify(result)), stderr: new Uint8Array() };
  } };
}
function lineage(index = 1) { return { jinnManaged: true as const, submissionSha256: `${index}`.repeat(64), attemptUri: `urn:jinn:attempt:${index}`, runSha256: "d".repeat(64), cellKey: "task/arm/0", dispatchIndex: index }; }

describe("managed direct Harbor 0.21 venue", () => {
  test("seals only Harbor 0.21.x and immutable no-retry selection", async () => {
    expect(manifest.retryPolicy).toEqual({ nAttempts: 1, nConcurrent: 1, maxRetries: 0 });
    expect(() => harborSelectionManifestBytes({ ...manifest, retryPolicy: { nAttempts: 2, nConcurrent: 1, maxRetries: 0 } } as unknown as HarborSelectionManifest)).toThrow();
    expect(() => harborSelectionManifestBytes({ ...manifest, harbor: { ...manifest.harbor, version: "0.22.0" } })).toThrow();
  });

  test("uses argv, archives exact bytes before Delivery, and post-hoc reads CAS without rerunning", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "harbor-venue-"));
    try {
      const calls: string[][] = []; let delivered = false;
      const venue = new HarborDirectVenue({ workspaceDir: workspace, executable: "fake;never-a-shell", runner: fakeRunner(output("job-1", "trial-1", { atif: true }), calls) });
      const archive = await venue.dispatch({ manifest, lineage: lineage(), async deliver(value) {
        delivered = true;
        expect(getSealedBytes(workspace, value.correlation.digest.sha256)).toBeInstanceOf(Uint8Array);
        expect(value.nativeArtifacts).toHaveLength(6);
      } });
      expect(delivered).toBe(true);
      expect(calls[1]).toEqual(["jobs", "run", "--config", expect.any(String), "--n-attempts", "1", "--n-concurrent", "1", "--max-retries", "0", "--json"]);
      const atif = archive.nativeArtifacts.find((value) => value.role === HARBOR_ATIF_ROLE)!.artifact!;
      expect(getSealedBytes(workspace, atif.digest.sha256)).toEqual(new Uint8Array([0, 255, 1]));
      const before = calls.length;
      expect(readHarborArchiveOnly(workspace, archive)).toHaveLength(8);
      expect(calls).toHaveLength(before);
      const contribution = harborEvidenceContribution(workspace, archive);
      expect(contribution.correlations.map((value) => value.role)).toEqual([HARBOR_SELECTION_ROLE, HARBOR_CORRELATION_ROLE]);
      const selectionBytes = harborSelectionManifestBytes(manifest);
      const adapter = createRuntimeEvidenceAdapter({ adapterId: "harbor", selectionManifestSha256: harborSelectionManifestSha256(manifest) }, { registrationArtifacts: [{ id: "selection.json", role: HARBOR_SELECTION_ROLE, digest: `sha256:${digest(selectionBytes)}` as `sha256:${string}`, bytes: selectionBytes, mediaType: "application/json", actions: ["store"] }] });
      const verified = await adapter.verify({ dispatch: { index: 1, submission: { kind: "https://spec.jinn.network/records/submission/v1", record: { name: "submission", mediaType: "application/json", digest: { sha256: "e".repeat(64) } } }, evidence: [], evaluations: [], ...contribution }, references: { async getExact({ digest: key }) { return getSealedBytes(workspace, key.slice("sha256:".length)); } } });
      expect(verified).toEqual(expect.arrayContaining([expect.objectContaining({ name: "harbor-required-native-evidence", status: "pass" }), expect.objectContaining({ name: "harbor-exact-native-evidence", status: "pass" })]));
      const tampered = await adapter.verify({ dispatch: { index: 1, submission: { kind: "https://spec.jinn.network/records/submission/v1", record: { name: "submission", mediaType: "application/json", digest: { sha256: "e".repeat(64) } } }, evidence: [], evaluations: [], ...contribution }, references: { async getExact() { return encode.encode("tampered Harbor evidence"); } } });
      expect(tampered).toEqual(expect.arrayContaining([expect.objectContaining({ name: "harbor-exact-native-evidence", status: "fail" })]));
      const missingRole = await adapter.verify({ dispatch: { index: 1, submission: { kind: "https://spec.jinn.network/records/submission/v1", record: { name: "submission", mediaType: "application/json", digest: { sha256: "e".repeat(64) } } }, evidence: [], evaluations: [], correlations: contribution.correlations, nativeArtifacts: contribution.nativeArtifacts.filter((value) => value.role !== HARBOR_REWARD_ROLE) } });
      expect(missingRole).toEqual(expect.arrayContaining([expect.objectContaining({ name: "harbor-required-native-evidence", status: "fail" })]));
    } finally { await rm(workspace, { recursive: true, force: true }); }
  });

  test("keeps cancellation/failure/partial collection visible and creates replacements as new Jobs", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "harbor-venue-"));
    try {
      let deliveries = 0;
      const failed = new HarborDirectVenue({ workspaceDir: workspace, executable: "fake", runner: fakeRunner(output("unused", "unused"), [], 1) });
      await expect(failed.dispatch({ manifest, lineage: lineage(), deliver: async () => { deliveries += 1; } })).rejects.toThrow("job failed");
      expect(deliveries).toBe(0);
      const cancelled = new HarborDirectVenue({ workspaceDir: workspace, executable: "fake", runner: { async run(_command, args) { if (args[0] === "--version") return { code: 0, stdout: encode.encode("harbor 0.21.4"), stderr: new Uint8Array() }; throw new Error("AbortError"); } } });
      await expect(cancelled.dispatch({ manifest, lineage: lineage(), deliver: async () => { deliveries += 1; } })).rejects.toThrow("AbortError");
      const calls: string[][] = []; const venue = new HarborDirectVenue({ workspaceDir: workspace, executable: "fake", runner: fakeRunner(output("job-1", "trial-1", { collectionFailure: true }), calls) });
      const first = await venue.dispatch({ manifest, lineage: lineage(1), deliver: async () => {} });
      const replacement = new HarborDirectVenue({ workspaceDir: workspace, executable: "fake", runner: fakeRunner(output("job-2", "trial-2"), calls) });
      const second = await replacement.dispatch({ manifest, lineage: lineage(2), deliver: async () => {} });
      expect(first.nativeArtifacts).toEqual(expect.arrayContaining([expect.objectContaining({ role: HARBOR_ATIF_ROLE, availability: "collection-failed" })]));
      expect([first.jobId, second.jobId]).toEqual(["job-1", "job-2"]);
      await expect(venue.dispatch({ manifest, lineage: { ...lineage(), jinnManaged: false } as never, deliver: async () => {} })).rejects.toThrow("historical Harbor jobs");
    } finally { await rm(workspace, { recursive: true, force: true }); }
  });
});
