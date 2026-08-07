import { cpSync, existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cellIdempotencyKey, parseMatrix, parseReport } from "@jinn-network/benchmarking-records";
import { exportStaticBundle } from "@jinn-network/benchmarking-interop";
import type { AttemptUri, DeliveryRef, ObservationSnapshot, SubmissionAck, SubmissionUri } from "@jinn-network/task-execution-backend";
import { sealDelivery, type ResourceDescriptor } from "@jinn-network/task-execution-protocol";
import { deriveEvaluationTask } from "@jinn-network/task-execution-profiles";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import type { ProxiedBackend } from "../run/drive.js";
import { readRunState, writeRunState } from "../run/state.js";
import { claimPackageArtifactPath, publicBundlesDir } from "../workspace/layout.js";
import { getSealedBytes, sha256Hex } from "../workspace/sealed-store.js";
import { LEGACY_VERDICT_EVALUATOR_ID, createVerdictDsseSigner, loadOrCreateVerdictSigningKey, sealVerdictStatement } from "../venue/signing.js";
import type { LocalVenue } from "../venue/venue.js";
import { armAdd } from "./arms.js";
import { authorityGrant } from "./authority-ops.js";
import type { OperationContext } from "./context.js";
import { createDraft, readDraftDocument } from "./drafts.js";
import { initWorkspace } from "./init.js";
import { readAuditEntries } from "../audit/journal.js";
import { materializePublicBundle } from "../bundle/materialize.js";
import { verifyPublicBundle } from "../bundle/verify.js";
import { buildBundleManifest } from "../bundle/manifest.js";
import { runCli } from "../cli/main.js";
import { runCollect } from "./run-collect.js";
import { runLaunch } from "./run-launch.js";
import { runLock } from "./run-lock.js";
import { runQuote } from "./run-quote.js";
import { runReport } from "./report.js";
import { runPublish } from "./publish.js";
import { runVerify } from "./verify.js";
import { runResults } from "./run-results.js";
import { sampleInit } from "./sample.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp13-report-op-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function makeClock(): () => string {
  let ms = Date.parse("2026-08-05T00:00:00.000Z");
  return () => {
    const value = new Date(ms).toISOString();
    ms += 10;
    return value;
  };
}

function contextFor(clock: () => string, principal = "sponsor-1"): OperationContext {
  return { workspaceDir, principal, clock };
}

function utf8(json: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(json));
}

function rewriteBundleManifest(bundleDir: string): void {
  const prior = JSON.parse(readFileSync(join(bundleDir, "bundle.json"), "utf8")) as { files: Array<{ path: string }> };
  const built = buildBundleManifest(bundleDir, prior.files.map((file) => file.path).filter((path) => existsSync(join(bundleDir, path))));
  writeFileSync(join(bundleDir, "bundle.json"), built.bytes);
}

function rewriteBundleManifestWith(bundleDir: string, ...additionalPaths: string[]): void {
  const prior = JSON.parse(readFileSync(join(bundleDir, "bundle.json"), "utf8")) as { files: Array<{ path: string }> };
  const paths = [...new Set([
    ...prior.files.map((file) => file.path).filter((path) => existsSync(join(bundleDir, path))),
    ...additionalPaths,
  ])].sort();
  writeFileSync(join(bundleDir, "bundle.json"), buildBundleManifest(bundleDir, paths).bytes);
}

function addEvidenceRecord(bundleDir: string, bytes: Uint8Array, role: string): string {
  const digest = sha256Hex(bytes);
  const catalogPath = join(bundleDir, "evidence.json");
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as {
    records: Array<{ sha256: string; roles: string[] }>;
  };
  catalog.records.push({ sha256: digest, roles: [role] });
  catalog.records.sort((left, right) => left.sha256.localeCompare(right.sha256));
  writeCanonical(catalogPath, catalog);
  writeFileSync(join(bundleDir, "records", `${digest}.bin`), bytes);
  return digest;
}

function readAssemblyLines(bundleDir: string): Array<Record<string, any>> {
  return readFileSync(join(bundleDir, "verification", "assembly.jsonl"), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, any>);
}

function writeAssemblyLines(bundleDir: string, lines: Array<Record<string, any>>): void {
  writeFileSync(
    join(bundleDir, "verification", "assembly.jsonl"),
    `${lines.map((line) => Buffer.from(canonicalJsonBytes(line)).toString("utf8")).join("\n")}\n`,
  );
}

function writeCanonical(path: string, value: unknown): void {
  writeFileSync(path, canonicalJsonBytes(value));
}

/** A REPORT-GRADE Result Evaluation Statement -- unlike run-collect.test.ts's own
 * `buildVerdictEnvelope`, this is a full in-toto Statement (subject/taskSubject/resultSubjects)
 * sealed with the workspace's real verdict-signing key via `sealVerdictStatement`, so the sealed
 * store holds authentic product-sealed envelopes that
 * `@jinn-network/benchmarking-aggregate`'s `resolveVerdictOutcome` can genuinely accept. */
async function buildReportGradeVerdictEnvelope(
  workspaceDirForKey: string,
  input: { evaluatorId: string; evaluationSpecificationSha256: string; verdict: "pass" | "fail" },
): Promise<Uint8Array> {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      { name: "subject-task.json", digest: { sha256: "a".repeat(64) } },
      { name: "prediction", digest: { sha256: "b".repeat(64) } },
    ],
    predicateType: "https://spec.jinn.network/attestations/result-evaluation/v1",
    predicate: {
      evaluator: { id: input.evaluatorId },
      verdict: input.verdict,
      evaluationSpecification: { digest: { sha256: input.evaluationSpecificationSha256 } },
      taskSubject: "subject-task.json",
      resultSubjects: ["prediction"],
      measurements: [
        { name: "integrity", value: true },
        { name: "resolved", value: true },
      ],
      evaluatedAt: "2026-01-01T00:00:00Z",
    },
  };
  const key = loadOrCreateVerdictSigningKey(workspaceDirForKey);
  const signer = createVerdictDsseSigner(key);
  return sealVerdictStatement({
    statementBytes: canonicalJsonBytes(statement),
    evaluatorId: input.evaluatorId,
    expectedEvaluationSpecificationSha256: input.evaluationSpecificationSha256,
    signer,
  });
}

function makeStatefulFakeBackend(
  workspaceDirForKey: string,
  evaluationSpecSha256: string,
  options: {
    readonly evaluationModes?: readonly ("success" | "no-delivery" | "no-verdict")[];
  } = {},
): { backend: ProxiedBackend } {
  const byUri = new Map<string, {
    attempt: string;
    submission: string;
    deliveryDigestHex: string;
    evaluationMode: "success" | "no-delivery" | "no-verdict";
  }>();
  const byIdempotencyKey = new Map<string, { bytesHash: string; ack: SubmissionAck }>();
  const bytesByHex = new Map<string, Uint8Array>();
  let counter = 0;
  let evaluationCounter = 0;

  function store(bytes: Uint8Array): string {
    const hex = sha256Hex(bytes);
    bytesByHex.set(hex, bytes);
    return hex;
  }

  const backend: ProxiedBackend = {
    async capabilities() {
      throw new Error("not used");
    },
    async submit(_taskBytes, submissionBytes) {
      const doc = JSON.parse(new TextDecoder().decode(submissionBytes)) as {
        idempotencyKey: string;
        submission: string;
        task: { digest: { sha256: string } };
        requirements?: { harness?: { id?: string } };
      };
      const bytesHash = sha256Hex(submissionBytes);
      const prior = byIdempotencyKey.get(doc.idempotencyKey);
      if (prior !== undefined) return prior.ack;
      counter += 1;
      const attempt = `urn:uuid:00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
      const isEval = doc.requirements?.harness?.id === "evaluation-harness";
      const evaluationMode = isEval
        ? options.evaluationModes?.[evaluationCounter++] ?? "success"
        : "success";
      let artifactHex: string;
      if (isEval) {
        const envelope = await buildReportGradeVerdictEnvelope(workspaceDirForKey, {
          // The legacy evaluator identity is what the workspace's legacy verdict-signing key
          // maps to in the evaluator registry (BP-21) — claiming any other IRI over this key
          // would (correctly) resolve "unresolved" in the signature-verifying trust resolver.
          evaluatorId: LEGACY_VERDICT_EVALUATOR_ID,
          evaluationSpecificationSha256: evaluationSpecSha256,
          verdict: "pass",
        });
        artifactHex = store(envelope);
      } else {
        artifactHex = store(utf8({ probabilityYes: "0.5", submittedAt: "2026-01-01T00:00:00Z" }));
      }
      const outputName = isEval
        ? evaluationMode === "no-verdict" ? "diagnostic" : "verdict"
        : "prediction";
      const deliveryHex = store(sealDelivery({
        protocol: "https://spec.jinn.network/profiles/task-execution/v1",
        attempt,
        task: `sha256:${doc.task.digest.sha256}`,
        outputs: [{ name: outputName, digest: { sha256: artifactHex } }],
        outcome: "fulfilled",
        createdAt: "2026-01-01T00:00:00Z",
      }));
      byUri.set(doc.submission, { attempt, submission: doc.submission, deliveryDigestHex: deliveryHex, evaluationMode });
      byUri.set(attempt, { attempt, submission: doc.submission, deliveryDigestHex: deliveryHex, evaluationMode });
      const ack: SubmissionAck = { accepted: true, submission: doc.submission as SubmissionUri, digest: `sha256:${bytesHash}` };
      byIdempotencyKey.set(doc.idempotencyKey, { bytesHash, ack });
      return ack;
    },
    async observe(ref) {
      const found = byUri.get(ref as string);
      if (found === undefined) throw new Error(`fake: no attempt for ${String(ref)}`);
      const snapshot: ObservationSnapshot = {
        descriptor: {
          attempt: found.attempt as `urn:uuid:${string}`,
          task: `sha256:${"0".repeat(64)}`,
          submission: found.submission as `urn:uuid:${string}`,
          derived: { state: "delivered", terminal: true, contradictory: false, cancelRequested: false, executionIds: [], deliveries: [] },
        },
        cursor: { sequence: "0" },
        observations: [],
      };
      return snapshot;
    },
    async recover() {
      throw new Error("not used");
    },
    async deliveries(attempt) {
      const found = byUri.get(attempt as string);
      return found === undefined || found.evaluationMode === "no-delivery"
        ? []
        : [{ attempt: attempt as AttemptUri, digest: `sha256:${found.deliveryDigestHex}` } as DeliveryRef];
    },
    async fetchDelivery(ref) {
      const bytes = bytesByHex.get(ref.digest.slice("sha256:".length));
      if (bytes === undefined) throw new Error("fake: unknown delivery digest");
      return bytes;
    },
    async fetchArtifact(descriptor: ResourceDescriptor) {
      const sha256 = descriptor.digest?.["sha256"];
      const bytes = sha256 === undefined ? undefined : bytesByHex.get(sha256);
      if (bytes === undefined) throw new Error("fake: unknown artifact digest");
      return bytes;
    },
    async drain() {},
  };
  return { backend };
}

function fakeVenue(backend: ProxiedBackend, options: { readonly failPrepareCalls?: readonly number[] } = {}): LocalVenue {
  let prepareCall = 0;
  return {
    backend: backend as unknown as LocalVenue["backend"],
    verdictKeyId: "fake-venue-verdict-key",
    // The scheduler identity must be the same identity carried by the verdict this fake signs;
    // production local venues mint a matching signer per scheduled evaluator.
    evaluators: [{ id: LEGACY_VERDICT_EVALUATOR_ID, keyId: "fake-venue-verdict-key" }],
    prepareEvaluationCell: (input) => {
      prepareCall += 1;
      if (options.failPrepareCalls?.includes(prepareCall) === true) throw new Error(`fixture prepare failure ${prepareCall}`);
      const derived = deriveEvaluationTask({
        subjectTask: { name: "subject-task.json", digest: `sha256:${sha256Hex(input.subjectTaskBytes)}` },
        subjectDelivery: { name: "subject-delivery.json", digest: `sha256:${sha256Hex(input.subjectDeliveryBytes)}` },
        subjectResults: input.resultArtifacts.map((artifact) => ({ name: artifact.name, digest: `sha256:${sha256Hex(artifact.bytes)}` })),
        evaluationSpecDigest: `sha256:${sha256Hex(input.evaluationSpecBytes)}`,
      });
      return { taskBytes: derived.bytes, taskSha256: derived.digest.slice("sha256:".length) };
    },
    async shutdown() {},
  };
}

async function setUpClosedRun(
  clock: () => string,
  draftId = "draft-1",
  options: {
    readonly evaluationModes?: readonly ("success" | "no-delivery" | "no-verdict")[];
    readonly failPrepareCalls?: readonly number[];
  } = {},
): Promise<void> {
  initWorkspace(contextFor(clock));
  createDraft(contextFor(clock), { draftId, name: "Report Test" });
  const sample = await sampleInit(contextFor(clock), { draftId });
  expect(sample.ok).toBe(true);
  if (!sample.ok) throw new Error("unreachable");
  armAdd(contextFor(clock), { draftId, armId: "baseline", pinning: { harness: { id: "prediction-v1-baseline", version: "1.0.0" } } });
  armAdd(contextFor(clock), { draftId, armId: "sample", pinning: { harness: { id: "sample-uniform", version: "0.1.0" } } });
  const quoted = await runQuote(contextFor(clock), { draftId });
  expect(quoted.ok).toBe(true);
  const locked = runLock(contextFor(clock), { draftId });
  expect(locked.ok).toBe(true);

  const { backend } = makeStatefulFakeBackend(workspaceDir, sample.result.evaluationSpecSha256, options);
  const launched = await runLaunch(contextFor(clock), { draftId }, {
    createVenue: () => fakeVenue(backend, options),
  });
  expect(launched.ok).toBe(true);

  const collected = await runCollect(contextFor(clock), { draftId });
  expect(collected.ok).toBe(true);
  if (!collected.ok) throw new Error("unreachable");
  expect(readDraftDocument(workspaceDir, draftId).state).toBe("closed");
}

describe("runReport — happy path", () => {
  test(
    "seals a DSSE Report, derives preregistered=true, writes RunState + claim package, transitions to reported",
    async () => {
      const clock = makeClock();
      await setUpClosedRun(clock);

      const outcome = await runReport(contextFor(clock), { draftId: "draft-1" });
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
      if (!outcome.ok) return;

      expect(outcome.result.draft.state).toBe("reported");
      expect(outcome.result.preregistered).toBe(true);
      expect(outcome.result.reportSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(outcome.result.reportEnvelopeSha256).toMatch(/^[a-f0-9]{64}$/);

      // The sealed Report is genuinely readable back from the workspace's own sealed-bytes store.
      const reportBytes = getSealedBytes(workspaceDir, outcome.result.reportSha256);
      const reportRecord = parseReport(reportBytes);
      expect(reportRecord.preregistered).toBe(true);
      expect(reportRecord.disclosures.perSubject).toHaveLength(1);
      expect(reportRecord.limitations).toBeDefined();
      expect((reportRecord.limitations ?? []).length).toBeGreaterThan(0);

      // RunState carries the new report fields.
      const runState = readRunState(workspaceDir, "draft-1");
      expect(runState?.reportSha256).toBe(outcome.result.reportSha256);
      expect(runState?.reportEnvelopeSha256).toBe(outcome.result.reportEnvelopeSha256);
      expect(runState?.reportedAt).toBeDefined();

      // The claim package artifact exists and matches the operation's own return value.
      expect(existsSync(claimPackageArtifactPath(workspaceDir, "draft-1"))).toBe(true);
      expect(outcome.result.claimPackage.records.reportSha256).toBe(outcome.result.reportSha256);
      expect(outcome.result.claimPackage.scope.draftId).toBe("draft-1");

      // BP-21: the claim states the assurance preset AND the primitives the sealed Run carries,
      // plus the fixed agent-distinctness disclosure — never the preset label alone.
      expect(outcome.result.claimPackage.assurance.preset).toBe("direct-check");
      expect(outcome.result.claimPackage.assurance.resolved).toEqual({
        independence: "disclosed",
        minVerdicts: 1,
        distinctEvaluator: false,
        verdictRule: "sole",
      });
      expect(outcome.result.claimPackage.assurance.disclosure).toContain("agent-distinctness");
      expect(outcome.result.claimPackage.assurance.disclosure).toContain("party-independence");
    },
    30_000,
  );
});

describe("portable public bundle", () => {
  test("publishes only from reported, writes bundle identity before transitioning, and is idempotently readable", async () => {
    const clock = makeClock();
    await setUpClosedRun(clock);
    const tooEarly = await runPublish(contextFor(clock), { draftId: "draft-1" });
    expect(tooEarly.ok).toBe(false);
    if (!tooEarly.ok) expect(tooEarly.error.code).toBe("illegal-transition");
    const reported = await runReport(contextFor(clock), { draftId: "draft-1" });
    expect(reported.ok, JSON.stringify(reported)).toBe(true);
    const [published, concurrent] = await Promise.all([
      runPublish(contextFor(clock), { draftId: "draft-1" }),
      runPublish(contextFor(clock), { draftId: "draft-1" }),
    ]);
    expect(published.ok, JSON.stringify(published)).toBe(true);
    expect(concurrent.ok, JSON.stringify(concurrent)).toBe(true);
    if (!published.ok) return;
    if (concurrent.ok) expect(concurrent.result.bundleIdentity).toBe(published.result.bundleIdentity);
    expect(published.result.draft.state).toBe("published-bundle");
    expect(published.result.bundleIdentity).toMatch(/^[a-f0-9]{64}$/);
    expect(readRunState(workspaceDir, "draft-1")).toMatchObject({
      bundleIdentity: published.result.bundleIdentity,
      bundleRelativePath: `artifacts/draft-1/public-bundles/${published.result.bundleIdentity}`,
    });
    expect(runResults(contextFor(clock), { draftId: "draft-1" })).toMatchObject({
      ok: true,
      result: {
        publication: {
          identity: published.result.bundleIdentity,
          relativePath: `artifacts/draft-1/public-bundles/${published.result.bundleIdentity}`,
        },
      },
    });
    const replay = await runPublish(contextFor(clock), { draftId: "draft-1" });
    expect(replay.ok, JSON.stringify(replay)).toBe(true);
    if (replay.ok) expect(replay.result.bundleIdentity).toBe(published.result.bundleIdentity);
  }, 30_000);

  test("a fault after rename or after RunState leaves a reported draft with a retryable immutable bundle", async () => {
    const clock = makeClock();
    await setUpClosedRun(clock);
    expect((await runReport(contextFor(clock), { draftId: "draft-1" })).ok).toBe(true);
    const afterRename = await runPublish(contextFor(clock), { draftId: "draft-1" }, {
      afterRename: () => { throw new Error("fault after rename"); },
    });
    expect(afterRename.ok).toBe(false);
    expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("reported");
    const beforeTransition = await runPublish(contextFor(clock), { draftId: "draft-1" }, {
      beforeTransition: () => { throw new Error("fault before transition"); },
    });
    expect(beforeTransition.ok).toBe(false);
    expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("reported");
    expect(readRunState(workspaceDir, "draft-1")?.bundleIdentity).toMatch(/^[a-f0-9]{64}$/);
    const retry = await runPublish(contextFor(clock), { draftId: "draft-1" });
    expect(retry.ok, JSON.stringify(retry)).toBe(true);
    expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("published-bundle");
  }, 30_000);

  test("a fault before rename leaves no final bundle and no state advancement", async () => {
    const clock = makeClock();
    await setUpClosedRun(clock);
    expect((await runReport(contextFor(clock), { draftId: "draft-1" })).ok).toBe(true);
    const failed = await runPublish(contextFor(clock), { draftId: "draft-1" }, {
      beforeRename: () => { throw new Error("fault before rename"); },
    });
    expect(failed.ok).toBe(false);
    expect(existsSync(publicBundlesDir(workspaceDir, "draft-1"))
      ? readdirSync(publicBundlesDir(workspaceDir, "draft-1")).filter((name) => /^[a-f0-9]{64}$/u.test(name))
      : []).toHaveLength(0);
    expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("reported");
    expect(readRunState(workspaceDir, "draft-1")?.bundleIdentity).toBeUndefined();
  }, 30_000);

  test("workspace tampering refuses before staging and leaves the reported draft unchanged", async () => {
    const clock = makeClock();
    await setUpClosedRun(clock);
    expect((await runReport(contextFor(clock), { draftId: "draft-1" })).ok).toBe(true);
    const path = claimPackageArtifactPath(workspaceDir, "draft-1");
    const claim = JSON.parse(readFileSync(path, "utf8")) as { results: unknown };
    claim.results = { tamperedBeforePublish: true };
    writeCanonical(path, claim);
    const refused = await runPublish(contextFor(clock), { draftId: "draft-1" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.issues?.[0]?.path).toBe("claim-consistency");
    expect(existsSync(publicBundlesDir(workspaceDir, "draft-1"))
      ? readdirSync(publicBundlesDir(workspaceDir, "draft-1")).filter((name) => /^[a-f0-9]{64}$/u.test(name))
      : []).toHaveLength(0);
    expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("reported");
  }, 30_000);

  test("verifies from bundle-carried records and public keys after the source workspace is deleted", async () => {
    const clock = makeClock();
    await setUpClosedRun(clock);
    const reported = await runReport(contextFor(clock), { draftId: "draft-1" });
    expect(reported.ok, JSON.stringify(reported)).toBe(true);
    if (!reported.ok) return;
    const runState = readRunState(workspaceDir, "draft-1");
    expect(runState).toBeDefined();
    if (runState === undefined) return;
    const materialized = materializePublicBundle({
      workspaceDir,
      draftId: "draft-1",
      benchmarkSha256: reported.result.claimPackage.records.benchmarkSha256,
      runState,
    });
    const copied = mkdtempSync(join(tmpdir(), "bp40-copied-bundle-"));
    try {
      cpSync(materialized.bundleDir, copied, { recursive: true });
      rmSync(workspaceDir, { recursive: true, force: true });
      const verified = await verifyPublicBundle(copied);
      expect(verified.identity).toBe(materialized.identity);
      expect(verified.checks).toEqual([
        "manifest",
        "evidence-closure",
        "trust",
        "matrix-rederivation",
        "report-verification",
        "claim-consistency",
      ]);
      const cli = await runCli(["bundle", "verify", "--bundle", copied, "--json"], {
        cwd: copied,
        clock,
      });
      expect(cli.exitCode).toBe(0);
      expect(JSON.parse(cli.stdout)).toMatchObject({ ok: true, result: { identity: materialized.identity } });
    } finally {
      rmSync(copied, { recursive: true, force: true });
    }
  }, 30_000);

  test("materializes and portably verifies every real could-not-grade lineage shape", async () => {
    const clock = makeClock();
    await setUpClosedRun(clock, "draft-1", {
      failPrepareCalls: [1],
      evaluationModes: ["no-delivery", "no-verdict", "success", "success", "success"],
    });
    const reported = await runReport(contextFor(clock), { draftId: "draft-1" });
    expect(reported.ok, JSON.stringify(reported)).toBe(true);
    if (!reported.ok) return;
    const state = readRunState(workspaceDir, "draft-1");
    if (state === undefined) throw new Error("missing run state");
    const base = materializePublicBundle({
      workspaceDir,
      draftId: "draft-1",
      benchmarkSha256: reported.result.claimPackage.records.benchmarkSha256,
      runState: state,
    }).bundleDir;
    const lines = readAssemblyLines(base);
    const header = lines[0]! as {
      graph: { evaluations: Array<Record<string, unknown>> };
    };
    const terminals = header.graph.evaluations.filter((edge) => edge["evaluationTerminal"] === "could-not-grade");
    const preLeg = terminals.find((edge) => edge["evalTaskSha256"] === undefined);
    const submitted = terminals.find((edge) => edge["evalSubmissionSha256"] !== undefined && edge["evalDeliverySha256"] === undefined);
    const delivered = terminals.find((edge) => edge["evalDeliverySha256"] !== undefined);
    expect(preLeg).toEqual(expect.objectContaining({
      evalIndex: 1,
      evaluationTerminal: "could-not-grade",
    }));
    expect(preLeg).not.toHaveProperty("evaluator");
    expect(preLeg).not.toHaveProperty("evalAttempt");
    expect(submitted).toEqual(expect.objectContaining({
      evalIndex: 1,
      evaluator: LEGACY_VERDICT_EVALUATOR_ID,
      evaluationTerminal: "could-not-grade",
      evalTaskSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      evalSubmissionSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      evalAttempt: expect.stringMatching(/^urn:uuid:/),
    }));
    expect(delivered).toEqual(expect.objectContaining({
      evalIndex: 1,
      evaluator: LEGACY_VERDICT_EVALUATOR_ID,
      evaluationTerminal: "could-not-grade",
      evalTaskSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      evalSubmissionSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      evalAttempt: expect.stringMatching(/^urn:uuid:/),
      evalDeliverySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(await verifyPublicBundle(base)).toMatchObject({
      checks: expect.arrayContaining(["evidence-closure", "matrix-rederivation", "report-verification"]),
    });

    const vectors: Array<{ name: string; mutate(edge: Record<string, unknown>): void }> = [
      { name: "pre-leg evaluator", mutate(edge) { edge["evaluator"] = LEGACY_VERDICT_EVALUATOR_ID; } },
      { name: "terminal", mutate(edge) { delete edge["evaluationTerminal"]; } },
      { name: "cell", mutate(edge) { edge["cellKey"] = "unknown-cell"; } },
      { name: "index", mutate(edge) { edge["evalIndex"] = 2; } },
      { name: "evaluator", mutate(edge) { edge["evaluator"] = "urn:jinn:evaluator:unrelated"; } },
      { name: "Task", mutate(edge) { edge["evalTaskSha256"] = "0".repeat(64); } },
      { name: "Submission", mutate(edge) { edge["evalSubmissionSha256"] = "0".repeat(64); } },
      { name: "attempt", mutate(edge) { edge["evalAttempt"] = "urn:uuid:ffffffff-ffff-4fff-8fff-ffffffffffff"; } },
      { name: "Delivery", mutate(edge) { edge["evalDeliverySha256"] = "0".repeat(64); } },
    ];
    for (const vector of vectors) {
      const copy = mkdtempSync(join(tmpdir(), `bp40-could-not-grade-${vector.name.toLowerCase()}-`));
      try {
        cpSync(base, copy, { recursive: true });
        const copyLines = readAssemblyLines(copy);
        const copyTerminals = (copyLines[0]! as { graph: { evaluations: Array<Record<string, unknown>> } })
          .graph.evaluations.filter((edge) => edge["evaluationTerminal"] === "could-not-grade");
        const target = vector.name === "pre-leg evaluator" || vector.name === "terminal"
          || vector.name === "cell" || vector.name === "index"
          ? copyTerminals.find((edge) => edge["evalTaskSha256"] === undefined)
          : vector.name === "Delivery" || vector.name === "attempt"
            ? copyTerminals.find((edge) => edge["evalDeliverySha256"] !== undefined)
            : copyTerminals.find((edge) => edge["evalSubmissionSha256"] !== undefined && edge["evalDeliverySha256"] === undefined);
        expect(target, vector.name).toBeDefined();
        if (target === undefined) continue;
        vector.mutate(target);
        writeAssemblyLines(copy, copyLines);
        rewriteBundleManifest(copy);
        await expect(verifyPublicBundle(copy), vector.name).rejects.toMatchObject({
          issues: [expect.objectContaining({ path: "evidence-closure" })],
        });
      } finally {
        rmSync(copy, { recursive: true, force: true });
      }
    }
  }, 60_000);

  test("semantic tampering names the failed Matrix, Report, claim, assembly, trust, or evidence check", async () => {
    const clock = makeClock();
    await setUpClosedRun(clock);
    const reported = await runReport(contextFor(clock), { draftId: "draft-1" });
    expect(reported.ok, JSON.stringify(reported)).toBe(true);
    if (!reported.ok) return;
    const state = readRunState(workspaceDir, "draft-1");
    if (state === undefined) throw new Error("missing run state");
    const base = materializePublicBundle({
      workspaceDir,
      draftId: "draft-1",
      benchmarkSha256: reported.result.claimPackage.records.benchmarkSha256,
      runState: state,
    }).bundleDir;

    // A corrupt occupant at the exact digest address is never overwritten during convergence.
    const occupiedIndexPath = join(base, "index.html");
    const originalIndex = readFileSync(occupiedIndexPath);
    writeFileSync(occupiedIndexPath, "occupied-by-different-bytes");
    expect(() => materializePublicBundle({
      workspaceDir,
      draftId: "draft-1",
      benchmarkSha256: reported.result.claimPackage.records.benchmarkSha256,
      runState: state,
    })).toThrow();
    expect(readFileSync(occupiedIndexPath, "utf8")).toBe("occupied-by-different-bytes");
    writeFileSync(occupiedIndexPath, originalIndex);

    // A changed closure receives a different digest-addressed target and cannot overwrite the
    // prior immutable target, even when every changed file is otherwise schema-valid.
    const sourceClaimPath = claimPackageArtifactPath(workspaceDir, "draft-1");
    const sourceClaim = JSON.parse(readFileSync(sourceClaimPath, "utf8")) as { results: unknown };
    sourceClaim.results = { differentButSchemaValid: true };
    writeCanonical(sourceClaimPath, sourceClaim);
    const different = materializePublicBundle({
      workspaceDir,
      draftId: "draft-1",
      benchmarkSha256: reported.result.claimPackage.records.benchmarkSha256,
      runState: state,
    });
    expect(different.bundleDir).not.toBe(base);
    expect((await verifyPublicBundle(base)).checks).toContain("claim-consistency");

    const vectors: Array<{ name: string; expectedPath: string; mutate(dir: string): void }> = [
      {
        name: "Matrix",
        expectedPath: "matrix-rederivation",
        mutate(dir) {
          const matrixPath = join(dir, "matrix.json");
          const matrix = JSON.parse(readFileSync(matrixPath, "utf8")) as { closeBoundary: { at: string } };
          matrix.closeBoundary.at = "2027-01-01T00:00:00.000Z";
          writeCanonical(matrixPath, matrix);
          const claimPath = join(dir, "claim-package.json");
          const claim = JSON.parse(readFileSync(claimPath, "utf8")) as { records: { matrixSha256: string } };
          claim.records.matrixSha256 = sha256Hex(readFileSync(matrixPath));
          writeCanonical(claimPath, claim);
          writeCanonical(join(dir, "static-bundle.json"), exportStaticBundle(parseMatrix(readFileSync(matrixPath)), [parseReport(readFileSync(join(dir, "report.json")))]));
        },
      },
      {
        name: "Report",
        expectedPath: "report-verification",
        mutate(dir) {
          const reportPath = join(dir, "report.json");
          const report = JSON.parse(readFileSync(reportPath, "utf8")) as { limitations?: string[] };
          report.limitations = [...(report.limitations ?? []), "tampered"];
          writeCanonical(reportPath, report);
          const claimPath = join(dir, "claim-package.json");
          const claim = JSON.parse(readFileSync(claimPath, "utf8")) as { records: { reportSha256: string } };
          claim.records.reportSha256 = sha256Hex(readFileSync(reportPath));
          writeCanonical(claimPath, claim);
          writeCanonical(join(dir, "static-bundle.json"), exportStaticBundle(parseMatrix(readFileSync(join(dir, "matrix.json"))), [parseReport(readFileSync(reportPath))]));
        },
      },
      {
        name: "Report envelope",
        expectedPath: "report-verification",
        mutate(dir) {
          const path = join(dir, "report-envelope.json");
          const envelope = JSON.parse(readFileSync(path, "utf8")) as { signatures: Array<{ sig: string }> };
          envelope.signatures[0]!.sig = `${envelope.signatures[0]!.sig.slice(0, -2)}AA`;
          writeCanonical(path, envelope);
          const claimPath = join(dir, "claim-package.json");
          const claim = JSON.parse(readFileSync(claimPath, "utf8")) as { records: { reportEnvelopeSha256: string } };
          claim.records.reportEnvelopeSha256 = sha256Hex(readFileSync(path));
          writeCanonical(claimPath, claim);
        },
      },
      {
        name: "claim",
        expectedPath: "claim-consistency",
        mutate(dir) {
          const path = join(dir, "claim-package.json");
          const claim = JSON.parse(readFileSync(path, "utf8")) as { results: unknown };
          claim.results = { tampered: true };
          writeCanonical(path, claim);
        },
      },
      {
        name: "assembly journal",
        expectedPath: "evidence-closure",
        mutate(dir) {
          const path = join(dir, "verification", "assembly.jsonl");
          const text = readFileSync(path, "utf8");
          writeFileSync(path, text.replace('"dispatches":1', '"dispatches":2'));
        },
      },
      {
        name: "Report key",
        expectedPath: "trust",
        mutate(dir) {
          const path = join(dir, "trust", "public-keys.json");
          const trust = JSON.parse(readFileSync(path, "utf8")) as { report: { spkiDerBase64: string } };
          trust.report.spkiDerBase64 = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
          writeCanonical(path, trust);
        },
      },
      {
        name: "evaluator key",
        expectedPath: "trust",
        mutate(dir) {
          const path = join(dir, "trust", "public-keys.json");
          const trust = JSON.parse(readFileSync(path, "utf8")) as { evaluators: Array<{ spkiDerBase64: string }> };
          trust.evaluators[0]!.spkiDerBase64 = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
          writeCanonical(path, trust);
        },
      },
      {
        name: "evidence record",
        expectedPath: "records/",
        mutate(dir) {
          const catalog = JSON.parse(readFileSync(join(dir, "evidence.json"), "utf8")) as { records: Array<{ sha256: string }> };
          const path = join(dir, "records", `${catalog.records[0]!.sha256}.bin`);
          const bytes = readFileSync(path);
          bytes[0] = (bytes[0] ?? 0) ^ 1;
          writeFileSync(path, bytes);
        },
      },
    ];

    for (const vector of vectors) {
      const copy = mkdtempSync(join(tmpdir(), `bp40-tamper-${vector.name.replaceAll(" ", "-")}-`));
      try {
        cpSync(base, copy, { recursive: true });
        vector.mutate(copy);
        rewriteBundleManifest(copy);
        let path = "";
        try { await verifyPublicBundle(copy); } catch (cause) {
          path = (cause as { issues?: Array<{ path: string }> }).issues?.[0]?.path ?? "";
        }
        expect(path, vector.name).toContain(vector.expectedPath);
      } finally {
        rmSync(copy, { recursive: true, force: true });
      }
    }
  }, 30_000);

  test("rejects missing and unreachable evidence records and unrelated evaluation graph substitutions", async () => {
    const clock = makeClock();
    await setUpClosedRun(clock);
    const reported = await runReport(contextFor(clock), { draftId: "draft-1" });
    expect(reported.ok, JSON.stringify(reported)).toBe(true);
    if (!reported.ok) return;
    const state = readRunState(workspaceDir, "draft-1");
    if (state === undefined) throw new Error("missing run state");
    const base = materializePublicBundle({
      workspaceDir,
      draftId: "draft-1",
      benchmarkSha256: reported.result.claimPackage.records.benchmarkSha256,
      runState: state,
    }).bundleDir;

    for (const role of ["admission-receipt", "evaluation-submission", "solve-output"] as const) {
      const copy = mkdtempSync(join(tmpdir(), `bp40-missing-${role}-`));
      try {
        cpSync(base, copy, { recursive: true });
        const catalogPath = join(copy, "evidence.json");
        const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as {
          records: Array<{ sha256: string; roles: string[] }>;
        };
        const record = catalog.records.find((candidate) => candidate.roles.includes(role));
        expect(record, role).toBeDefined();
        if (record === undefined) continue;
        catalog.records = catalog.records.filter((candidate) => candidate.sha256 !== record.sha256);
        rmSync(join(copy, "records", `${record.sha256}.bin`));
        writeCanonical(catalogPath, catalog);
        rewriteBundleManifest(copy);
        await expect(verifyPublicBundle(copy), role).rejects.toMatchObject({
          issues: [expect.objectContaining({ path: "evidence-closure" })],
        });
      } finally {
        rmSync(copy, { recursive: true, force: true });
      }
    }

    const unreachable = mkdtempSync(join(tmpdir(), "bp40-unreachable-record-"));
    try {
      cpSync(base, unreachable, { recursive: true });
      const bytes = utf8({ schemaValidButUnreachable: true });
      const digest = sha256Hex(bytes);
      const catalogPath = join(unreachable, "evidence.json");
      const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as {
        records: Array<{ sha256: string; roles: string[] }>;
      };
      catalog.records.push({ sha256: digest, roles: ["solve-output"] });
      catalog.records.sort((left, right) => left.sha256.localeCompare(right.sha256));
      writeCanonical(catalogPath, catalog);
      writeFileSync(join(unreachable, "records", `${digest}.bin`), bytes);
      const prior = JSON.parse(readFileSync(join(unreachable, "bundle.json"), "utf8")) as { files: Array<{ path: string }> };
      const paths = [...prior.files.map((file) => file.path), `records/${digest}.bin`].sort();
      const built = buildBundleManifest(unreachable, paths);
      writeFileSync(join(unreachable, "bundle.json"), built.bytes);
      await expect(verifyPublicBundle(unreachable)).rejects.toMatchObject({
        issues: [expect.objectContaining({ path: "evidence-closure" })],
      });
    } finally {
      rmSync(unreachable, { recursive: true, force: true });
    }

    const substituted = mkdtempSync(join(tmpdir(), "bp40-unrelated-evaluation-"));
    try {
      cpSync(base, substituted, { recursive: true });
      const taskBytes = utf8({ unrelatedEvaluationTask: true });
      const deliveryBytes = utf8({ unrelatedEvaluationDelivery: true });
      const taskDigest = sha256Hex(taskBytes);
      const deliveryDigest = sha256Hex(deliveryBytes);
      const assemblyPath = join(substituted, "verification", "assembly.jsonl");
      const lines = readFileSync(assemblyPath, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      const cell = lines.find((line) => line["kind"] === "cell") as { verdicts: Array<Record<string, unknown>> };
      cell.verdicts[0]!["evalTaskSha256"] = taskDigest;
      cell.verdicts[0]!["evalDeliverySha256"] = deliveryDigest;
      writeFileSync(assemblyPath, `${lines.map((line) => Buffer.from(canonicalJsonBytes(line)).toString("utf8")).join("\n")}\n`);
      const catalogPath = join(substituted, "evidence.json");
      const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as {
        records: Array<{ sha256: string; roles: string[] }>;
      };
      catalog.records.push(
        { sha256: taskDigest, roles: ["evaluation-task"] },
        { sha256: deliveryDigest, roles: ["evaluation-delivery"] },
      );
      catalog.records.sort((left, right) => left.sha256.localeCompare(right.sha256));
      writeCanonical(catalogPath, catalog);
      writeFileSync(join(substituted, "records", `${taskDigest}.bin`), taskBytes);
      writeFileSync(join(substituted, "records", `${deliveryDigest}.bin`), deliveryBytes);
      const prior = JSON.parse(readFileSync(join(substituted, "bundle.json"), "utf8")) as { files: Array<{ path: string }> };
      const paths = [
        ...prior.files.map((file) => file.path),
        `records/${taskDigest}.bin`,
        `records/${deliveryDigest}.bin`,
      ].sort();
      writeFileSync(join(substituted, "bundle.json"), buildBundleManifest(substituted, paths).bytes);
      await expect(verifyPublicBundle(substituted)).rejects.toMatchObject({
        issues: [expect.objectContaining({ path: "evidence-closure" })],
      });
    } finally {
      rmSync(substituted, { recursive: true, force: true });
    }
  }, 30_000);

  test("rejects out-of-domain and duplicate solve Submission coordinates and unconsumed evaluation Submissions", async () => {
    const clock = makeClock();
    await setUpClosedRun(clock);
    const reported = await runReport(contextFor(clock), { draftId: "draft-1" });
    expect(reported.ok, JSON.stringify(reported)).toBe(true);
    if (!reported.ok) return;
    const state = readRunState(workspaceDir, "draft-1");
    if (state === undefined) throw new Error("missing run state");
    const base = materializePublicBundle({
      workspaceDir,
      draftId: "draft-1",
      benchmarkSha256: reported.result.claimPackage.records.benchmarkSha256,
      runState: state,
    }).bundleDir;

    for (const mode of ["out-of-domain-solve", "duplicate-solve-coordinate", "unconsumed-evaluation"] as const) {
      const copy = mkdtempSync(join(tmpdir(), `bp40-graph-${mode}-`));
      try {
        cpSync(base, copy, { recursive: true });
        const lines = readAssemblyLines(copy);
        const header = lines[0]! as {
          graph: {
            solveSubmissions: Array<{ cellKey: string; dispatch: number; sha256: string }>;
            evaluationSubmissions: Array<{
              cellKey: string; dispatch: number; evalIndex: number; evaluator: string; evalTaskSha256: string; sha256: string;
            }>;
          };
        };
        const cells = new Map(lines.slice(1).map((line) => [String(line["cellKey"]), line]));
        let digest: string;
        if (mode === "unconsumed-evaluation") {
          const source = header.graph.evaluationSubmissions[0]!;
          const record = JSON.parse(readFileSync(join(copy, "records", `${source.sha256}.bin`), "utf8")) as Record<string, any>;
          const dispatch = source.dispatch + 1;
          const nonce = String(record["nonce"]).replace(/:\d+$/u, `:${dispatch}`);
          record["nonce"] = nonce;
          record["idempotencyKey"] = nonce;
          record["requirements"] = { ...(record["requirements"] as object), "bp40-review": "unconsumed" };
          digest = addEvidenceRecord(copy, canonicalJsonBytes(record), "evaluation-submission");
          header.graph.evaluationSubmissions.push({ ...source, dispatch, sha256: digest });
        } else {
          const source = header.graph.solveSubmissions[0]!;
          const record = JSON.parse(readFileSync(join(copy, "records", `${source.sha256}.bin`), "utf8")) as Record<string, any>;
          const dispatch = mode === "duplicate-solve-coordinate"
            ? source.dispatch
            : Number(cells.get(source.cellKey)?.["dispatches"] ?? source.dispatch) + 1;
          const nonce = `${source.cellKey}:${dispatch}`;
          record["nonce"] = nonce;
          record["idempotencyKey"] = cellIdempotencyKey(
            `sha256:${sha256Hex(readFileSync(join(copy, "run.json")))}`,
            source.cellKey,
            dispatch,
          );
          record["requirements"] = { ...(record["requirements"] as object), "bp40-review": mode };
          digest = addEvidenceRecord(copy, canonicalJsonBytes(record), "solve-submission");
          header.graph.solveSubmissions.push({ ...source, dispatch, sha256: digest });
        }
        writeAssemblyLines(copy, lines);
        rewriteBundleManifestWith(copy, `records/${digest}.bin`);
        let accepted = true;
        try { await verifyPublicBundle(copy); } catch { accepted = false; }
        expect.soft(accepted, mode).toBe(false);
      } finally {
        rmSync(copy, { recursive: true, force: true });
      }
    }
  }, 30_000);

  test("rejects unknown raw claim fields and unknown or non-canonical cancellation markers", async () => {
    const clock = makeClock();
    await setUpClosedRun(clock);
    const reported = await runReport(contextFor(clock), { draftId: "draft-1" });
    expect(reported.ok, JSON.stringify(reported)).toBe(true);
    if (!reported.ok) return;
    const state = readRunState(workspaceDir, "draft-1");
    if (state === undefined) throw new Error("missing run state");
    const base = materializePublicBundle({
      workspaceDir,
      draftId: "draft-1",
      benchmarkSha256: reported.result.claimPackage.records.benchmarkSha256,
      runState: state,
    }).bundleDir;

    for (const mode of ["top-level", "nested"] as const) {
      const copy = mkdtempSync(join(tmpdir(), `bp40-raw-claim-${mode}-`));
      try {
        cpSync(base, copy, { recursive: true });
        const claimPath = join(copy, "claim-package.json");
        const claim = JSON.parse(readFileSync(claimPath, "utf8")) as Record<string, any>;
        if (mode === "top-level") claim["fabricatedWinner"] = "arm-a";
        else claim["scope"]["fabricatedWinner"] = "arm-a";
        writeCanonical(claimPath, claim);
        rewriteBundleManifest(copy);
        let path = "";
        try { await verifyPublicBundle(copy); } catch (cause) {
          path = (cause as { issues?: Array<{ path: string }> }).issues?.[0]?.path ?? "";
        }
        expect.soft(path, mode).toBe("claim-package.json");
      } finally {
        rmSync(copy, { recursive: true, force: true });
      }
    }

    for (const mode of ["unknown", "noncanonical"] as const) {
      const copy = mkdtempSync(join(tmpdir(), `bp40-cancel-marker-${mode}-`));
      try {
        cpSync(base, copy, { recursive: true });
        const lines = readAssemblyLines(copy);
        lines[0]!["runCancelled"] = true;
        writeAssemblyLines(copy, lines);
        const markerPath = join(copy, "verification", "cancel-requested.json");
        const marker = {
          requestedAt: "2026-08-05T00:00:00.000Z",
          principal: "sponsor-1",
          ...(mode === "unknown" ? { fabricatedReason: "winner" } : {}),
        };
        writeFileSync(markerPath, mode === "noncanonical" ? JSON.stringify(marker, null, 2) : canonicalJsonBytes(marker));
        rewriteBundleManifestWith(copy, "verification/cancel-requested.json");
        let path = "";
        try { await verifyPublicBundle(copy); } catch (cause) {
          path = (cause as { issues?: Array<{ path: string }> }).issues?.[0]?.path ?? "";
        }
        expect.soft(path, mode).toBe("verification/cancel-requested.json");
      } finally {
        rmSync(copy, { recursive: true, force: true });
      }
    }
  }, 30_000);

  test("authenticates one immutable byte snapshot and rejects externally-linked files", async () => {
    const clock = makeClock();
    await setUpClosedRun(clock);
    const reported = await runReport(contextFor(clock), { draftId: "draft-1" });
    expect(reported.ok, JSON.stringify(reported)).toBe(true);
    if (!reported.ok) return;
    const state = readRunState(workspaceDir, "draft-1");
    if (state === undefined) throw new Error("missing run state");
    const base = materializePublicBundle({
      workspaceDir,
      draftId: "draft-1",
      benchmarkSha256: reported.result.claimPackage.records.benchmarkSha256,
      runState: state,
    }).bundleDir;
    const swap = mkdtempSync(join(tmpdir(), "bp40-snapshot-swap-"));
    try {
      cpSync(base, swap, { recursive: true });
      let hookCalled = false;
      const verified = await verifyPublicBundle(swap, {
        afterManifestValidated() {
          hookCalled = true;
          for (const path of ["matrix.json", "claim-package.json", "trust/public-keys.json"]) {
            writeFileSync(join(swap, path), utf8({ swappedAfterAuthentication: path }));
          }
        },
      } as never);
      expect(hookCalled).toBe(true);
      expect(verified.checks).toContain("claim-consistency");
    } finally {
      rmSync(swap, { recursive: true, force: true });
    }

    const hardlinked = mkdtempSync(join(tmpdir(), "bp40-hardlink-"));
    const outside = join(tmpdir(), `bp40-outside-${Date.now()}.json`);
    try {
      cpSync(base, hardlinked, { recursive: true });
      writeFileSync(outside, readFileSync(join(hardlinked, "matrix.json")));
      rmSync(join(hardlinked, "matrix.json"));
      linkSync(outside, join(hardlinked, "matrix.json"));
      await expect(verifyPublicBundle(hardlinked)).rejects.toMatchObject({
        issues: [expect.objectContaining({ path: "matrix.json" })],
      });
    } finally {
      rmSync(hardlinked, { recursive: true, force: true });
      rmSync(outside, { force: true });
    }
  }, 30_000);

  test("derives every trust identity from SPKI and requires the exact Matrix evaluator set", async () => {
    const clock = makeClock();
    await setUpClosedRun(clock);
    const reported = await runReport(contextFor(clock), { draftId: "draft-1" });
    expect(reported.ok, JSON.stringify(reported)).toBe(true);
    if (!reported.ok) return;
    const state = readRunState(workspaceDir, "draft-1");
    if (state === undefined) throw new Error("missing run state");
    const base = materializePublicBundle({ workspaceDir, draftId: "draft-1", benchmarkSha256: reported.result.claimPackage.records.benchmarkSha256, runState: state }).bundleDir;

    const reportDid = mkdtempSync(join(tmpdir(), "bp40-report-did-"));
    try {
      cpSync(base, reportDid, { recursive: true });
      const trustPath = join(reportDid, "trust", "public-keys.json");
      const trust = JSON.parse(readFileSync(trustPath, "utf8")) as { report: { keyId: string; didKey: string } };
      const envelopePath = join(reportDid, "report-envelope.json");
      const envelope = JSON.parse(readFileSync(envelopePath, "utf8")) as { signatures: Array<{ keyid: string }> };
      const unrelatedDid = "did:key:z6MkrandomUnrelatedPublicIdentity111111111111111";
      trust.report.keyId = unrelatedDid;
      trust.report.didKey = unrelatedDid;
      envelope.signatures[0]!.keyid = unrelatedDid;
      writeCanonical(trustPath, trust);
      writeCanonical(envelopePath, envelope);
      const claimPath = join(reportDid, "claim-package.json");
      const claim = JSON.parse(readFileSync(claimPath, "utf8")) as { records: { reportEnvelopeSha256: string } };
      claim.records.reportEnvelopeSha256 = sha256Hex(readFileSync(envelopePath));
      writeCanonical(claimPath, claim);
      rewriteBundleManifest(reportDid);
      await expect(verifyPublicBundle(reportDid)).rejects.toMatchObject({ issues: [expect.objectContaining({ path: "trust" })] });
    } finally {
      rmSync(reportDid, { recursive: true, force: true });
    }

    const evaluatorKeyId = mkdtempSync(join(tmpdir(), "bp40-evaluator-keyid-"));
    try {
      cpSync(base, evaluatorKeyId, { recursive: true });
      const trustPath = join(evaluatorKeyId, "trust", "public-keys.json");
      const trust = JSON.parse(readFileSync(trustPath, "utf8")) as {
        evaluators: Array<{ keyId: string }>;
      };
      trust.evaluators[0]!.keyId = "benchmark-product-verdict-unrelated-key";
      writeCanonical(trustPath, trust);
      rewriteBundleManifest(evaluatorKeyId);
      await expect(verifyPublicBundle(evaluatorKeyId)).rejects.toMatchObject({
        issues: [expect.objectContaining({ path: "trust" })],
      });
    } finally {
      rmSync(evaluatorKeyId, { recursive: true, force: true });
    }

    for (const mode of ["unused", "reused"] as const) {
      const copy = mkdtempSync(join(tmpdir(), `bp40-trust-${mode}-`));
      try {
        cpSync(base, copy, { recursive: true });
        const trustPath = join(copy, "trust", "public-keys.json");
        const trust = JSON.parse(readFileSync(trustPath, "utf8")) as {
          evaluators: Array<{ evaluator: string; keyId: string; algorithm: "ed25519"; spkiDerBase64: string }>;
        };
        const first = trust.evaluators[0]!;
        trust.evaluators.push({
          evaluator: `urn:jinn:unused:${mode}`,
          keyId: `benchmark-product-verdict-${mode.padEnd(16, "0")}`,
          algorithm: "ed25519",
          spkiDerBase64: mode === "reused"
            ? first.spkiDerBase64
            : generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64"),
        });
        writeCanonical(trustPath, trust);
        rewriteBundleManifest(copy);
        await expect(verifyPublicBundle(copy)).rejects.toMatchObject({ issues: [expect.objectContaining({ path: "trust" })] });
      } finally {
        rmSync(copy, { recursive: true, force: true });
      }
    }
  }, 30_000);

  test("re-derives every public claim block and every fixed presentation asset", async () => {
    const clock = makeClock();
    await setUpClosedRun(clock);
    const reported = await runReport(contextFor(clock), { draftId: "draft-1" });
    expect(reported.ok, JSON.stringify(reported)).toBe(true);
    if (!reported.ok) return;
    const state = readRunState(workspaceDir, "draft-1");
    if (state === undefined) throw new Error("missing run state");
    const base = materializePublicBundle({ workspaceDir, draftId: "draft-1", benchmarkSha256: reported.result.claimPackage.records.benchmarkSha256, runState: state }).bundleDir;
    const claimVectors: Array<[string, (claim: Record<string, any>) => void]> = [
      ["scope", (claim) => { claim.scope.taskCount += 1; }],
      ["headline", (claim) => { claim.headline[Object.keys(claim.headline)[0]].passRate = "0.123"; }],
      ["assurance", (claim) => { claim.assurance.preset = "evaluator-panel"; }],
      ["disclosure summaries", (claim) => { claim.disclosures.integrityTierCounts["re-derivable"] += 1; }],
      ["venue honesty", (claim) => { claim.venueHonesty = { venue: "self-run", dishonest: true }; }],
      ["verification", (claim) => { claim.verification.command = "benchmark-product verify --workspace /private/source --draft draft-1"; }],
      ["rehearsal", (claim) => { claim.rehearsal = { previewCount: 1, timestamps: ["2026-08-05T00:00:00.000Z"] }; }],
    ];
    for (const [name, mutate] of claimVectors) {
      const copy = mkdtempSync(join(tmpdir(), `bp40-claim-${name.replaceAll(" ", "-")}-`));
      try {
        cpSync(base, copy, { recursive: true });
        const claimPath = join(copy, "claim-package.json");
        const claim = JSON.parse(readFileSync(claimPath, "utf8")) as Record<string, any>;
        mutate(claim);
        writeCanonical(claimPath, claim);
        rewriteBundleManifest(copy);
        await expect(verifyPublicBundle(copy), name).rejects.toMatchObject({ issues: [expect.objectContaining({ path: "claim-consistency" })] });
      } finally {
        rmSync(copy, { recursive: true, force: true });
      }
    }
    for (const path of ["index.html", "badge.svg", "social-card.svg", "README.md", "share.txt"]) {
      const copy = mkdtempSync(join(tmpdir(), "bp40-asset-"));
      try {
        cpSync(base, copy, { recursive: true });
        writeFileSync(join(copy, path), `${readFileSync(join(copy, path), "utf8")}\ntampered\n`);
        rewriteBundleManifest(copy);
        await expect(verifyPublicBundle(copy), path).rejects.toMatchObject({ issues: [expect.objectContaining({ path })] });
      } finally {
        rmSync(copy, { recursive: true, force: true });
      }
    }
  }, 30_000);

  test("publishes to a digest-addressed target with one audit and an atomic RunState/draft pair", async () => {
    const clock = makeClock();
    await setUpClosedRun(clock);
    expect((await runReport(contextFor(clock), { draftId: "draft-1" })).ok).toBe(true);
    const auditBefore = readAuditEntries(workspaceDir).length;
    let release!: () => void;
    let afterRunState!: () => void;
    let signalled = false;
    const paused = new Promise<void>((resolve) => { afterRunState = () => { signalled = true; resolve(); }; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = runPublish(contextFor(clock), { draftId: "draft-1" }, {
      async afterRunState() { afterRunState(); await gate; },
    } as never);
    await Promise.race([paused, new Promise<void>((resolve) => setTimeout(resolve, 50))]);
    expect(signalled).toBe(true);
    let secondSettled = false;
    const second = runPublish(contextFor(clock), { draftId: "draft-1" }).finally(() => { secondSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(secondSettled).toBe(false);
    release();
    const [one, two] = await Promise.all([first, second]);
    expect(one.ok, JSON.stringify(one)).toBe(true);
    expect(two.ok, JSON.stringify(two)).toBe(true);
    if (!one.ok) return;
    expect(one.result.bundleRelativePath).toBe(`artifacts/draft-1/public-bundles/${one.result.bundleIdentity}`);
    expect(readAuditEntries(workspaceDir).slice(auditBefore).filter((entry) => entry.action === "run.verify")).toHaveLength(0);
    expect(readRunState(workspaceDir, "draft-1")?.bundleRelativePath).toBe(one.result.bundleRelativePath);
    expect(readDraftDocument(workspaceDir, "draft-1").updatedAt).toBe(readRunState(workspaceDir, "draft-1")?.publishedAt);
  }, 30_000);
});

describe("runReport — refusals", () => {
  test("refuses illegal-transition when the draft is not closed", async () => {
    const clock = makeClock();
    initWorkspace(contextFor(clock));
    createDraft(contextFor(clock), { draftId: "draft-1", name: "Never Run" });

    const outcome = await runReport(contextFor(clock), { draftId: "draft-1" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("illegal-transition");
  });

  test("refuses conflict when the draft is closed but has no sealed Matrix (doctored RunState)", async () => {
    const clock = makeClock();
    await setUpClosedRun(clock);
    const runState = readRunState(workspaceDir, "draft-1");
    expect(runState).toBeDefined();
    if (runState === undefined) return;
    const { matrixSha256: _matrixSha256, ...withoutMatrix } = runState;
    writeRunState(workspaceDir, "draft-1", withoutMatrix);

    const outcome = await runReport(contextFor(clock), { draftId: "draft-1" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("conflict");

    // The draft was NOT advanced to reported by a refused report attempt.
    expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("closed");
  }, 30_000);

  test("refuses authority-denied for a workspace member without the report grant, and audits it", async () => {
    const clock = makeClock();
    await setUpClosedRun(clock);
    const granted = authorityGrant(contextFor(clock), { principalId: "agent-1", operations: [] });
    expect(granted.ok).toBe(true);

    const outcome = await runReport(contextFor(clock, "agent-1"), { draftId: "draft-1" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("authority-denied");

    const entries = readAuditEntries(workspaceDir);
    expect(entries[entries.length - 1]).toMatchObject({
      action: "report",
      actor: "agent-1",
      outcome: "authority-denied",
    });

    // The draft was NOT advanced to reported by a denied report attempt.
    expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("closed");
  }, 30_000);
});

describe("runReport — claim-package write failure does not strand the draft", () => {
  test(
    "a failure writing the claim package leaves the draft closed and retryable, not stranded at reported",
    async () => {
      const clock = makeClock();
      await setUpClosedRun(clock);

      // Obstruct the claim package's parent directory (`<ws>/artifacts/<draftId>`) with a FILE
      // in its place, so `writeClaimPackage`'s `atomicWriteFileSync` cannot `mkdirSync` it and
      // throws. Nothing has written into `artifacts/<draftId>/` yet at this point in the test
      // (only `run.collect` has run, not `run.results`), so the path is free to obstruct.
      const claimDir = join(workspaceDir, "artifacts", "draft-1");
      writeFileSync(claimDir, "obstruction");

      const failed = await runReport(contextFor(clock), { draftId: "draft-1" });
      expect(failed.ok).toBe(false);
      if (failed.ok) return;
      // A typed refusal via the operate boundary, not an uncaught crash.
      expect(typeof failed.error.code).toBe("string");

      // The draft is STILL "closed" — the irreversible transition never ran because the claim
      // package write (which now runs BEFORE it) failed first.
      expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("closed");
      expect(existsSync(claimPackageArtifactPath(workspaceDir, "draft-1"))).toBe(false);

      // Remove the obstruction and retry: `report` is fully replayable from "closed".
      rmSync(claimDir, { force: true });

      const retried = await runReport(contextFor(clock), { draftId: "draft-1" });
      expect(retried.ok, JSON.stringify(retried)).toBe(true);
      if (!retried.ok) return;
      expect(retried.result.draft.state).toBe("reported");
      expect(existsSync(claimPackageArtifactPath(workspaceDir, "draft-1"))).toBe(true);

      const verified = await runVerify(contextFor(clock), { draftId: "draft-1" });
      expect(verified.ok, JSON.stringify(verified)).toBe(true);
      if (!verified.ok) return;
      expect(verified.result.checks).toContain("claim-consistency");
    },
    30_000,
  );
});
