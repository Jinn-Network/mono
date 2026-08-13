import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BENCHMARK_RECORD_KIND, RUN_RECORD_KIND, parseBenchmark, parseRun, sealRun } from "@jinn-network/benchmarking-records";
import { RECORD_KINDS } from "@jinn-network/record-discovery-protocol";
import type { PublicationRecord } from "@jinn-network/record-publication";
import { TASK_EXECUTION_PROTOCOL_URI, TaskSpecificationSchema } from "@jinn-network/task-execution-protocol";
import { buildSampleBenchmark } from "../intake/sample.js";
import { createWorkspacePublicationHttpHandler, createWorkspacePublicationSource } from "../run/publication-source.js";
import { recordPublicationOrigin, recordWorkspaceAuthorship } from "../run/publication-authority.js";
import { readRunState, writeRunState } from "../run/state.js";
import { getSealedBytes, putSealedBytes } from "../workspace/sealed-store.js";
import { armAdd } from "./arms.js";
import { authorityGrant } from "./authority-ops.js";
import type { OperationContext } from "./context.js";
import { createDraft } from "./drafts.js";
import { initWorkspace } from "./init.js";
import { buildRegistrationClosure, publicationConfigure, publicationRegister, taskDependencies } from "./publication-register.js";
import { runLock } from "./run-lock.js";
import { runQuote } from "./run-quote.js";
import { sampleInit } from "./sample.js";

let workspaceDir: string;
let server: Server | undefined;

beforeEach(() => { workspaceDir = mkdtempSync(join(tmpdir(), "pub12-registration-")); });
afterEach(async () => {
  if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  rmSync(workspaceDir, { recursive: true, force: true });
});

function clock(): () => string {
  let tick = 0;
  return () => `2026-08-13T12:00:${String(tick++).padStart(2, "0")}Z`;
}

function context(now: () => string, principal = "sponsor-1"): OperationContext {
  return { workspaceDir, principal, clock: now };
}

async function lockedSample(now: () => string): Promise<string> {
  expect(initWorkspace(context(now)).ok).toBe(true);
  expect(createDraft(context(now), { draftId: "draft-1", name: "Public sample" }).ok).toBe(true);
  expect((await sampleInit(context(now), { draftId: "draft-1" })).ok).toBe(true);
  expect(armAdd(context(now), { draftId: "draft-1", armId: "a", pinning: { harness: { id: "prediction-v1-baseline", version: "1.0.0" } } }).ok).toBe(true);
  expect(armAdd(context(now), { draftId: "draft-1", armId: "b", pinning: { harness: { id: "sample-uniform", version: "0.1.0" } } }).ok).toBe(true);
  expect((await runQuote(context(now), { draftId: "draft-1" })).ok).toBe(true);
  const locked = runLock(context(now), { draftId: "draft-1" });
  if (!locked.ok) throw new Error(JSON.stringify(locked.error));
  return locked.result.runSha256;
}

async function serveWorkspace(): Promise<string> {
  const handler = createWorkspacePublicationHttpHandler(workspaceDir);
  server = createServer(async (request, response) => {
    const externalPath = request.url ?? "/";
    if (externalPath !== "/publication" && !externalPath.startsWith("/publication/")) { response.writeHead(404).end(); return; }
    const archivePath = externalPath.slice("/publication".length) || "/";
    const result = await handler(new Request(`http://127.0.0.1${archivePath}`, { method: request.method }));
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("loopback server has no TCP address");
  return `http://127.0.0.1:${address.port}/publication`;
}

describe("publication registration authority and exact public chain", () => {
  test("refuses URI-only profile, input, evaluation, and supersedes dependencies", () => {
    const exact = { uri: "https://example.test/material", digest: { sha256: "c".repeat(64) } };
    const base = {
      protocol: TASK_EXECUTION_PROTOCOL_URI,
      profile: exact,
      instructions: "test",
      outputs: [],
    };
    for (const candidate of [
      { ...base, profile: { uri: "https://example.test/profile" } },
      { ...base, inputs: [{ uri: "https://example.test/input" }] },
      { ...base, evaluation: { uri: "https://example.test/evaluation" } },
      { ...base, supersedes: { uri: "https://example.test/task" } },
    ]) {
      const task = TaskSpecificationSchema.parse(candidate);
      expect(() => taskDependencies(task)).toThrow(/URI-only dependencies cannot be registered/);
    }
  });

  test("gates disclosure and announces authored Tasks, Benchmark, then Run with exact retrieval", async () => {
    const now = clock();
    const runSha256 = await lockedSample(now);
    const base = await serveWorkspace();
    expect(authorityGrant(context(now), { principalId: "member", operations: [] }).ok).toBe(true);
    const denied = await publicationConfigure(context(now, "member"), { draftId: "draft-1", publicBaseUrl: base });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("authority-denied");

    expect((await publicationConfigure(context(now), { draftId: "draft-1", publicBaseUrl: base })).ok).toBe(true);
    const registered = await publicationRegister(context(now), { draftId: "draft-1" });
    expect(registered.ok, JSON.stringify(registered)).toBe(true);

    const source = createWorkspacePublicationSource(workspaceDir, "colophon-benchmarks");
    const state = await source.writer.readState();
    const ordered = Object.values(state?.announcements ?? {}).sort((a, b) => a.receipt.sequence.localeCompare(b.receipt.sequence));
    const kinds = ordered.map((entry) => {
      const digest = entry.receipt.record!.digest.slice(7);
      const bytes = getSealedBytes(workspaceDir, digest);
      try { return parseRun(bytes).owner ? RUN_RECORD_KIND : ""; } catch {}
      try { return parseBenchmark(bytes).protocol ? BENCHMARK_RECORD_KIND : ""; } catch {}
      return RECORD_KINDS.task;
    });
    expect(kinds).toEqual([
      RECORD_KINDS.task,
      RECORD_KINDS.task,
      RECORD_KINDS.task,
      BENCHMARK_RECORD_KIND,
      RUN_RECORD_KIND,
    ]);
    expect(ordered.at(-1)?.receipt.record?.digest).toBe(`sha256:${runSha256}`);
  }, 30_000);

  test("refuses authorless source-absent records; durable origins become exact verify-origin records", async () => {
    const now = clock();
    const runSha256 = await lockedSample(now);
    const sourceRun = parseRun(getSealedBytes(workspaceDir, runSha256));
    const raw = await buildSampleBenchmark();
    for (const task of raw.tasks) putSealedBytes(workspaceDir, task.bytes);
    putSealedBytes(workspaceDir, raw.benchmark.bytes);
    const foreignRunBytes = sealRun({
      ...sourceRun,
      benchmark: { digest: { sha256: raw.benchmark.sha256 } },
    }).bytes;
    const foreignRunSha256 = putSealedBytes(workspaceDir, foreignRunBytes);
    recordWorkspaceAuthorship({
      workspaceDir,
      recordSha256: foreignRunSha256,
      recordKind: RUN_RECORD_KIND,
      authoredAt: now(),
    });

    expect(() => buildRegistrationClosure(workspaceDir, foreignRunBytes, foreignRunSha256, now())).toThrow(/no durable validated origin/);

    let sequence = 1;
    for (const task of raw.tasks) {
      recordPublicationOrigin(workspaceDir, `sha256:${task.sha256}`, {
        source: { agent: "did:key:zForeign", name: "origin" },
        sequence: String(sequence++).padStart(16, "0"),
        entryDigest: `sha256:${"a".repeat(64)}`,
      });
    }
    recordPublicationOrigin(workspaceDir, `sha256:${raw.benchmark.sha256}`, {
      source: { agent: "did:key:zForeign", name: "origin" },
      sequence: String(sequence).padStart(16, "0"),
      entryDigest: `sha256:${"b".repeat(64)}`,
    });
    const closure = buildRegistrationClosure(workspaceDir, foreignRunBytes, foreignRunSha256, now());
    const origins = closure.filter((member) =>
      "kind" in member && member.authority.mode === "origin-reference") as PublicationRecord[];
    expect(origins).toHaveLength(raw.tasks.length + 1);
    expect(origins.every((member) => member.actions.includes("verify-origin") && !member.actions.includes("announce"))).toBe(true);

    const state = readRunState(workspaceDir, "draft-1")!;
    writeRunState(workspaceDir, "draft-1", { ...state, runSha256: foreignRunSha256 });
    const base = await serveWorkspace();
    expect((await publicationConfigure(context(now), { draftId: "draft-1", publicBaseUrl: base })).ok).toBe(true);
    const verified: string[] = [];
    const registered = await publicationRegister(context(now), { draftId: "draft-1" }, {
      verifyOrigin: { async verifyOrigin({ record, origin }) {
        expect(origin.source).toEqual({ agent: "did:key:zForeign", name: "origin" });
        expect(record.digest).toBe(`sha256:${putSealedBytes(workspaceDir, record.bytes)}`);
        verified.push(record.digest);
      } },
    });
    expect(registered.ok, JSON.stringify(registered)).toBe(true);
    expect(verified).toHaveLength(raw.tasks.length + 1);
  }, 30_000);
});
