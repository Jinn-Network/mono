/**
 * PUB-15 direct-runtime acceptance fixture.  This intentionally drives the product operations
 * (rather than a Harbor adapter in isolation): public registration must be complete before the
 * first actual Harbor process, every dispatch is source-announced before `submit`, and the
 * accounting verifier consumes the exact retained Harbor closure without another invocation.
 */
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseBenchmarkAccounting } from "@jinn-network/benchmarking-records";
import { armAdd } from "../operations/arms.js";
import { createDraft } from "../operations/drafts.js";
import { selectHarborRuntime } from "../operations/harbor-runtime.js";
import { initWorkspace } from "../operations/init.js";
import { publicationAccounting } from "../operations/publication-accounting.js";
import { publicationConfigure, publicationRegister } from "../operations/publication-register.js";
import { runLaunch } from "../operations/run-launch.js";
import { runCollect } from "../operations/run-collect.js";
import { runLock } from "../operations/run-lock.js";
import { runQuote } from "../operations/run-quote.js";
import { sampleInit } from "../operations/sample.js";
import { readRunJournalEntries } from "../run/journal.js";
import { createWorkspacePublicationHttpHandler, publicArchiveUrl, recordPath } from "../run/publication-source.js";
import { readRunState } from "../run/state.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import type { HarborSelectionManifest } from "../runtime/harbor/manifest.js";

const manifest: Pick<HarborSelectionManifest, "arms" | "environment" | "outputs"> = {
  arms: [
    { armId: "one", agent: { id: "agent-one", configuration: {} }, model: { id: "model-one", configuration: {} }, jobAgent: { name: "agent-one", model_name: "model-one" } },
    { armId: "two", agent: { id: "agent-two", configuration: {} }, model: { id: "model-two", configuration: {} }, jobAgent: { name: "agent-two", model_name: "model-two" } },
  ],
  environment: { type: "docker", image: `registry.example/env@sha256:${"d".repeat(64)}`, configuration: {} },
  outputs: [{ name: "prediction", mediaType: "application/json", artifact: { source: "/logs/artifacts/prediction.json", destination: "prediction.json" }, nativePath: "artifacts/prediction.json" }],
};

async function fakeHarbor(root: string, tracePath: string): Promise<string> {
  const executable = join(root, "harbor");
  await writeFile(executable, `#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("harbor 0.21.4\\n"); process.exit(0); }
if (args[0] !== "run" || args[1] !== "-c" || args.length !== 3) process.exit(64);
const config = JSON.parse(readFileSync(args[2], "utf8"));
if (config.n_attempts !== 1 || config.n_concurrent_trials !== 1 || config.retry.max_retries !== 0) throw new Error("hidden Harbor retry");
if (!Array.isArray(config.tasks) || config.datasets !== undefined || config.tasks.length !== 1) throw new Error("expected direct task source");
writeFileSync(${JSON.stringify(tracePath)}, "harbor:" + config.job_name + "\\n", { flag: "a" });
const job = join(config.jobs_dir, config.job_name), trial = join(job, "trial-1");
mkdirSync(join(trial, "verifier"), { recursive: true }); mkdirSync(join(trial, "artifacts"), { recursive: true });
writeFileSync(join(job, "config.json"), JSON.stringify(config)); writeFileSync(join(job, "result.json"), JSON.stringify({ id: config.job_name, status: "success", n_total_trials: 1, stats: { n_retries: 0 } }));
writeFileSync(join(trial, "config.json"), JSON.stringify({ task: config.tasks[0], agent: config.agents[0] })); writeFileSync(join(trial, "result.json"), JSON.stringify({ id: config.job_name + ":trial-1", status: "success" }));
writeFileSync(join(trial, "verifier", "reward.txt"), "1\\n"); writeFileSync(join(trial, "artifacts", "prediction.json"), JSON.stringify({ probabilityYes: "0.5", submittedAt: "2026-08-13T00:00:00Z" }));
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  return executable;
}

async function startSource(workspaceDir: string, tracePath: string): Promise<{ readonly base: string; readonly close: () => Promise<void> }> {
  const handler = createWorkspacePublicationHttpHandler(workspaceDir);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    await appendFile(tracePath, `source:${request.method ?? "GET"}:${url.pathname}\n`, { encoding: "utf8" });
    const result = await handler(new Request(url, { method: request.method }));
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("loopback source has no address");
  return { base: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe("PUB-15 direct Harbor public-before-dispatch", () => {
  test("registers exact source bytes before actual Harbor dispatch and verifies the later exact accounting closure", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "pub15-harbor-direct-"));
    let source: Awaited<ReturnType<typeof startSource>> | undefined;
    try {
      const tracePath = join(workspaceDir, "external-order.trace");
      const executable = await fakeHarbor(workspaceDir, tracePath);
      const material = join(workspaceDir, "task"); await mkdir(material);
      await writeFile(join(material, "task.toml"), `[task]\nname = "demo/task"\n[environment]\ndocker_image = "${manifest.environment.image}"\n`);
      const context = { workspaceDir, principal: "publisher", clock: () => new Date().toISOString() };
      expect(initWorkspace(context).ok).toBe(true);
      expect(createDraft(context, { draftId: "direct", name: "Direct public Harbor" }).ok).toBe(true);
      expect((await sampleInit(context, { draftId: "direct" })).ok).toBe(true);
      for (const arm of manifest.arms) expect(armAdd(context, { draftId: "direct", armId: arm.armId, pinning: { harness: { id: "placeholder", version: "1" } } }).ok).toBe(true);
      const selection = await selectHarborRuntime(context, { draftId: "direct", executable, source: { kind: "task", input: { name: "demo/task", ref: "r1" }, materialPath: material, revision: "r1" }, ...manifest });
      expect(selection.ok, JSON.stringify(selection)).toBe(true);
      expect((await runQuote(context, { draftId: "direct" })).ok).toBe(true);
      expect(runLock(context, { draftId: "direct" }).ok).toBe(true);
      source = await startSource(workspaceDir, tracePath);
      expect((await publicationConfigure(context, { draftId: "direct", publicBaseUrl: source.base })).ok).toBe(true);
      const registration = await publicationRegister(context, { draftId: "direct" });
      expect(registration.ok, JSON.stringify(registration)).toBe(true);
      expect((await readFile(tracePath, "utf8")).split("\n").filter((line) => line.startsWith("harbor:"))).toHaveLength(0);

      const launched = await runLaunch(context, { draftId: "direct" });
      expect(launched.ok, JSON.stringify(launched)).toBe(true);
      const journal = readRunJournalEntries(workspaceDir, "direct");
      const captured = journal.filter((entry) => entry.kind === "submission-captured");
      const delivered = journal.filter((entry) => entry.kind === "delivery");
      expect(captured).toHaveLength(delivered.length);
      expect(captured.length).toBeGreaterThan(0);
      for (const entry of captured) expect(entry.publicationSourceSequence).toMatch(/^\d{16}$/u);
      const runSha256 = readRunState(workspaceDir, "direct")?.runSha256;
      expect(runSha256).toMatch(/^[a-f0-9]{64}$/u);
      const runPath = new URL(publicArchiveUrl(source.base, recordPath(`sha256:${runSha256!}`))).pathname;
      const submissionPaths = new Set(captured.map((entry) => new URL(publicArchiveUrl(source!.base, recordPath(`sha256:${entry.submissionSha256}`))).pathname));
      const launchTrace = (await readFile(tracePath, "utf8")).trim().split("\n");
      const runGetIndex = launchTrace.indexOf(`source:GET:${runPath}`);
      const submissionGetIndexes = launchTrace.flatMap((line, index) => {
        const path = line.startsWith("source:GET:") ? line.slice("source:GET:".length) : undefined;
        return path !== undefined && submissionPaths.has(path) ? [index] : [];
      });
      expect(runGetIndex).toBeGreaterThanOrEqual(0);
      expect(submissionGetIndexes).toHaveLength(captured.length);
      expect(submissionGetIndexes.every((index) => runGetIndex < index)).toBe(true);
      for (const path of submissionPaths) expect(launchTrace).toContain(`source:GET:${path}`);
      let submissionGets = 0;
      let harborInvocations = 0;
      for (const line of launchTrace) {
        if (line.startsWith("source:GET:") && submissionPaths.has(line.slice("source:GET:".length))) submissionGets += 1;
        if (line.startsWith("harbor:")) {
          expect(submissionGets).toBeGreaterThan(harborInvocations);
          harborInvocations += 1;
        }
      }
      expect(harborInvocations).toBe(captured.length);

      const collected = await runCollect(context, { draftId: "direct" });
      expect(collected.ok, JSON.stringify(collected)).toBe(true);
      const published = await publicationAccounting(context, { draftId: "direct" });
      expect(published.ok, JSON.stringify(published)).toBe(true);
      if (!published.ok) return;
      const accountingBytes = getSealedBytes(workspaceDir, published.result.accountingSha256);
      const accounting = parseBenchmarkAccounting(accountingBytes);
      expect(accounting.publicRegistration.status).toBe("pre-dispatch");
      expect(accounting.cells.flatMap((cell) => cell.dispatches)).toHaveLength(captured.length);
      const publicBytes = new Uint8Array(await (await fetch(publicArchiveUrl(source.base, recordPath(`sha256:${published.result.accountingSha256}`)))).arrayBuffer());
      expect(publicBytes).toEqual(accountingBytes);
      const registrationSequence = readRunState(workspaceDir, "direct")?.publication?.registration.receipt?.sourceSequence;
      expect(registrationSequence).toMatch(/^\d{16}$/u);
      expect(BigInt(registrationSequence!)).toBeLessThan(BigInt(captured[0]!.publicationSourceSequence!));
      expect((await readFile(tracePath, "utf8")).split("\n").filter((line) => line.startsWith("harbor:"))).toHaveLength(harborInvocations);
    } finally {
      await source?.close();
      await rm(workspaceDir, { recursive: true, force: true });
    }
  }, 120_000);
});
