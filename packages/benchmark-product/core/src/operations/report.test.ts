import { cpSync, existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BENCHMARKING_METHOD_IDS, BENCHMARKING_METHOD_VERSION, cellIdempotencyKey, parseBenchmarkAccounting, parseMatrix, parseReport, parseSignedReportRecord } from "@jinn-network/benchmarking-records";
import { requirementsDigest } from "@jinn-network/benchmarking-local";
import { exportStaticBundle } from "@jinn-network/benchmarking-interop";
import type { AttemptUri, DeliveryRef, ObservationSnapshot, SubmissionAck, SubmissionUri } from "@jinn-network/task-execution-backend";
import { sealDelivery, type ResourceDescriptor } from "@jinn-network/task-execution-protocol";
import { deriveEvaluationTask } from "@jinn-network/task-execution-profiles";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { RECORD_KINDS } from "@jinn-network/record-discovery-protocol";
import type { ProxiedBackend } from "../run/drive.js";
import { readRunJournalEntries } from "../run/journal.js";
import { recordWorkspaceAuthorship } from "../run/publication-authority.js";
import { readRunState, writeRunState } from "../run/state.js";
import { additionalClaimPackagePath } from "../report/claim.js";
import { createWorkspacePublicationHttpHandler, createWorkspacePublicationSource, recordPath } from "../run/publication-source.js";
import { claimPackageArtifactPath, draftPath, publicationDir, publicationServeRoot, publicBundlePath, publicBundlesDir, runStatePath } from "../workspace/layout.js";
import { getSealedBytes, putSealedBytes, sha256Hex } from "../workspace/sealed-store.js";
import {
  APEX_SWE_DEV_ADAPTER_ID,
  APEX_SWE_DEV_DATASET_ID,
  APEX_SWE_DEV_DATASET_REVISION,
  APEX_SWE_HARNESS_REVISION,
  ApexSweDevSelectionManifestSchema,
  apexSweDevSelectionBytes,
} from "../runtime/apex-swe-dev/manifest.js";
import { SUITE_PROTOCOL_SELECTION_SCHEMA } from "../runtime/suite-protocol/manifest.js";
import {
  APEX_SWE_DEV_NOT_LEADERBOARD_READY_LIMITATION,
  SUITE_NOT_LEADERBOARD_READY_LIMITATION,
} from "../runtime/suite-protocol/comparability.js";
import { LEGACY_VERDICT_EVALUATOR_ID, createVerdictDsseSigner, loadOrCreateVerdictSigningKey, sealVerdictStatement } from "../venue/signing.js";
import type { LocalVenue } from "../venue/venue.js";
import { armAdd } from "./arms.js";
import { authorityGrant } from "./authority-ops.js";
import type { OperationContext } from "./context.js";
import { createDraft, readDraftDocument, updateDraft } from "./drafts.js";
import { initWorkspace } from "./init.js";
import { readAuditEntries } from "../audit/journal.js";
import { materializePublicBundle, PUBLIC_BUNDLE_FILES, PUBLIC_BUNDLE_V4_FILES } from "../bundle/materialize.js";
import { createSyntheticV4BundleFixture } from "../bundle/testing/v4-synthetic-fixture.js";
import { verifyPublicBundle } from "../bundle/verify.js";
import { BUNDLE_FORMAT, BUNDLE_V3_FORMAT, BUNDLE_V4_FORMAT, buildBundleManifest } from "../bundle/manifest.js";
import { runCli } from "../cli/main.js";
import { runCollect } from "./run-collect.js";
import { runLaunch } from "./run-launch.js";
import { runLock } from "./run-lock.js";
import { runQuote } from "./run-quote.js";
import { runReport } from "./report.js";
import { publicationReport } from "./publication-report.js";
import { publicationAccounting } from "./publication-accounting.js";
import { publicationConfigure, publicationRegister } from "./publication-register.js";
import { runPublish } from "./publish.js";
import { runVerify } from "./verify.js";
import { runResults } from "./run-results.js";
import { sampleInit } from "./sample.js";

let workspaceDir: string;
let publicationServer: Server | undefined;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp13-report-op-"));
});

afterEach(async () => {
  if (publicationServer !== undefined) await new Promise<void>((resolve) => publicationServer!.close(() => resolve()));
  publicationServer = undefined;
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

// ── packet P5 proof 1a: the shipped, packaged `external-verify.py` (spec §8.3) ────────────────
// Invoked at the PACKAGED path (`node_modules/@colophon-claims/verify/scripts/...`), never the
// repo source path — that packaged copy is the artifact a third party installs, per the verify
// package's `files` list and `verify/scripts/pack-smoke.mjs`.
const EXTERNAL_VERIFY_SCRIPT = fileURLToPath(
  new URL("../../node_modules/@colophon-claims/verify/scripts/external-verify.py", import.meta.url),
);
const EXTERNAL_VERIFY_CHECKS = [
  "manifest-files", "cas-records", "sealed-bytes", "report-signature",
  "report-pins-matrix", "verdict-signatures", "matrix-verdict-closure",
  "claim-mirror", "key-derivations",
] as const;

/** Probed once, exactly as `verify/test/external-walkthrough.test.mjs` does: a directory that
 * exists but is not a bundle still passes the "is this a directory" and "can openssl sign/verify
 * Ed25519" gates the script runs before it ever reads bundle.json, so exit code 2 here means only
 * one thing — python3 or an Ed25519-capable openssl is unavailable — never "not a real bundle". */
function probeExternalVerifyAvailable(): boolean {
  const probeDir = mkdtempSync(join(tmpdir(), "bp-p5-extverify-probe-"));
  try {
    const probe = spawnSync("python3", [EXTERNAL_VERIFY_SCRIPT, probeDir], { encoding: "utf8" });
    return probe.error === undefined && probe.status !== 2;
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}
const externalVerifyAvailable = probeExternalVerifyAvailable();

async function runExternalVerify(bundleDir: string): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn("python3", [EXTERNAL_VERIFY_SCRIPT, bundleDir], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", () => resolvePromise({ code: 2, stdout: "", stderr: "spawn error" }));
    child.once("exit", (code) => resolvePromise({
      code: code ?? 2,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

/** Exit 0 plus one `CHECK <name>: ok` line per check, EXCEPT `claim-mirror`, which the script
 * itself skips for a comparison-shaped claim ("comparison-shaped claims carry no headline to
 * mirror") — a skip does not fail the run, so its line is asserted as ok-or-skipped rather than
 * pinned to one outcome. */
function assertExternalVerifyAllChecksPass(result: { readonly code: number; readonly stdout: string; readonly stderr: string }): void {
  expect(result.code, `external-verify.py exited ${result.code}\n${result.stdout}\n${result.stderr}`).toBe(0);
  for (const check of EXTERNAL_VERIFY_CHECKS) {
    if (check === "claim-mirror") {
      expect(result.stdout).toMatch(/CHECK claim-mirror: (ok|skipped)/);
    } else {
      expect(result.stdout).toMatch(new RegExp(`CHECK ${check}: ok`));
    }
  }
}

async function servePublicationWorkspace(mount = ""): Promise<string> {
  const handler = createWorkspacePublicationHttpHandler(workspaceDir);
  publicationServer = createServer(async (request, response) => {
    const url = new URL(`http://127.0.0.1${request.url ?? "/"}`);
    if (mount !== "") {
      expect(url.pathname.startsWith(`${mount}/`)).toBe(true);
      url.pathname = url.pathname.slice(mount.length) || "/";
    }
    const result = await handler(new Request(url, { method: request.method }));
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  });
  await new Promise<void>((resolve) => publicationServer!.listen(0, "127.0.0.1", resolve));
  const address = publicationServer.address();
  if (address === null || typeof address === "string") throw new Error("publication test server has no TCP address");
  return `http://127.0.0.1:${address.port}${mount}`;
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
  const pinningBySubmission = new Map<SubmissionUri, {
    ready: true;
    checkedRequirementsDigest: `sha256:${string}`;
  }>();
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
        requirements?: Record<string, unknown> & { harness?: { id?: string } };
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
      pinningBySubmission.set(ack.submission, {
        ready: true,
        checkedRequirementsDigest: requirementsDigest(doc.requirements ?? {}),
      });
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
    pinningEvidenceForSubmission(ref) {
      const evidence = pinningBySubmission.get(ref);
      return evidence === undefined ? undefined : { ...evidence };
    },
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
    /** P4b Task 3: patched onto the draft spec (via updateDraft) before quote/lock, so
     * compileDraft's buildAnalysisPlan seals the named method into the Run's analysisPlan. */
    readonly analysis?: {
      readonly method: string;
      readonly version: string;
      readonly baseline?: string;
      readonly candidate?: string;
      readonly parameters?: Record<string, unknown>;
    };
    /** Packet P5 (spec §8.3 option 5): patched onto the draft spec (via updateDraft) before
     * quote/lock, alongside `analysis` above, so compileDraft's buildAnalysisPlan wrapper appends
     * these entries after the primary plan. */
    readonly additionalAnalyses?: readonly {
      readonly method: string;
      readonly version: string;
      readonly baseline?: string;
      readonly candidate?: string;
      readonly parameters?: Record<string, unknown>;
    }[];
  } = {},
): Promise<void> {
  initWorkspace(contextFor(clock));
  createDraft(contextFor(clock), { draftId, name: "Report Test" });
  const sample = await sampleInit(contextFor(clock), { draftId });
  expect(sample.ok).toBe(true);
  if (!sample.ok) throw new Error("unreachable");
  armAdd(contextFor(clock), { draftId, armId: "baseline", pinning: { harness: { id: "prediction-v1-baseline", version: "1.0.0" } } });
  armAdd(contextFor(clock), { draftId, armId: "sample", pinning: { harness: { id: "sample-uniform", version: "0.1.0" } } });
  if (options.analysis !== undefined || options.additionalAnalyses !== undefined) {
    const patched = updateDraft(contextFor(clock), {
      draftId,
      patch: {
        ...(options.analysis !== undefined ? { analysis: options.analysis } : {}),
        ...(options.additionalAnalyses !== undefined ? { additionalAnalyses: options.additionalAnalyses } : {}),
      },
    });
    expect(patched.ok).toBe(true);
  }
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

/** The Report-v2 operation consumes the independent accounting closure; it never launches this
 * fixture's backend. Registration after close is deliberately post-hoc. */
async function setUpPublishedAccounting(
  clock: () => string,
  mount = "",
  closedRunOptions: Parameters<typeof setUpClosedRun>[2] = {},
): Promise<void> {
  await setUpClosedRun(clock, "draft-1", closedRunOptions);
  recordRunPublicationAuthorship("draft-1");
  const publicBaseUrl = await servePublicationWorkspace(mount);
  const configured = await publicationConfigure(contextFor(clock), { draftId: "draft-1", publicBaseUrl });
  expect(configured.ok, JSON.stringify(configured)).toBe(true);
  const registered = await publicationRegister(contextFor(clock), { draftId: "draft-1" });
  expect(registered.ok, JSON.stringify(registered)).toBe(true);
  const accounted = await publicationAccounting(contextFor(clock), { draftId: "draft-1" });
  expect(accounted.ok, JSON.stringify(accounted)).toBe(true);
}

/** The fake backend predates publication authority capture. Bind its exact locally-created
 * Deliveries and verdict envelopes to the workspace owner before accounting publishes them. */
function recordRunPublicationAuthorship(draftId: string): void {
  for (const entry of readRunJournalEntries(workspaceDir, draftId)) {
    if (entry.kind === "delivery") {
      recordWorkspaceAuthorship({
        workspaceDir,
        recordSha256: entry.deliverySha256,
        recordKind: RECORD_KINDS.delivery,
        authoredAt: entry.at,
      });
    }
    if (entry.kind === "evaluation" && entry.verdictSha256 !== undefined) {
      recordWorkspaceAuthorship({
        workspaceDir,
        recordSha256: entry.verdictSha256,
        recordKind: RECORD_KINDS.resultEvaluation,
        authoredAt: entry.at,
      });
    }
  }
}

describe("publication.report — signed Report v2", () => {
  test("exactly GETs and HEAD-probes payload, envelope, and accounting support through a nested public mount", async () => {
    const clock = makeClock();
    await setUpPublishedAccounting(clock, "/nested/publication");
    const published = await publicationReport(contextFor(clock), { draftId: "draft-1" });
    expect(published.ok, JSON.stringify(published)).toBe(true);
    if (!published.ok) return;
    const state = readRunState(workspaceDir, "draft-1")!;
    const base = `http://127.0.0.1:${(publicationServer!.address() as import("node:net").AddressInfo).port}/nested/publication`;
    for (const digest of [state.accountingSha256!, state.matrixV2Sha256!, published.result.reportRecordSha256]) {
      const path = `${base}${recordPath(`sha256:${digest}`)}`;
      expect((await fetch(path, { method: "HEAD" })).status).toBe(200);
      expect(new Uint8Array(await (await fetch(path)).arrayBuffer())).toEqual(getSealedBytes(workspaceDir, digest));
    }
    const payload = `${base}/publication-artifacts/sha256/${published.result.reportPayloadSha256}`;
    expect((await fetch(payload, { method: "HEAD" })).status).toBe(200);
    expect(new Uint8Array(await (await fetch(payload)).arrayBuffer())).toEqual(getSealedBytes(workspaceDir, published.result.reportPayloadSha256));
  }, 60_000);

  test("preserves an existing legacy Report v1 while publishing and retrying an independent signed Report v2", async () => {
    const clock = makeClock();
    await setUpClosedRun(clock);
    const legacy = await runReport(contextFor(clock), { draftId: "draft-1" });
    expect(legacy.ok, JSON.stringify(legacy)).toBe(true);
    if (!legacy.ok) return;
    const legacyPayload = new Uint8Array(getSealedBytes(workspaceDir, legacy.result.reportSha256));
    const legacyEnvelope = new Uint8Array(getSealedBytes(workspaceDir, legacy.result.reportEnvelopeSha256));
    const afterV1 = readRunState(workspaceDir, "draft-1")!;
    expect(afterV1.reportPayloadSha256).toBeUndefined();
    expect(afterV1.reportRecordSha256).toBeUndefined();

    recordRunPublicationAuthorship("draft-1");
    const publicBaseUrl = await servePublicationWorkspace();
    expect((await publicationConfigure(contextFor(clock), { draftId: "draft-1", publicBaseUrl })).ok).toBe(true);
    expect((await publicationRegister(contextFor(clock), { draftId: "draft-1" })).ok).toBe(true);
    expect((await publicationAccounting(contextFor(clock), { draftId: "draft-1" })).ok).toBe(true);
    const v2 = await publicationReport(contextFor(clock), { draftId: "draft-1" });
    expect(v2.ok, JSON.stringify(v2)).toBe(true);
    if (!v2.ok) return;

    const coexist = readRunState(workspaceDir, "draft-1")!;
    expect(coexist.reportSha256).toBe(legacy.result.reportSha256);
    expect(coexist.reportEnvelopeSha256).toBe(legacy.result.reportEnvelopeSha256);
    expect(getSealedBytes(workspaceDir, coexist.reportSha256!)).toEqual(legacyPayload);
    expect(getSealedBytes(workspaceDir, coexist.reportEnvelopeSha256!)).toEqual(legacyEnvelope);
    expect(coexist.reportPayloadSha256).toBe(v2.result.reportPayloadSha256);
    expect(coexist.reportRecordSha256).toBe(v2.result.reportRecordSha256);
    expect(v2.result.reportPayloadSha256).not.toBe(legacy.result.reportSha256);
    expect(v2.result.reportRecordSha256).not.toBe(legacy.result.reportEnvelopeSha256);
    expect(parseReport(legacyPayload)).not.toHaveProperty("https://spec.jinn.network/extensions/benchmark-publication/v1");
    const signedV2 = parseSignedReportRecord(getSealedBytes(workspaceDir, v2.result.reportRecordSha256));
    expect(signedV2.payloadBytes).toEqual(getSealedBytes(workspaceDir, v2.result.reportPayloadSha256));
    expect((signedV2.payload as Record<string, unknown>)["https://spec.jinn.network/extensions/benchmark-publication/v1"]).toBeDefined();

    const retried = await publicationReport(contextFor(clock), { draftId: "draft-1" });
    expect(retried).toEqual(v2);
    expect(getSealedBytes(workspaceDir, legacy.result.reportSha256)).toEqual(legacyPayload);
    expect(getSealedBytes(workspaceDir, legacy.result.reportEnvelopeSha256)).toEqual(legacyEnvelope);
  }, 60_000);

  test("publishes exact payload before the owned envelope, derives post-hoc disclosure, and is idempotent", async () => {
    const clock = makeClock();
    await setUpPublishedAccounting(clock);
    const published = await publicationReport(contextFor(clock), { draftId: "draft-1" });
    expect(published.ok, JSON.stringify(published)).toBe(true);
    if (!published.ok) return;
    expect(published.result.reportPayloadSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(published.result.reportRecordSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(published.result.reportPayloadSha256).not.toBe(published.result.reportRecordSha256);
    const signed = parseSignedReportRecord(getSealedBytes(workspaceDir, published.result.reportRecordSha256));
    expect(signed.payload.preregistered).toBe(true);
    expect((signed.payload as Record<string, any>)["https://spec.jinn.network/extensions/benchmark-publication/v1"].publicRegistration.perSubject[0].status).toBe("post-hoc");

    const source = createWorkspacePublicationSource(workspaceDir, "colophon-benchmarks");
    const announcements = Object.values((await source.writer.readState())!.announcements);
    const sequence = (digest: string) => announcements.find((entry) => entry.receipt.record?.digest === `sha256:${digest}`)!.receipt.sequence;
    const state = readRunState(workspaceDir, "draft-1")!;
    expect(Number(sequence(state.runSha256!))).toBeLessThan(Number(sequence(state.accountingSha256!)));
    expect(Number(sequence(state.accountingSha256!))).toBeLessThan(Number(sequence(state.matrixV2Sha256!)));
    expect(Number(sequence(state.matrixV2Sha256!))).toBeLessThan(Number(sequence(published.result.reportRecordSha256)));
    expect(state.publication!.report.state).toBe("complete");
    expect(state.reportPayloadSha256).toBe(published.result.reportPayloadSha256);
    expect(state.reportRecordSha256).toBe(published.result.reportRecordSha256);

    const repeated = await publicationReport(contextFor(clock), { draftId: "draft-1" });
    expect(repeated).toEqual(published);
  }, 60_000);

  test(
    "packet P5: with additionalAnalyses registered, publicationReport still pins the PRIMARY entry — never an additional one",
    async () => {
      // publicationReport is a genuinely independent, single-Report v2 pipeline (never fans out
      // to N — the write-once reportPayloadSha256/reportRecordSha256 guard in run/state.ts is
      // exactly why). Before additionalAnalyses existed, its selection
      // (`run.analysisPlan?.[run.analysisPlan.length - 1]`) always landed on the primary entry
      // because the plan was never longer than two. Once additionalAnalyses append more entries,
      // that same raw last-index read would silently start reporting a DIFFERENT (additional)
      // method — this draft has no explicit `analysis`, so the primary is wilson, and the
      // regression this test guards against is publicationReport reporting paired-delta instead.
      const clock = makeClock();
      await setUpPublishedAccounting(clock, "", {
        evaluationModes: Array(8).fill("no-verdict"),
        additionalAnalyses: [
          {
            method: "jinn.benchmarking.method/paired-delta",
            version: "1",
            baseline: "baseline",
            candidate: "sample",
            parameters: { seed: 1, resamples: 10, alpha: "0.05" },
          },
        ],
      });
      const published = await publicationReport(contextFor(clock), { draftId: "draft-1" });
      expect(published.ok, JSON.stringify(published)).toBe(true);
      if (!published.ok) return;
      const signed = parseSignedReportRecord(getSealedBytes(workspaceDir, published.result.reportRecordSha256));
      expect(signed.payload.method.id).toBe("jinn.benchmarking.method/wilson");
    },
    60_000,
  );

  test("leaves accounting complete and report unstarted when an exact-public dependency is unavailable", async () => {
    const clock = makeClock();
    await setUpPublishedAccounting(clock);
    const state = readRunState(workspaceDir, "draft-1")!;
    unlinkSync(join(publicationServeRoot(workspaceDir), recordPath(`sha256:${state.matrixV2Sha256!}`)));
    const refused = await publicationReport(contextFor(clock), { draftId: "draft-1" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.detail).toMatch(/Matrix v2|probe/);
    const after = readRunState(workspaceDir, "draft-1")!;
    expect(after.publication!.accounting.state).toBe("complete");
    expect(after.publication!.report.state).toBe("not-started");
    expect(after.reportRecordSha256).toBeUndefined();
  }, 60_000);

  test("refuses unavailable accounting support before creating a Report", async () => {
    const clock = makeClock();
    await setUpPublishedAccounting(clock);
    const state = readRunState(workspaceDir, "draft-1")!;
    const accounting = parseBenchmarkAccounting(getSealedBytes(workspaceDir, state.accountingSha256!));
    const submissionSha256 = accounting.cells.flatMap((cell) => cell.dispatches)[0]!.submission.record.digest.sha256;
    unlinkSync(join(publicationServeRoot(workspaceDir), recordPath(`sha256:${submissionSha256}`)));
    const refused = await publicationReport(contextFor(clock), { draftId: "draft-1" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.detail).toMatch(/support|payload probe|returned 404/);
    const after = readRunState(workspaceDir, "draft-1")!;
    expect(after.publication!.accounting.state).toBe("complete");
    expect(after.publication!.report.state).toBe("not-started");
  }, 60_000);

  test("requires exact durable stage receipts, digest bindings, and registration < accounting < Matrix order", async () => {
    const clock = makeClock();
    await setUpPublishedAccounting(clock);
    const original = readRunState(workspaceDir, "draft-1")!;
    const overwriteState = (value: typeof original) => writeFileSync(runStatePath(workspaceDir, "draft-1"), JSON.stringify(value));

    const missingReceipt = structuredClone(original);
    delete missingReceipt.publication!.accounting.receipt;
    overwriteState(missingReceipt);
    const missing = await publicationReport(contextFor(clock), { draftId: "draft-1" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.detail).toMatch(/receipt/);

    const corruptReceipt = structuredClone(original);
    corruptReceipt.publication!.accounting.receipt!.entrySha256 = "f".repeat(64);
    overwriteState(corruptReceipt);
    const corrupt = await publicationReport(contextFor(clock), { draftId: "draft-1" });
    expect(corrupt.ok).toBe(false);
    if (!corrupt.ok) expect(corrupt.error.detail).toMatch(/receipt.*bind/);

    const wrongDigest = structuredClone(original);
    wrongDigest.publication!.matrixV2.digests!.matrixV2 = "f".repeat(64);
    overwriteState(wrongDigest);
    const digest = await publicationReport(contextFor(clock), { draftId: "draft-1" });
    expect(digest.ok).toBe(false);
    if (!digest.ok) expect(digest.error.detail).toMatch(/digest/);

    overwriteState(original);
    const sourceStatePath = join(publicationDir(workspaceDir), "sources", readdirSync(join(publicationDir(workspaceDir), "sources")).find((name) => name.endsWith(".state.json"))!);
    const sourceState = JSON.parse(readFileSync(sourceStatePath, "utf8")) as { announcements: Record<string, { receipt: { sequence: string; entryDigest: string; record?: { digest: string } } }> };
    const accountingAnnouncement = Object.values(sourceState.announcements).find((entry) => entry.receipt.record?.digest === `sha256:${original.accountingSha256}`)!;
    const matrixAnnouncement = Object.values(sourceState.announcements).find((entry) => entry.receipt.record?.digest === `sha256:${original.matrixV2Sha256}`)!;
    const accountingReceipt = structuredClone(accountingAnnouncement.receipt);
    accountingAnnouncement.receipt.sequence = matrixAnnouncement.receipt.sequence;
    accountingAnnouncement.receipt.entryDigest = matrixAnnouncement.receipt.entryDigest;
    matrixAnnouncement.receipt.sequence = accountingReceipt.sequence;
    matrixAnnouncement.receipt.entryDigest = accountingReceipt.entryDigest;
    writeFileSync(sourceStatePath, JSON.stringify(sourceState));
    const wrongOrder = structuredClone(original);
    wrongOrder.publication!.accounting.receipt = { sourceSequence: accountingAnnouncement.receipt.sequence, entrySha256: accountingAnnouncement.receipt.entryDigest.slice(7) };
    wrongOrder.publication!.matrixV2.receipt = { sourceSequence: matrixAnnouncement.receipt.sequence, entrySha256: matrixAnnouncement.receipt.entryDigest.slice(7) };
    overwriteState(wrongOrder);
    const ordered = await publicationReport(contextFor(clock), { draftId: "draft-1" });
    expect(ordered.ok).toBe(false);
    if (!ordered.ok) expect(ordered.error.detail).toMatch(/order|registration < BenchmarkAccounting < Matrix v2/);
  }, 60_000);

  test("freezes a Report timestamp strictly after the source head when the operation clock is equal", async () => {
    const clock = makeClock();
    await setUpPublishedAccounting(clock);
    const source = createWorkspacePublicationSource(workspaceDir, "colophon-benchmarks");
    const before = await source.head.getExact();
    if (before === undefined) throw new Error("fixture source has no head");
    const published = await publicationReport(contextFor(() => before.issuedAt), { draftId: "draft-1" });
    expect(published.ok, JSON.stringify(published)).toBe(true);
    const announcedAt = readRunState(workspaceDir, "draft-1")!.publication!.report.announcedAt!;
    expect(Date.parse(announcedAt)).toBeGreaterThan(Date.parse(before.issuedAt));
  }, 60_000);

  test("recovers the same source receipt after a crash-shaped complete Report checkpoint", async () => {
    const clock = makeClock();
    await setUpPublishedAccounting(clock);
    let crashed = false;
    const first = await publicationReport(contextFor(clock), { draftId: "draft-1" }, { afterAppendBeforeCheckpoint: async () => { crashed = true; throw new Error("fixture crash"); } });
    expect(first.ok).toBe(false);
    expect(crashed).toBe(true);
    const source = createWorkspacePublicationSource(workspaceDir, "colophon-benchmarks");
    const before = (await source.writer.readState())!.last!;
    const partial = readRunState(workspaceDir, "draft-1")!;
    expect(partial.publication!.report.state).toBe("in-progress");
    writeRunState(workspaceDir, "draft-1", {
      ...partial,
      publication: { ...partial.publication!, report: {
        state: "complete",
        announcedAt: partial.publication!.report.announcedAt,
      } },
    });
    const retried = await publicationReport(contextFor(clock), { draftId: "draft-1" });
    expect(retried.ok, JSON.stringify(retried)).toBe(true);
    if (!retried.ok) return;
    expect(retried.result.receipt.entrySha256).toBe(before.entryDigest.slice(7));
    const recovered = readRunState(workspaceDir, "draft-1")!;
    expect(recovered.publication!.report.receipt!.entrySha256).toBe(before.entryDigest.slice(7));
    expect(recovered.publication!.report.digests).toEqual({
      payload: retried.result.reportPayloadSha256,
      record: retried.result.reportRecordSha256,
    });
  }, 60_000);
});

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
      expect(outcome.result).not.toHaveProperty("reportPayloadSha256");
      expect(outcome.result).not.toHaveProperty("reportRecordSha256");

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

describe("runReport — analysis method selection (P4b Task 3)", () => {
  test(
    "produces the Report with the selected paired method and derives preregistered",
    async () => {
      const clock = makeClock();
      // Every evaluation is dispatched in "no-verdict" mode, so no cell in either arm is ever
      // "judged" and no Task is ever paired across baseline/candidate. paired-delta@1's compute
      // (registry.ts) only resolves Task provenance for a paired Task — with zero pairs it never
      // does, which is what lets this fixture avoid the sample benchmark's known provenance gap
      // (P4b scoping §6.1: the bundled sample benchmark's Tasks carry no `payload.provenance`, so
      // a paired analysis with any real pairing cannot compute on the sample path). This still
      // exercises the real produceReport() call runReport() makes, with a real sealed Run/Matrix.
      await setUpClosedRun(clock, "draft-1", {
        evaluationModes: Array(8).fill("no-verdict"),
        analysis: {
          method: "jinn.benchmarking.method/paired-delta",
          version: "1",
          baseline: "baseline",
          candidate: "sample",
          parameters: { seed: 123456789, resamples: 1000, alpha: "0.05" },
        },
      });

      const outcome = await runReport(contextFor(clock), { draftId: "draft-1" });
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
      if (!outcome.ok) return;

      const reportRecord = parseReport(getSealedBytes(workspaceDir, outcome.result.reportSha256));
      expect(reportRecord.method.id).toBe("jinn.benchmarking.method/paired-delta");
      expect(reportRecord.method.parameters).toMatchObject({
        alpha: "0.05",
        baseline: "baseline",
        candidate: "sample",
      });
      expect(reportRecord.limitations).toContain(
        "This method estimates an effect; it does not gate one — no verdict, threshold, or selection was registered.",
      );
      // The whole point: the produced tuple must be exactly-JSON-equal to a sealed plan entry.
      expect(reportRecord.preregistered).toBe(true);
    },
    30_000,
  );

  test(
    "still produces a wilson Report, preregistered, when no analysis block is set",
    async () => {
      const clock = makeClock();
      await setUpClosedRun(clock);

      const outcome = await runReport(contextFor(clock), { draftId: "draft-1" });
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
      if (!outcome.ok) return;

      const reportRecord = parseReport(getSealedBytes(workspaceDir, outcome.result.reportSha256));
      expect(reportRecord.method.id).toBe("jinn.benchmarking.method/wilson");
      expect(reportRecord.preregistered).toBe(true);
    },
    30_000,
  );

  /** APEX-SWE-dev is never `leaderboardSubmitReady` (DR-2026-08-18-c §5), so its protocol-named
   * limitation must reach `limitations[]` through the real `report` operation, not only through a
   * direct `suiteFactsFromAccountedApexSweDevRun` call in a unit test. Their harnesses run on the
   * operator host (`run launch` refuses the adapter outright), so this binds a genuinely
   * schema-parsed, sealed APEX-SWE-dev selection onto a real closed run's own draft. */
  test(
    "the APEX-SWE-dev limitation reaches Report limitations through the report operation",
    async () => {
      const clock = makeClock();
      await setUpClosedRun(clock);

      const manifestBytes = apexSweDevSelectionBytes(ApexSweDevSelectionManifestSchema.parse({
        schema: "jinn.network/benchmark-product/apex-swe-dev-selection/1",
        dataset: {
          id: APEX_SWE_DEV_DATASET_ID,
          revision: APEX_SWE_DEV_DATASET_REVISION,
          registrySnapshotSha256: "d".repeat(64),
          registrySnapshotBytes: 128,
          taskCount: 1,
        },
        coverage: "full",
        selectedTasks: [{ taskId: "0xobs-00", taskType: "observability" }],
        harness: {
          adapterId: APEX_SWE_DEV_ADAPTER_ID,
          revision: APEX_SWE_HARNESS_REVISION,
          apxVersion: "0.0.0-test",
          apxExecutableSha256: "e".repeat(64),
          inspectAiVersion: "0.3.160",
          pythonExecutableSha256: "f".repeat(64),
          timeoutSeconds: 3600,
          timeoutOverride: false,
          resourceOverride: false,
          nTrials: 1,
          messageLimit: 250,
        },
        suite: {
          schema: SUITE_PROTOCOL_SELECTION_SCHEMA,
          protocol: "apex-swe-dev",
          coverage: "full",
          datasetId: APEX_SWE_DEV_DATASET_ID,
          datasetRevision: APEX_SWE_DEV_DATASET_REVISION,
          selectedTaskNames: ["0xobs-00"],
          datasetTaskCount: 1,
          replicates: 1,
          atifRequired: false,
          items: [{ taskName: "0xobs-00", taskSha256: "c".repeat(64), taskType: "observability" }],
        },
      }));
      const selectionManifestSha256 = putSealedBytes(workspaceDir, manifestBytes);
      const closed = readDraftDocument(workspaceDir, "draft-1");
      writeFileSync(draftPath(workspaceDir, "draft-1"), JSON.stringify({
        ...closed,
        spec: {
          ...closed.spec,
          evaluationRuntime: {
            adapterId: APEX_SWE_DEV_ADAPTER_ID,
            selectionManifestSha256,
            isolationPolicy: "unrestricted",
          },
        },
      }, null, 2));

      const outcome = await runReport(contextFor(clock), { draftId: "draft-1" });
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
      if (!outcome.ok) return;

      const reportRecord = parseReport(getSealedBytes(workspaceDir, outcome.result.reportSha256));
      expect(reportRecord.limitations).toContain(APEX_SWE_DEV_NOT_LEADERBOARD_READY_LIMITATION);
      expect(reportRecord.limitations).not.toContain(SUITE_NOT_LEADERBOARD_READY_LIMITATION);
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

  test("a refusal after the bundle is materialized removes the bundle directory it staged", async () => {
    const clock = makeClock();
    await setUpClosedRun(clock);
    expect((await runReport(contextFor(clock), { draftId: "draft-1" })).ok).toBe(true);
    // Refuses after `materializePublicBundle` has already renamed the digest-addressed directory
    // into place and before RunState names it — the window that used to strand a shippable-looking
    // bundle directory from a publication the lifecycle never advanced (issue #3074).
    const refused = await runPublish(contextFor(clock), { draftId: "draft-1" }, {
      beforeRunState: () => { throw new Error("refused after materialization"); },
    });
    expect(refused.ok).toBe(false);
    expect(existsSync(publicBundlesDir(workspaceDir, "draft-1"))
      ? readdirSync(publicBundlesDir(workspaceDir, "draft-1")).filter((name) => /^[a-f0-9]{64}$/u.test(name))
      : []).toHaveLength(0);
    expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("reported");
    expect(readRunState(workspaceDir, "draft-1")?.bundleIdentity).toBeUndefined();
    const retry = await runPublish(contextFor(clock), { draftId: "draft-1" });
    expect(retry.ok, JSON.stringify(retry)).toBe(true);
    expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("published-bundle");
  }, 30_000);

  test("a refusal does not remove a bundle directory a concurrent publisher has already named", async () => {
    const clock = makeClock();
    await setUpClosedRun(clock);
    expect((await runReport(contextFor(clock), { draftId: "draft-1" })).ok).toBe(true);
    // Bundle materialization happens outside the publication lock, so a concurrent publisher of the
    // same draft adopts the byte-identical directory this invocation renamed into place and can go
    // on to name it in RunState. `beforeRunState` stands in for that peer: it makes the directory
    // durable and then refuses this invocation. The cleanup runs under the lock and must skip a
    // directory RunState names (issue #3194).
    const refused = await runPublish(contextFor(clock), { draftId: "draft-1" }, {
      beforeRunState: () => {
        const identity = readdirSync(publicBundlesDir(workspaceDir, "draft-1")).find((name) => /^[a-f0-9]{64}$/u.test(name));
        expect(identity).toBeDefined();
        const state = readRunState(workspaceDir, "draft-1");
        expect(state).toBeDefined();
        if (state === undefined || identity === undefined) return;
        writeRunState(workspaceDir, "draft-1", {
          ...state,
          bundleIdentity: identity,
          bundleRelativePath: `artifacts/draft-1/public-bundles/${identity}`,
        });
        throw new Error("refused after a peer published the same bundle");
      },
    });
    expect(refused.ok).toBe(false);
    const identity = readRunState(workspaceDir, "draft-1")?.bundleIdentity;
    expect(identity).toMatch(/^[a-f0-9]{64}$/);
    if (identity === undefined) return;
    expect(existsSync(publicBundlePath(workspaceDir, "draft-1", identity))).toBe(true);
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
      expect(verified.format).toBe(BUNDLE_FORMAT);
      expect(verified.checks).toEqual([
        "manifest",
        "evidence-closure",
        "trust",
        "matrix-rederivation",
        "report-verification",
        "claim-consistency",
      ]);
      const evidenceCatalog = JSON.parse(readFileSync(join(copied, "evidence.json"), "utf8")) as {
        records: Array<{ sha256: string; roles: string[] }>;
      };
      const pinningRecords = evidenceCatalog.records.filter((record) =>
        record.roles.includes("run-pinning-evidence"));
      // Every proof is bound to its exact accepted solve Submission, so six cells carry six
      // independently reachable evidence identities even though there are only two arm maps.
      expect(pinningRecords).toHaveLength(6);
      for (const record of pinningRecords) {
        expect(existsSync(join(copied, "records", `${record.sha256}.bin`))).toBe(true);
      }
      const assemblyCells = readAssemblyLines(copied).slice(1);
      expect(assemblyCells).toHaveLength(6);
      expect(assemblyCells.every((cell) => typeof cell["pinningEvidenceSha256"] === "string"))
        .toBe(true);
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

  test("verification refuses a canonical v2 bundle relabeled as v3 at the manifest boundary", async () => {
    const clock = makeClock();
    await setUpClosedRun(clock);
    const reported = await runReport(contextFor(clock), { draftId: "draft-1" });
    expect(reported.ok, JSON.stringify(reported)).toBe(true);
    if (!reported.ok) return;
    const runState = readRunState(workspaceDir, "draft-1");
    expect(runState).toBeDefined();
    if (runState === undefined) return;
    const bundleDir = materializePublicBundle({
      workspaceDir,
      draftId: "draft-1",
      benchmarkSha256: reported.result.claimPackage.records.benchmarkSha256,
      runState,
    }).bundleDir;
    const manifestPath = join(bundleDir, "bundle.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { format: string };
    manifest.format = BUNDLE_V3_FORMAT;
    writeCanonical(manifestPath, manifest);

    await expect(verifyPublicBundle(bundleDir)).rejects.toMatchObject({
      issues: [expect.objectContaining({
        path: "bundle.json",
        message: "bundle.json does not satisfy the manifest schema",
      })],
    });
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
    const sourceClaim = JSON.parse(readFileSync(sourceClaimPath, "utf8")) as {
      results: { perSubject: Array<{ results: { arms: Record<string, { passRate: string }> } }> };
    };
    const sourceArmId = Object.keys(sourceClaim.results.perSubject[0]!.results.arms)[0];
    if (sourceArmId === undefined) throw new Error("fixture claim has no arm");
    sourceClaim.results.perSubject[0]!.results.arms[sourceArmId]!.passRate = "0.9998";
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
  }, 60_000);

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

    for (const role of [
      "admission-receipt",
      "run-pinning-evidence",
      "evaluation-submission",
      "solve-output",
    ] as const) {
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

    const swappedPinning = mkdtempSync(join(tmpdir(), "bp40-swapped-pinning-evidence-"));
    try {
      cpSync(base, swappedPinning, { recursive: true });
      const lines = readAssemblyLines(swappedPinning);
      const header = lines[0]! as {
        graph: { solveSubmissions: Array<{ cellKey: string; pinningEvidenceSha256?: string }> };
      };
      const [left, right] = header.graph.solveSubmissions;
      expect(left?.pinningEvidenceSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(right?.pinningEvidenceSha256).toMatch(/^[a-f0-9]{64}$/u);
      if (left?.pinningEvidenceSha256 !== undefined && right?.pinningEvidenceSha256 !== undefined) {
        const leftEvidence = left.pinningEvidenceSha256;
        left.pinningEvidenceSha256 = right.pinningEvidenceSha256;
        right.pinningEvidenceSha256 = leftEvidence;
        const cells = new Map(lines.slice(1).map((line) => [line["cellKey"], line]));
        cells.get(left.cellKey)!["pinningEvidenceSha256"] = left.pinningEvidenceSha256;
        cells.get(right.cellKey)!["pinningEvidenceSha256"] = right.pinningEvidenceSha256;
      }
      writeAssemblyLines(swappedPinning, lines);
      rewriteBundleManifest(swappedPinning);
      await expect(verifyPublicBundle(swappedPinning)).rejects.toMatchObject({
        issues: [expect.objectContaining({ path: "evidence-closure" })],
      });
    } finally {
      rmSync(swappedPinning, { recursive: true, force: true });
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
    const manifest = JSON.parse(readFileSync(join(base, "bundle.json"), "utf8")) as { files: Array<{ path: string }> };
    const manifestPaths = new Set(manifest.files.map((file) => file.path));
    const casPaths = [...manifestPaths].filter((path) => /^records\/[a-f0-9]{64}\.bin$/u.test(path)).sort();
    const reportHtml = readFileSync(join(base, "index.html"), "utf8");
    expect(reportHtml).toContain("What happened, task by task");
    expect(reportHtml).toContain("No comparative winner is stated");
    const renderedLinks = (path: string): string[] => {
      const body = readFileSync(join(base, path), "utf8");
      return [
        ...[...body.matchAll(/href="([^"]+)"/gu)].map((match) => match[1]!),
        ...[...body.matchAll(/\]\(([^)]+)\)/gu)].map((match) => match[1]!),
      ];
    };
    for (const path of ["index.html", "badge.svg", "social-card.svg", "README.md"]) {
      const links = renderedLinks(path);
      for (const link of links) {
        const target = link.split("#")[0]!;
        expect(link, `${path}: ${link}`).not.toMatch(/^(?:[a-z]+:|\/|\\)|(?:^|\/)\.\.(?:\/|$)|\/\//iu);
        expect(manifestPaths.has(target), `${path}: ${link}`).toBe(true);
      }
      if (path === "index.html" || path === "README.md") {
        expect(links.map((link) => link.split("#")[0]!).filter((link) => link.startsWith("records/")).sort()).toEqual(casPaths);
      }
    }
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
  }, 60_000);

  test("rejects an inconsistent stored claim mirror instead of replacing sealed Report facts", async () => {
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
    const copy = mkdtempSync(join(tmpdir(), "bp41-inconsistent-claim-"));
    try {
      cpSync(base, copy, { recursive: true });
      const claimPath = join(copy, "claim-package.json");
      const claim = JSON.parse(readFileSync(claimPath, "utf8")) as {
        headline: Record<string, { passRate: string }>;
      };
      const armId = Object.keys(claim.headline)[0];
      if (armId === undefined) throw new Error("fixture claim has no arm");
      claim.headline[armId]!.passRate = "0.9999";
      writeCanonical(claimPath, claim);
      rewriteBundleManifest(copy);
      await expect(verifyPublicBundle(copy)).rejects.toMatchObject({
        issues: [expect.objectContaining({ path: "claim-consistency" })],
      });
    } finally {
      rmSync(copy, { recursive: true, force: true });
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

describe("packet P5 — pre-registered additional analyses (spec §8.3 option 5)", () => {
  test(
    "one report invocation emits N sealed Reports and one publish invocation emits N bundles, both single-shot; N distinct identities share one runSha256/matrixSha256",
    async () => {
      // Five methods now have a claim-package projection wired on BOTH sides of the mirror seam
      // (`report/claim.ts`'s methodProjection in core, and the same switch in verify's own
      // `profile/claim.ts`): wilson@1, paired-delta@1, binary-instrument@1, and — added by this
      // packet — pairwise-disagreement@1 and paired-majority-delta@1. wilson can never be an
      // additional entry (it is always the primary head). This test stays on paired-delta@1
      // because what it proves is the PACKAGING property (N sealed Reports, N bundles, one shared
      // run/matrix identity), which is method-agnostic by construction and does not depend on
      // which method fills the slot. The two new judge methods carry their own end-to-end
      // cold-verify proof in the sibling test below, which is where their projections are
      // exercised. Real pairing needs task provenance the bundled sample benchmark does
      // not carry (P4b scoping §6.1), so — exactly like the existing "selected paired method" test
      // above — every evaluation is dispatched "no-verdict", which keeps pairing at zero pairs and
      // sidesteps the provenance gap while still exercising the real produceReport() call.
      const clock = makeClock();
      await setUpClosedRun(clock, "draft-1", {
        evaluationModes: Array(8).fill("no-verdict"),
        additionalAnalyses: [
          {
            method: "jinn.benchmarking.method/paired-delta",
            version: "1",
            baseline: "baseline",
            candidate: "sample",
            parameters: { seed: 123456789, resamples: 1000, alpha: "0.05" },
          },
        ],
      });

      // ── report: ONE invocation, N sealed Reports, ONE transition ──────────────────────────
      const reported = await runReport(contextFor(clock), { draftId: "draft-1" });
      expect(reported.ok, JSON.stringify(reported)).toBe(true);
      if (!reported.ok) return;
      expect(reported.result.draft.state).toBe("reported");
      expect(reported.result.additionalReports).toHaveLength(1);

      const reportShas = [reported.result.reportSha256, ...reported.result.additionalReports!.map((entry) => entry.reportSha256)];
      expect(new Set(reportShas).size).toBe(2); // N distinct reportSha256 values
      const reportEnvelopeShas = [reported.result.reportEnvelopeSha256, ...reported.result.additionalReports!.map((entry) => entry.reportEnvelopeSha256)];
      expect(new Set(reportEnvelopeShas).size).toBe(2);

      const stateAfterReport = readRunState(workspaceDir, "draft-1")!;
      expect(stateAfterReport.reportSha256).toBe(reported.result.reportSha256);
      expect(stateAfterReport.additionalReports).toHaveLength(1);
      // Run state carries the N-1 additional identities keyed by (method, version).
      expect(stateAfterReport.additionalReports?.map((entry) => `${entry.method}@${entry.version}`)).toEqual([
        "jinn.benchmarking.method/paired-delta@1",
      ]);

      // Every additional Report has its own Claim, at its own path, distinct from the canonical
      // one.
      const canonicalClaimBytes = readFileSync(claimPackageArtifactPath(workspaceDir, "draft-1"), "utf8");
      for (const entry of stateAfterReport.additionalReports!) {
        const claimPath = additionalClaimPackagePath(workspaceDir, "draft-1", entry.method, entry.version);
        expect(existsSync(claimPath)).toBe(true);
        const claimBytes = readFileSync(claimPath, "utf8");
        expect(claimBytes).not.toBe(canonicalClaimBytes);
        const parsedClaim = JSON.parse(claimBytes) as { records: { reportSha256: string } };
        expect(parsedClaim.records.reportSha256).toBe(entry.reportSha256);
      }

      // A second `report` call still refuses illegal-transition, exactly as before this feature.
      const secondReport = await runReport(contextFor(clock), { draftId: "draft-1" });
      expect(secondReport.ok).toBe(false);
      if (!secondReport.ok) expect(secondReport.error.code).toBe("illegal-transition");

      // ── verify: claim-consistency already resolves by (method, version), so it already works
      // for a Report that is not the last plan entry — no code changed to make this true. ──────
      const verified = await runVerify(contextFor(clock), { draftId: "draft-1" });
      expect(verified.ok, JSON.stringify(verified)).toBe(true);
      if (verified.ok) {
        expect(verified.result.checks).toContain("claim-consistency");
        expect(verified.result.checks).toContain("report-verification");
        expect(verified.result.additionalReports).toHaveLength(1);
      }

      // ── publish: ONE invocation, N bundle directories, ONE transition ─────────────────────
      const published = await runPublish(contextFor(clock), { draftId: "draft-1" });
      expect(published.ok, JSON.stringify(published)).toBe(true);
      if (!published.ok) return;
      expect(published.result.draft.state).toBe("published-bundle");
      expect(published.result.additionalBundles).toHaveLength(1);

      const bundleIdentities = [published.result.bundleIdentity, ...published.result.additionalBundles!.map((entry) => entry.bundleIdentity)];
      expect(new Set(bundleIdentities).size).toBe(2); // N distinct bundle identities

      const stateAfterPublish = readRunState(workspaceDir, "draft-1")!;
      expect(stateAfterPublish.bundleIdentity).toBe(published.result.bundleIdentity);
      expect(stateAfterPublish.additionalBundles).toHaveLength(1);
      expect(stateAfterPublish.additionalBundles?.map((entry) => `${entry.method}@${entry.version}`)).toEqual([
        "jinn.benchmarking.method/paired-delta@1",
      ]);

      // Every bundle — canonical and additional — carries the SAME runSha256/matrixSha256: all N
      // readouts are over the one collected cell set (spec §8.3's decisive disclosure property).
      for (const identity of bundleIdentities) {
        const bundleDir = publicBundlePath(workspaceDir, "draft-1", identity);
        expect(sha256Hex(new Uint8Array(readFileSync(join(bundleDir, "run.json"))))).toBe(stateAfterPublish.runSha256);
        expect(sha256Hex(new Uint8Array(readFileSync(join(bundleDir, "matrix.json"))))).toBe(stateAfterPublish.matrixSha256);
      }

      // A second `publish` call behaves as it does today: idempotent re-verification, identical
      // identities, no state advancement beyond what already happened.
      const secondPublish = await runPublish(contextFor(clock), { draftId: "draft-1" });
      expect(secondPublish.ok, JSON.stringify(secondPublish)).toBe(true);
      if (secondPublish.ok) {
        expect(secondPublish.result.bundleIdentity).toBe(published.result.bundleIdentity);
        expect(secondPublish.result.additionalBundles?.map((entry) => entry.bundleIdentity).sort())
          .toEqual(published.result.additionalBundles!.map((entry) => entry.bundleIdentity).sort());
      }
    },
    30_000,
  );

  // ── Proof 1a (spec §8.3): the N-bundle cold-verify proof ──────────────────────────────────
  //
  // §8.3's entire argument for option 5 over option 4 is that option 5's bundles cold-verify
  // with the already published, unmodified verifier AND the already published
  // `external-verify.py`. The three tests below exercise both readers, assert each bundle's own
  // (non-uniform) format and file list, and give the two-field comparison — the reader-visible
  // substitute for option 4's internal "one cell set" assertion — its own dedicated test.

  const N2_ADDITIONAL_ANALYSES = [
    {
      method: "jinn.benchmarking.method/paired-delta",
      version: "1",
      baseline: "baseline",
      candidate: "sample",
      parameters: { seed: 123456789, resamples: 1000, alpha: "0.05" },
    },
  ] as const;

  test(
    "packet P5 proof 1a: every published bundle verifies with the shipped JS verifier after the source workspace is deleted, each with its own exact format and file list (no numbering scheme, no bundle claiming files it doesn't have)",
    async () => {
      const clock = makeClock();
      await setUpClosedRun(clock, "draft-1", {
        evaluationModes: Array(8).fill("no-verdict"),
        additionalAnalyses: N2_ADDITIONAL_ANALYSES,
      });
      const reported = await runReport(contextFor(clock), { draftId: "draft-1" });
      expect(reported.ok, JSON.stringify(reported)).toBe(true);
      if (!reported.ok) return;
      const published = await runPublish(contextFor(clock), { draftId: "draft-1" });
      expect(published.ok, JSON.stringify(published)).toBe(true);
      if (!published.ok) return;

      const identities = [published.result.bundleIdentity, ...(published.result.additionalBundles ?? []).map((entry) => entry.bundleIdentity)];
      expect(identities).toHaveLength(2);

      const copiedDirs = identities.map((identity) => {
        const copied = mkdtempSync(join(tmpdir(), "bp-p5-cold-js-"));
        cpSync(publicBundlePath(workspaceDir, "draft-1", identity), copied, { recursive: true });
        return { identity, dir: copied };
      });
      try {
        rmSync(workspaceDir, { recursive: true, force: true });
        expect(existsSync(workspaceDir)).toBe(false);

        for (const { identity, dir } of copiedDirs) {
          const verified = await verifyPublicBundle(dir);
          expect(verified.identity).toBe(identity);

          // Per-bundle format and exact file list — derived from THIS bundle's own manifest, not
          // asserted uniform across the N bundles (the bundle format is derived from each
          // Report's own method, and a run can legitimately emit bundles of different formats).
          const manifest = JSON.parse(readFileSync(join(dir, "bundle.json"), "utf8")) as {
            readonly format: string;
            readonly files: ReadonlyArray<{ readonly path: string }>;
          };
          expect(verified.format).toBe(manifest.format);
          expect([BUNDLE_FORMAT, BUNDLE_V4_FORMAT] as readonly string[]).toContain(manifest.format);
          // PUBLIC_BUNDLE_FILES/V4 name the fixed, non-content-addressed members exactly; the
          // remainder of the manifest is exactly the evidence catalog's own `records/<sha256>.bin`
          // entries, never a numbered or otherwise-named extra member.
          const expectedFixed = manifest.format === BUNDLE_V4_FORMAT ? PUBLIC_BUNDLE_V4_FILES : PUBLIC_BUNDLE_FILES;
          const paths = manifest.files.map((file) => file.path);
          const fixedPaths = paths.filter((path) => !path.startsWith("records/"));
          const recordPaths = paths.filter((path) => path.startsWith("records/"));
          expect(fixedPaths.sort()).toEqual([...expectedFixed].sort());
          expect(recordPaths.every((path) => /^records\/[a-f0-9]{64}\.bin$/u.test(path))).toBe(true);
          // No numbering scheme: a second bundle never carries a "report-2.json"-style member.
          expect(paths.some((path) => /report-\d+\.json/u.test(path))).toBe(false);
        }
      } finally {
        for (const { dir } of copiedDirs) rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test.skipIf(!externalVerifyAvailable)(
    "packet P5 proof 1a: the shipped, packaged external-verify.py accepts every published bundle after the source workspace is deleted",
    async () => {
      const clock = makeClock();
      await setUpClosedRun(clock, "draft-1", {
        evaluationModes: Array(8).fill("no-verdict"),
        additionalAnalyses: N2_ADDITIONAL_ANALYSES,
      });
      const reported = await runReport(contextFor(clock), { draftId: "draft-1" });
      expect(reported.ok, JSON.stringify(reported)).toBe(true);
      if (!reported.ok) return;
      const published = await runPublish(contextFor(clock), { draftId: "draft-1" });
      expect(published.ok, JSON.stringify(published)).toBe(true);
      if (!published.ok) return;

      const identities = [published.result.bundleIdentity, ...(published.result.additionalBundles ?? []).map((entry) => entry.bundleIdentity)];
      expect(identities).toHaveLength(2);

      const copiedDirs = identities.map((identity) => {
        const copied = mkdtempSync(join(tmpdir(), "bp-p5-cold-ext-"));
        cpSync(publicBundlePath(workspaceDir, "draft-1", identity), copied, { recursive: true });
        return copied;
      });
      try {
        rmSync(workspaceDir, { recursive: true, force: true });
        expect(existsSync(workspaceDir)).toBe(false);

        for (const dir of copiedDirs) {
          const result = await runExternalVerify(dir);
          assertExternalVerifyAllChecksPass(result);
        }
      } finally {
        for (const dir of copiedDirs) rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test.skipIf(!externalVerifyAvailable)(
    "packet P5 proof 1b: bundles carrying the TWO NEW judge readouts cold-verify with verifyPublicBundle and the packaged external-verify.py after the source workspace is deleted",
    async () => {
      // Why this exists as a sibling of proof 1a rather than an extension of it.
      //
      // Proof 1a runs on `setUpClosedRun`, which pins `prediction-v1-baseline`/`sample-uniform`.
      // That is NOT a binary-judgment run, so it cannot reach either method this packet registers,
      // and 1a therefore only ever exercised methods that were wired before this packet. That is
      // the E-7 mirror seam applied to this packet's own analysis: a claim-package projection lives
      // in TWO files (core's `report/claim.ts` and the standalone verifier's `profile/claim.ts`),
      // publish routes through the verifier's copy (`bundle/verify.ts`), and a proof that never
      // builds a bundle from the new methods cannot see a projection missing from the verifier's
      // half. Two were missing — the claim projection AND the bundle-asset projection — and these
      // bundles did not reach disk at all. A third copy, the portable `assertClaimConsistency`,
      // must also fold PAIRED_ESTIMATE_LIMITATION for paired-majority-delta@1; packaged
      // `external-verify.py` skips `claim-mirror` when there is no headline, so Python alone
      // cannot see that hole. This proof therefore drives BOTH `verifyPublicBundle` and Python.
      //
      // So this proof drives the real binary-judgment lifecycle, registers both new methods as
      // pre-registered additional analyses beside the canonical `binary-instrument@1` entry, and
      // cold-verifies one bundle PER NEW METHOD.
      const fixture = await createSyntheticV4BundleFixture({
        workspaceDir,
        truthAdmission: "operator-only",
        // `paired-majority-delta@1` derives its pair structurally: exactly one evidence-declaring
        // arm, and exactly one arm identical to it once the evidence interpolation is stripped.
        // `withEvidence` is required alongside it — a declaring instrument obliges every bound item
        // to carry evidence (the §2.3 lock-time leak refusal).
        withEvidence: true,
        evidencePair: { declaring: "beta", twin: "alpha" },
        additionalAnalyses: [
          { method: BENCHMARKING_METHOD_IDS.pairwiseDisagreement, version: BENCHMARKING_METHOD_VERSION },
          { method: BENCHMARKING_METHOD_IDS.pairedMajorityDelta, version: BENCHMARKING_METHOD_VERSION },
        ],
      });

      // This direct `materializePublicBundle` call isolates P5's `reportSelector` portable-mirror
      // proof; it is not an official-publication fallback. P8's native-consent rehearsal now
      // exercises real `runPublish` and cold-verifies all three bundles after workspace deletion.
      // This remains a lower-level selector-seam test writing the same canonical public bundle path.
      const runState = readRunState(workspaceDir, fixture.draftId);
      expect(runState).toBeDefined();
      if (runState === undefined) return;

      const newMethods = [
        BENCHMARKING_METHOD_IDS.pairwiseDisagreement,
        BENCHMARKING_METHOD_IDS.pairedMajorityDelta,
      ];
      // Both entries really were sealed into the Run's analysis plan, so the bundles below come
      // from pre-registered readouts rather than from anything this test invented.
      expect((runState.additionalReports ?? []).map((entry) => entry.method).sort())
        .toEqual([...newMethods].sort());

      const copiedByMethod = newMethods.map((method) => {
        const materialized = materializePublicBundle({
          workspaceDir,
          draftId: fixture.draftId,
          benchmarkSha256: fixture.benchmarkSha256,
          runState,
          reportSelector: { method, version: BENCHMARKING_METHOD_VERSION },
        });
        const copied = mkdtempSync(join(tmpdir(), "bp-p5-cold-judge-"));
        cpSync(materialized.bundleDir, copied, { recursive: true });
        return { method, dir: copied, identity: materialized.identity };
      });
      try {
        rmSync(workspaceDir, { recursive: true, force: true });
        expect(existsSync(workspaceDir)).toBe(false);

        for (const { method, dir, identity } of copiedByMethod) {
          const claim = JSON.parse(readFileSync(join(dir, "claim-package.json"), "utf8")) as Record<string, unknown>;
          expect(claim["method"]).toMatchObject({ id: method, version: BENCHMARKING_METHOD_VERSION });
          // The projection the verifier's half of the mirror was missing is present on disk.
          expect(
            method === BENCHMARKING_METHOD_IDS.pairwiseDisagreement
              ? claim["pairwiseDisagreement"]
              : claim["pairedMajorityDelta"],
          ).toBeDefined();
          // JS verifier is the C1 seam (`publish` / `colophon-verify` run this copy). Python is
          // necessary and not sufficient: `claim-mirror` skips when there is no headline.
          const verified = await verifyPublicBundle(dir);
          expect(verified.identity).toBe(identity);
          expect(verified.checks).toContain("claim-consistency");
          assertExternalVerifyAllChecksPass(await runExternalVerify(dir));
        }
      } finally {
        for (const { dir } of copiedByMethod) rmSync(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );

  test(
    "packet P5 proof 1a: THE two-field comparison — N published bundles share exactly one runSha256 and one matrixSha256 while reportSha256 and bundle identity differ (spec §8.3's reader-visible substitute for option 4's internal one-cell-set assertion)",
    async () => {
      const clock = makeClock();
      await setUpClosedRun(clock, "draft-1", {
        evaluationModes: Array(8).fill("no-verdict"),
        additionalAnalyses: N2_ADDITIONAL_ANALYSES,
      });
      const reported = await runReport(contextFor(clock), { draftId: "draft-1" });
      expect(reported.ok, JSON.stringify(reported)).toBe(true);
      if (!reported.ok) return;
      const published = await runPublish(contextFor(clock), { draftId: "draft-1" });
      expect(published.ok, JSON.stringify(published)).toBe(true);
      if (!published.ok) return;

      const identities = [published.result.bundleIdentity, ...(published.result.additionalBundles ?? []).map((entry) => entry.bundleIdentity)];
      expect(identities).toHaveLength(2);
      expect(new Set(identities).size).toBe(2); // bundle identity DIFFERS

      // A reader with only the published bundles reads `claim-package.json` out of each and
      // compares — no workspace, no RunState, nothing internal.
      const claimRecords = identities.map((identity) => {
        const claim = JSON.parse(
          readFileSync(join(publicBundlePath(workspaceDir, "draft-1", identity), "claim-package.json"), "utf8"),
        ) as { readonly records: { readonly runSha256: string; readonly matrixSha256: string; readonly reportSha256: string } };
        return claim.records;
      });

      expect(new Set(claimRecords.map((record) => record.runSha256)).size).toBe(1); // EQUAL
      expect(new Set(claimRecords.map((record) => record.matrixSha256)).size).toBe(1); // EQUAL
      expect(new Set(claimRecords.map((record) => record.reportSha256)).size).toBe(2); // DIFFERS
    },
    30_000,
  );
});
