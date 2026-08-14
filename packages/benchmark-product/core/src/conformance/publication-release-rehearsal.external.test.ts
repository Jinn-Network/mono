/**
 * Opt-in release rehearsal through the installed Harbor 0.21 binary and Docker.
 *
 * The built-in Oracle agent executes the pinned fixture solution, so this test never invokes
 * an LLM or forwards model credentials. It is deliberately excluded from default CI because it
 * requires a local Docker daemon and the exact Harbor executable selected by the operator.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { parseBenchmarkAccounting, parseSignedReportRecord } from "@jinn-network/benchmarking-records";
import { armAdd } from "../operations/arms.js";
import { createDraft } from "../operations/drafts.js";
import { selectHarborRuntime } from "../operations/harbor-runtime.js";
import { initWorkspace } from "../operations/init.js";
import { publicationAccounting } from "../operations/publication-accounting.js";
import { publicationConfigure, publicationRegister } from "../operations/publication-register.js";
import { publicationReport } from "../operations/publication-report.js";
import { runCollect } from "../operations/run-collect.js";
import { runLaunch } from "../operations/run-launch.js";
import { runLock } from "../operations/run-lock.js";
import { runQuote } from "../operations/run-quote.js";
import { sampleInit } from "../operations/sample.js";
import { readRunJournalEntries } from "../run/journal.js";
import { createWorkspacePublicationHttpHandler, publicArchiveUrl, recordPath } from "../run/publication-source.js";
import { readRunState } from "../run/state.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import { assertSupportedHarborVersion } from "../runtime/harbor/manifest.js";

const optedIn = process.env.COLOPHON_PUBLICATION_RELEASE_REHEARSAL === "1";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const taskMaterialPath = resolve(packageRoot, "test/fixtures/publication-release-rehearsal/task");
const pinnedImage = `ubuntu@sha256:${"561618e2c15bf2397621dd04f96926663a3b5616c189cf7e38db7e82f5c538ea"}`;

function invoke(executable: string, argv: readonly string[]): Promise<string> {
  return new Promise((resolveInvocation, reject) => {
    execFile(executable, [...argv], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HARBOR_TELEMETRY: "0", DO_NOT_TRACK: "1" },
      timeout: 30_000,
    }, (error, stdout, stderr) => error === null
      ? resolveInvocation(stdout.trim())
      : reject(new Error(`${executable} ${argv.join(" ")} failed: ${stderr}`, { cause: error })));
  });
}

async function startSource(workspaceDir: string): Promise<{ readonly base: string; readonly close: () => Promise<void> }> {
  const handler = createWorkspacePublicationHttpHandler(workspaceDir);
  const server: Server = createServer(async (request, response) => {
    const result = await handler(new Request(new URL(request.url ?? "/", "http://127.0.0.1"), { method: request.method }));
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("release-rehearsal source has no loopback address");
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}

async function exactPublicRecord(base: string, workspaceDir: string, digest: string): Promise<void> {
  const url = publicArchiveUrl(base, recordPath(`sha256:${digest}`));
  const head = await fetch(url, { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(new Uint8Array(await (await fetch(url)).arrayBuffer())).toEqual(getSealedBytes(workspaceDir, digest));
}

test.skipIf(!optedIn)("real Harbor and Docker publish a prospective closure without a model call or rerun", async () => {
  const executable = process.env.COLOPHON_PUBLICATION_RELEASE_HARBOR;
  if (executable === undefined || !existsSync(executable)) throw new Error("set COLOPHON_PUBLICATION_RELEASE_HARBOR to the exact Harbor executable");
  const harborVersion = (await invoke(executable, ["--version"])).replace(/^harbor\s+/iu, "");
  assertSupportedHarborVersion(harborVersion);
  await invoke(process.env.COLOPHON_PUBLICATION_RELEASE_DOCKER ?? "docker", ["info", "--format", "{{json .ServerVersion}}"]);

  const workspaceDir = await mkdtemp(join(tmpdir(), "colophon-publication-release-"));
  let source: Awaited<ReturnType<typeof startSource>> | undefined;
  try {
    const context = { workspaceDir, principal: "release-publisher", clock: () => new Date().toISOString() };
    expect(initWorkspace(context).ok).toBe(true);
    expect(createDraft(context, { draftId: "release", name: "Publication release rehearsal" }).ok).toBe(true);
    expect((await sampleInit(context, { draftId: "release" })).ok).toBe(true);
    for (const armId of ["oracle-a", "oracle-b"] as const) {
      expect(armAdd(context, { draftId: "release", armId, pinning: { harness: { id: `harbor-${armId}`, version: "1.0.0" } } }).ok).toBe(true);
    }
    const selected = await selectHarborRuntime(context, {
      draftId: "release",
      executable,
      source: {
        kind: "task",
        input: { name: "jinn/publication-release-rehearsal", ref: "fixture-v1" },
        materialPath: taskMaterialPath,
        revision: "fixture-v1",
      },
      arms: ["oracle-a", "oracle-b"].map((armId) => ({
        armId,
        agent: { id: "oracle", configuration: {} },
        model: { id: armId, configuration: {} },
        jobAgent: { name: "oracle", model_name: armId },
      })),
      environment: { type: "docker", image: pinnedImage, configuration: {} },
      outputs: [{
        name: "prediction",
        mediaType: "application/json",
        artifact: { source: "/logs/artifacts/prediction.json", destination: "prediction.json" },
        nativePath: "artifacts/prediction.json",
      }],
    });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    const quote = await runQuote(context, { draftId: "release" });
    expect(quote.ok, JSON.stringify(quote)).toBe(true);
    expect(runLock(context, { draftId: "release" }).ok).toBe(true);

    source = await startSource(workspaceDir);
    expect((await publicationConfigure(context, { draftId: "release", publicBaseUrl: source.base })).ok).toBe(true);
    expect((await publicationRegister(context, { draftId: "release" })).ok).toBe(true);
    expect(readRunJournalEntries(workspaceDir, "release").filter((entry) => entry.kind === "delivery")).toHaveLength(0);

    const launched = await runLaunch(context, { draftId: "release" });
    expect(launched.ok, JSON.stringify(launched)).toBe(true);
    expect((await runCollect(context, { draftId: "release" })).ok).toBe(true);
    const journal = readRunJournalEntries(workspaceDir, "release");
    const captures = journal.filter((entry) => entry.kind === "submission-captured");
    const deliveries = journal.filter((entry) => entry.kind === "delivery");
    expect(captures).toHaveLength(6);
    expect(deliveries, JSON.stringify(journal)).toHaveLength(6);
    const mappingDir = join(workspaceDir, "artifacts", "harbor", "mappings", "by-dispatch");
    expect(await readdir(mappingDir)).toHaveLength(6);

    const accounting = await publicationAccounting(context, { draftId: "release" });
    expect(accounting.ok, JSON.stringify(accounting)).toBe(true);
    if (!accounting.ok) return;
    expect(accounting.result.runtimeChecks.every((check) => check.status === "pass")).toBe(true);
    const accountingRecord = parseBenchmarkAccounting(getSealedBytes(workspaceDir, accounting.result.accountingSha256));
    expect(accountingRecord.publicRegistration.status).toBe("pre-dispatch");
    expect(accountingRecord.cells.flatMap((cell) => cell.dispatches)).toHaveLength(6);

    const report = await publicationReport(context, { draftId: "release" });
    expect(report.ok, JSON.stringify(report)).toBe(true);
    if (!report.ok) return;
    expect(parseSignedReportRecord(getSealedBytes(workspaceDir, report.result.reportRecordSha256)).payloadBytes)
      .toEqual(getSealedBytes(workspaceDir, report.result.reportPayloadSha256));

    const state = readRunState(workspaceDir, "release")!;
    for (const digest of [state.runSha256!, accounting.result.accountingSha256, accounting.result.matrixV2Sha256, report.result.reportRecordSha256]) {
      await exactPublicRecord(source.base, workspaceDir, digest);
    }
    const payloadUrl = publicArchiveUrl(source.base, `/publication-artifacts/sha256/${report.result.reportPayloadSha256}`);
    expect((await fetch(payloadUrl, { method: "HEAD" })).status).toBe(200);
    expect(new Uint8Array(await (await fetch(payloadUrl)).arrayBuffer())).toEqual(getSealedBytes(workspaceDir, report.result.reportPayloadSha256));
    expect(await readdir(mappingDir)).toHaveLength(6);

    const task = await readFile(join(taskMaterialPath, "task.toml"), "utf8");
    expect(task).toContain(`docker_image = "${pinnedImage}"`);
    console.log(JSON.stringify({
      schema: "jinn.network/colophon/publication-release-rehearsal/1",
      harborVersion,
      image: pinnedImage,
      runSha256: state.runSha256,
      accountingSha256: accounting.result.accountingSha256,
      matrixV2Sha256: accounting.result.matrixV2Sha256,
      reportPayloadSha256: report.result.reportPayloadSha256,
      reportRecordSha256: report.result.reportRecordSha256,
      registrationTiming: accountingRecord.publicRegistration.status,
      dispatches: deliveries.length,
      publicationTriggeredHarborRuns: 0,
    }));
  } finally {
    await source?.close();
    if (process.env.COLOPHON_PUBLICATION_RELEASE_KEEP_WORKSPACE === "1") {
      console.warn(`publication release rehearsal retained ${workspaceDir}`);
    } else {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  }
}, 10 * 60_000);
