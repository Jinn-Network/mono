import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BENCHMARK_RECORD_KIND, RUN_RECORD_KIND, parseBenchmark, parseRun, sealRun } from "@jinn-network/benchmarking-records";
import { RECORD_KINDS, type SourceHead } from "@jinn-network/record-discovery-protocol";
import type { PublicationRecord } from "@jinn-network/record-publication";
import { TASK_EXECUTION_PROTOCOL_URI, TaskSpecificationSchema } from "@jinn-network/task-execution-protocol";
import { buildSampleBenchmark } from "../intake/sample.js";
import { acquirePublicationLock } from "../run/publication-lock.js";
import {
  createWorkspacePublicationHttpHandler,
  createWorkspacePublicationSource,
  refreshWorkspacePublicationHead,
  withWorkspacePublicationSourceLock,
} from "../run/publication-source.js";
import { recordPublicationOrigin, recordWorkspaceAuthorship } from "../run/publication-authority.js";
import { readRunState, writeRunState } from "../run/state.js";
import { getSealedBytes, putSealedBytes, sha256Hex } from "../workspace/sealed-store.js";
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
  });

  test("recovers the same Run receipt and registration digests after a completed-plan crash before its RunState checkpoint", async () => {
    const now = clock();
    const runSha256 = await lockedSample(now);
    const base = await serveWorkspace();
    expect((await publicationConfigure(context(now), { draftId: "draft-1", publicBaseUrl: base })).ok).toBe(true);

    let crashed = false;
    const first = await publicationRegister(context(now), { draftId: "draft-1" }, {
      afterPlanBeforeCheckpoint: async () => { crashed = true; throw new Error("fixture crash"); },
    });
    expect(first.ok).toBe(false);
    expect(crashed).toBe(true);

    const source = createWorkspacePublicationSource(workspaceDir, "colophon-benchmarks");
    const writerState = (await source.writer.readState())!;
    const receipt = Object.values(writerState.announcements)
      .find((entry) => entry.receipt.record?.digest === `sha256:${runSha256}`)!.receipt;
    const sourceHeadBeforeRetry = writerState.last;
    const partial = readRunState(workspaceDir, "draft-1")!;
    expect(partial.publication!.registration).toMatchObject({ state: "in-progress", announcedAt: expect.any(String) });
    const frozenAt = partial.publication!.registration.announcedAt;
    const expectedDigests = Object.fromEntries(
      buildRegistrationClosure(workspaceDir, getSealedBytes(workspaceDir, runSha256), runSha256, frozenAt!)
        .map((member) => [member.id, member.digest.slice(7)]),
    );

    const retried = await publicationRegister(context(now), { draftId: "draft-1" });
    expect(retried.ok, JSON.stringify(retried)).toBe(true);
    if (!retried.ok) return;
    expect(retried.result.sourceSequence).toBe(receipt.sequence);
    const recovered = readRunState(workspaceDir, "draft-1")!;
    expect(recovered.publication!.registration.receipt).toEqual({
      sourceSequence: receipt.sequence,
      entrySha256: receipt.entryDigest.slice(7),
    });
    expect(recovered.publication!.registration.announcedAt).toBe(frozenAt);
    expect(recovered.publication!.registration.digests).toEqual(expectedDigests);
    expect((await source.writer.readState())!.last).toEqual(sourceHeadBeforeRetry);
  });

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
  });
});

describe("registration's frozen announcement time and the idle-head heartbeat (#5347)", () => {
  const SOURCE_NAME = "colophon-benchmarks";

  /**
   * Another draft's announcement, signed at the fixture's 2026-08-13 clock. It gives the source a
   * head, which by this host's clock is past half its window, so the heartbeat re-signs it at this
   * host's clock, far after any time the fixture clock gives registration.
   */
  async function announceAnotherDraft(): Promise<void> {
    const bytes = new TextEncoder().encode("another draft's record");
    await withWorkspacePublicationSourceLock(workspaceDir, async () => {
      const source = createWorkspacePublicationSource(workspaceDir, SOURCE_NAME);
      await source.writer.recover();
      await source.writer.append({
        timestamp: "2026-08-13T11:00:00.000Z",
        announcement: { announcementId: "another-draft", action: "available", record: { kind: RECORD_KINDS.task, digest: `sha256:${sha256Hex(bytes)}`, mediaType: "text/plain" } },
        record: { bytes, contentType: "text/plain" },
      });
    });
  }

  async function configuredSample(now: () => string): Promise<string> {
    const runSha256 = await lockedSample(now);
    const base = await serveWorkspace();
    expect((await publicationConfigure(context(now), { draftId: "draft-1", publicBaseUrl: base })).ok).toBe(true);
    await announceAnotherDraft();
    return runSha256;
  }

  async function servedHead(): Promise<SourceHead> {
    return (await createWorkspacePublicationSource(workspaceDir, SOURCE_NAME).head.getExact())!;
  }

  /** Registration is complete, its frozen time is after `passed`, and its Run entry follows it. */
  async function expectRegisteredAfter(runSha256: string, passed: SourceHead): Promise<void> {
    const registration = readRunState(workspaceDir, "draft-1")!.publication!.registration;
    expect(registration.state).toBe("complete");
    expect(Date.parse(registration.announcedAt!)).toBeGreaterThan(Date.parse(passed.issuedAt));
    const durable = (await createWorkspacePublicationSource(workspaceDir, SOURCE_NAME).writer.readState())!;
    const run = Object.values(durable.announcements).find((entry) => entry.receipt.record?.digest === `sha256:${runSha256}`);
    expect(run).toBeDefined();
    expect(run!.receipt.sequence > passed.sequence).toBe(true);
  }

  // The heartbeat checks that no stage is `in-progress` and then re-signs, both under the source
  // lock. Registration used to read its time and mark itself `in-progress` outside that lock, so a
  // heartbeat whose check ran before the marker and whose re-sign read the host clock after
  // registration read its time left the frozen time behind the served head, and every retry
  // replayed it. A heartbeat cannot be paused between its two steps from here, so this one takes
  // the same two steps under the same lock, with registration's clock read between them.
  test("finishes when the heartbeat checks before registration is in-progress and re-signs after it read its time", async () => {
    const now = clock();
    const runSha256 = await configuredSample(now);

    let timeRead!: () => void;
    const registrationReadItsTime = new Promise<void>((resolve) => { timeRead = resolve; });
    // `operateAsync` reads the clock once for its audit entry; registration's next read is its time.
    let reads = 0;
    const registrationClock = (): string => {
      const at = now();
      if (++reads === 2) timeRead();
      return at;
    };
    let checked!: (state: string) => void;
    const heartbeatChecked = new Promise<string>((resolve) => { checked = resolve; });
    const heartbeat = withWorkspacePublicationSourceLock(workspaceDir, async () => {
      checked(readRunState(workspaceDir, "draft-1")!.publication!.registration.state);
      await registrationReadItsTime;
      const source = createWorkspacePublicationSource(workspaceDir, SOURCE_NAME);
      const outcome = await source.writer.refreshIdleHead();
      // Read inside the hold: once it is released, registration announces and moves the head.
      return { outcome, head: (await source.head.getExact())! };
    });
    expect(await heartbeatChecked).toBe("not-started");
    // Settling without reading its time must not leave the heartbeat waiting.
    const pending = publicationRegister(context(registrationClock), { draftId: "draft-1" }).finally(timeRead);
    const { outcome, head } = await heartbeat;
    expect(outcome.status).toBe("refreshed");

    const result = await pending;
    expect(result.ok, JSON.stringify(result)).toBe(true);
    await expectRegisteredAfter(runSha256, head);
  });

  // From the start of the command, too: the held draft lock keeps registration from reading its
  // time until the heartbeat has re-signed. The fixture clock trails this host's, as a clock read
  // can trail a head re-signed in the same millisecond or across a clock step.
  test("finishes when the heartbeat re-signs while it waits for the draft lock", async () => {
    const now = clock();
    const runSha256 = await configuredSample(now);
    const draftLock = await acquirePublicationLock(workspaceDir, "draft-1");
    const pending = publicationRegister(context(now), { draftId: "draft-1" });
    let passed: SourceHead;
    try {
      expect((await refreshWorkspacePublicationHead(workspaceDir, SOURCE_NAME)).status).toBe("refreshed");
    } finally {
      // Read before the release: once registration holds the draft lock it announces and moves the head.
      passed = await servedHead();
      draftLock.release();
    }

    const result = await pending;
    expect(result.ok, JSON.stringify(result)).toBe(true);
    await expectRegisteredAfter(runSha256, passed);
  });

  // The other half: a time registration has frozen and not yet announced, here left by an attempt
  // that failed before its first announcement, keeps the heartbeat withheld until a retry has
  // announced at that time.
  test("withholds the heartbeat from a time a failed attempt froze until a retry announces it", async () => {
    const now = clock();
    const runSha256 = await lockedSample(now);
    // Foreign Tasks and Benchmark make origin verification the first thing the plan does.
    const raw = await buildSampleBenchmark();
    for (const task of raw.tasks) putSealedBytes(workspaceDir, task.bytes);
    putSealedBytes(workspaceDir, raw.benchmark.bytes);
    const foreignRunBytes = sealRun({
      ...parseRun(getSealedBytes(workspaceDir, runSha256)),
      benchmark: { digest: { sha256: raw.benchmark.sha256 } },
    }).bytes;
    const foreignRunSha256 = putSealedBytes(workspaceDir, foreignRunBytes);
    recordWorkspaceAuthorship({ workspaceDir, recordSha256: foreignRunSha256, recordKind: RUN_RECORD_KIND, authoredAt: now() });
    let sequence = 1;
    for (const digest of [...raw.tasks.map((task) => task.sha256), raw.benchmark.sha256]) {
      recordPublicationOrigin(workspaceDir, `sha256:${digest}`, {
        source: { agent: "did:key:zForeign", name: "origin" },
        sequence: String(sequence++).padStart(16, "0"),
        entryDigest: `sha256:${"a".repeat(64)}`,
      });
    }
    writeRunState(workspaceDir, "draft-1", { ...readRunState(workspaceDir, "draft-1")!, runSha256: foreignRunSha256 });
    const base = await serveWorkspace();
    expect((await publicationConfigure(context(now), { draftId: "draft-1", publicBaseUrl: base })).ok).toBe(true);
    await announceAnotherDraft();
    const source = createWorkspacePublicationSource(workspaceDir, SOURCE_NAME);
    const before = (await source.writer.readState())!.last;

    const failed = await publicationRegister(context(now), { draftId: "draft-1" }, {
      verifyOrigin: { async verifyOrigin() { throw new Error("fixture: origin unreachable"); } },
    });
    expect(failed.ok).toBe(false);
    const frozen = readRunState(workspaceDir, "draft-1")!.publication!.registration;
    expect(frozen).toMatchObject({ state: "in-progress", announcedAt: expect.any(String) });
    expect((await source.writer.readState())!.last).toEqual(before);
    expect(await refreshWorkspacePublicationHead(workspaceDir, SOURCE_NAME)).toEqual({ status: "withheld", drafts: ["draft-1"] });

    const retried = await publicationRegister(context(now), { draftId: "draft-1" }, {
      verifyOrigin: { async verifyOrigin() { /* reachable now */ } },
    });
    expect(retried.ok, JSON.stringify(retried)).toBe(true);
    expect(readRunState(workspaceDir, "draft-1")!.publication!.registration).toMatchObject({ state: "complete", announcedAt: frozen.announcedAt });
    expect((await refreshWorkspacePublicationHead(workspaceDir, SOURCE_NAME)).status).toBe("refreshed");
  });
});
