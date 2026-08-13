import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { armAdd } from "../../operations/arms.js";
import { createDraft } from "../../operations/drafts.js";
import { initWorkspace } from "../../operations/init.js";
import { selectHarborRuntime } from "../../operations/harbor-runtime.js";
import { runLaunch } from "../../operations/run-launch.js";
import { runLock } from "../../operations/run-lock.js";
import { runQuote } from "../../operations/run-quote.js";
import { sampleInit } from "../../operations/sample.js";
import { readRunJournalEntries } from "../../run/journal.js";
import { createRuntimeEvidenceAdapter } from "../adapter.js";
import { artifactsDir } from "../../workspace/layout.js";
import { getSealedBytes } from "../../workspace/sealed-store.js";
import { recordHarborDispatchMapping } from "../../venue/provisioner.js";
import { harborSelectionManifestBytes, type HarborSelectionManifest } from "./manifest.js";
import { HARBOR_ATIF_ROLE, HARBOR_LOGS_ROLE, HARBOR_SELECTION_ROLE, harborEvidenceContributionFromArchive, readHarborDispatchArchive } from "./venue.js";

const manifest: HarborSelectionManifest = {
  schema: "jinn.network/benchmark-product/harbor-selection/1", adapter: { id: "harbor", version: "1" },
  harbor: { version: "0.21.4", executableSha256: "a".repeat(64) },
  dataset: { reference: "harbor://datasets/demo", revision: "r1", checksum: "b".repeat(64) },
  task: { reference: "harbor://tasks/demo", revision: "r2", checksum: "c".repeat(64) },
  agent: { id: "agent", configuration: { system: "pinned" } }, model: { id: "model", configuration: { temperature: 0 } },
  environment: { image: "registry.example/env@sha256:abc", configuration: {} }, retryPolicy: { nAttempts: 1, nConcurrent: 1, maxRetries: 0 },
};

async function fakeHarbor(root: string): Promise<string> {
  const executable = join(root, "fake-harbor.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("harbor 0.21.4\\n"); process.exit(0); }
if (args[0] !== "run" || args[1] !== "-c" || args.length !== 3) process.exit(64);
const config = JSON.parse(readFileSync(args[2], "utf8"));
const job = join(config.jobs_dir, config.job_name); const trial = join(job, "trial-1");
mkdirSync(join(trial, "agent"), { recursive: true }); mkdirSync(join(trial, "verifier"), { recursive: true }); mkdirSync(join(trial, "artifacts"), { recursive: true });
writeFileSync(join(job, "config.json"), JSON.stringify(config));
writeFileSync(join(job, "result.json"), JSON.stringify({ id: config.job_name, status: "success" }));
writeFileSync(join(trial, "config.json"), JSON.stringify({ attempt_number: 1, task: config.tasks[0], agent: config.agents[0] }));
writeFileSync(join(trial, "result.json"), JSON.stringify({ id: config.job_name + ":trial-1", status: "success" }));
writeFileSync(join(trial, "agent", "recording.cast"), Buffer.from([0, 255, 1]));
writeFileSync(join(trial, "agent", "trajectory.json"), JSON.stringify({ schema: "ATIF" }));
writeFileSync(join(trial, "verifier", "reward.txt"), "1\\n");
writeFileSync(join(trial, "ctrf.json"), JSON.stringify({ results: [] }));
writeFileSync(join(trial, "artifacts", "manifest.json"), JSON.stringify({ files: ["unknown.bin"] }));
writeFileSync(join(trial, "artifacts", "unknown.bin"), Buffer.from([7, 8, 9]));
writeFileSync(join(dirname(config.jobs_dir), "prediction"), JSON.stringify({ probabilityYes: "0.5", submittedAt: "2026-01-01T00:00:00Z" }));
process.stdout.write("fake harbor completed\\n");
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  return executable;
}

describe("managed Harbor 0.21 lifecycle adapter", () => {
  test("selection is immutable and accepts only Harbor 0.21.x", () => {
    expect(manifest.retryPolicy).toEqual({ nAttempts: 1, nConcurrent: 1, maxRetries: 0 });
    expect(() => harborSelectionManifestBytes({ ...manifest, retryPolicy: { nAttempts: 2, nConcurrent: 1, maxRetries: 0 } } as never)).toThrow();
    expect(() => harborSelectionManifestBytes({ ...manifest, harbor: { ...manifest.harbor, version: "0.22.0" } })).toThrow();
  });

  test("append-only reverse indexes reject concurrent Harbor Job/Trial reuse", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "harbor-mapping-race-"));
    try {
      const settled = await Promise.allSettled([
        recordHarborDispatchMapping(workspaceDir, "jinn-dispatch-a", "job-shared", "trial-a"),
        recordHarborDispatchMapping(workspaceDir, "jinn-dispatch-b", "job-shared", "trial-b"),
      ]);
      expect(settled.filter((value) => value.status === "fulfilled")).toHaveLength(1);
      expect(settled.filter((value) => value.status === "rejected")).toHaveLength(1);
    } finally { await rm(workspaceDir, { recursive: true, force: true }); }
  });

  test("runLaunch uses the default host/backend, preserves solve output, and archives the official direct-root Trial tree", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "harbor-lifecycle-"));
    try {
      const executable = await fakeHarbor(workspaceDir);
      const clock = () => new Date().toISOString();
      const context = { workspaceDir, principal: "sponsor-1", clock };
      expect(initWorkspace(context).ok).toBe(true);
      expect(createDraft(context, { draftId: "harbor-run", name: "Harbor run" }).ok).toBe(true);
      expect((await sampleInit(context, { draftId: "harbor-run" })).ok).toBe(true);
      expect(armAdd(context, { draftId: "harbor-run", armId: "one", pinning: { harness: { id: "placeholder", version: "1" }, harborArm: "one" } }).ok).toBe(true);
      expect(armAdd(context, { draftId: "harbor-run", armId: "two", pinning: { harness: { id: "placeholder", version: "1" }, harborArm: "two" } }).ok).toBe(true);
      const selected = await selectHarborRuntime(context, { draftId: "harbor-run", executable, dataset: manifest.dataset, task: manifest.task, agent: manifest.agent, model: manifest.model, environment: manifest.environment });
      expect(selected.ok).toBe(true);
      if (!selected.ok) throw new Error("Harbor selection unexpectedly failed");
      const quoted = await runQuote(context, { draftId: "harbor-run" });
      expect(quoted.ok, JSON.stringify(quoted)).toBe(true);
      expect(runLock(context, { draftId: "harbor-run" }).ok).toBe(true);
      const launched = await runLaunch(context, { draftId: "harbor-run" });
      expect(launched.ok, JSON.stringify(launched)).toBe(true);

      const journal = readRunJournalEntries(workspaceDir, "harbor-run");
      const deliveries = journal.filter((entry) => entry.kind === "delivery");
      expect(deliveries.length, JSON.stringify(journal)).toBeGreaterThan(0);
      // The Task's declared solve output remains the Delivery contract; Harbor-native evidence
      // is separately reachable through the durable product archive index checked below.
      for (const delivery of deliveries) expect(delivery.outputs.map((output) => output.name)).toEqual(["prediction"]);
      expect(journal.some((entry) => entry.kind === "evaluation")).toBe(true);

      const indexRoot = join(artifactsDir(workspaceDir), "harbor", "archives", "by-dispatch");
      const indexes = await readdir(indexRoot);
      expect(indexes.length).toBe(deliveries.length);
      const index = JSON.parse(await readFile(join(indexRoot, indexes[0]!), "utf8")) as { archiveSha256: string };
      const archive = readHarborDispatchArchive(workspaceDir, index.archiveSha256);
      expect(archive.lineage).toMatchObject({ runSha256: expect.stringMatching(/^[a-f0-9]{64}$/), submissionSha256: expect.stringMatching(/^[a-f0-9]{64}$/), dispatchIndex: 1 });
      expect(archive.harbor).toMatchObject({ jobId: expect.any(String), trialId: expect.any(String), status: "completed" });
      expect(archive.nativeArtifacts.map((item) => item.path)).toEqual(expect.arrayContaining(["config.json", "result.json", "trial-1/config.json", "trial-1/result.json", "trial-1/ctrf.json", "trial-1/artifacts/unknown.bin"]));
      const unknown = archive.nativeArtifacts.find((item) => item.path.endsWith("unknown.bin"))!;
      expect(getSealedBytes(workspaceDir, unknown.sha256)).toEqual(new Uint8Array([7, 8, 9]));
      const before = indexes.length;
      const contribution = harborEvidenceContributionFromArchive(workspaceDir, index.archiveSha256);
      expect(contribution.correlations).toHaveLength(2);
      expect(contribution.nativeArtifacts.filter((item) => item.role === HARBOR_ATIF_ROLE).length).toBeGreaterThanOrEqual(2);
      expect(contribution.nativeArtifacts.filter((item) => item.role === HARBOR_LOGS_ROLE).length).toBeGreaterThanOrEqual(2);
      const selectionBytes = getSealedBytes(workspaceDir, selected.result.selectionManifestSha256);
      const adapter = createRuntimeEvidenceAdapter(
        { adapterId: "harbor", selectionManifestSha256: selected.result.selectionManifestSha256 },
        { registrationArtifacts: [{ id: "harbor-selection.json", role: HARBOR_SELECTION_ROLE, digest: `sha256:${selected.result.selectionManifestSha256}`, bytes: selectionBytes, mediaType: "application/json", actions: ["store"] }] },
      );
      const checks = await adapter.verify({
        dispatch: {
          index: 1,
          submission: { kind: "https://spec.jinn.network/records/submission/v1", record: { name: "submission.json", mediaType: "application/json", digest: { sha256: archive.lineage.submissionSha256 } } },
          evidence: [], evaluations: [], ...contribution,
        },
        references: { async getExact({ digest }) { return getSealedBytes(workspaceDir, digest.slice("sha256:".length)); } },
      });
      expect(checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "runtime-evidence-unique-roles", status: "pass" }),
        expect.objectContaining({ name: "harbor-required-native-evidence", status: "pass" }),
        expect.objectContaining({ name: "harbor-job-trial-structure", status: "pass" }),
        expect.objectContaining({ name: "harbor-exact-native-evidence", status: "pass" }),
      ]));
      expect(await readdir(indexRoot)).toHaveLength(before);
    } finally { await rm(workspaceDir, { recursive: true, force: true }); }
  }, 120_000);
});
