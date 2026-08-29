// SPDX-License-Identifier: Apache-2.0

/**
 * Packet P8 (#2847): fully synthetic report-shaped judge rehearsal. Production operations only.
 * Bind is the method FILE operand. Export is inspection-upload, never the claim of record.
 */

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  BENCHMARKING_METHOD_IDS,
  BENCHMARKING_METHOD_VERSION,
} from "@jinn-network/benchmarking-records";
import {
  BUNDLE_QUALIFICATION_FORMAT,
  BUNDLE_V4_FORMAT,
  BundleQualificationSchema,
  verifyPublicBundle,
} from "@colophon-claims/check";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { BUNDLE_V4_FORMAT as CORE_BUNDLE_V4_FORMAT, buildBundleManifest } from "../bundle/manifest.js";
import { createSyntheticV4BundleFixture } from "../bundle/testing/v4-synthetic-fixture.js";
import {
  JUDGE_REHEARSAL_ARM_IDS,
  JUDGE_REHEARSAL_CANDIDATE_CLASSES,
  JUDGE_REHEARSAL_EVIDENCE_PAIR,
  JUDGE_REHEARSAL_PARSER_BY_ARM,
  JUDGE_REHEARSAL_STRATA,
  runJudgeRehearsalLifecycle,
} from "../bundle/testing/judge-rehearsal-fixture.js";
import {
  PROMPTED_SCREENING_LIMITATIONS,
  PROMPTED_SCREENING_PROFILE,
} from "../human-review/contracts.js";
import { CERTIFICATION_ACCOUNTING_DIVERGENCE_SENTENCE } from "../runtime/suite-protocol/comparability.js";
import { readRunState } from "../run/state.js";
import { sha256Hex } from "../workspace/sealed-store.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { exportDerivedBundle } from "./method.js";
import { runPublish } from "./publish.js";

const EXTERNAL_VERIFY_SCRIPT = fileURLToPath(
  new URL("../../node_modules/@colophon-claims/check/scripts/external-verify.py", import.meta.url),
);
const EXTERNAL_VERIFY_CHECKS = [
  "manifest-files", "cas-records", "sealed-bytes", "report-signature",
  "report-pins-matrix", "verdict-signatures", "matrix-verdict-closure",
  "claim-mirror", "key-derivations",
] as const;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 120_000);

function json(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
}

function writeCanonical(path: string, value: unknown): void {
  writeFileSync(path, canonicalJsonBytes(value));
}

function probeExternalVerifyAvailable(): boolean {
  const probeDir = mkdtempSync(join(tmpdir(), "bp-p8-extverify-probe-"));
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

function copyBundle(bundleDir: string, label: string): string {
  const copy = mkdtempSync(join(tmpdir(), `judge-p8-tamper-${label}-`));
  roots.push(copy);
  cpSync(bundleDir, copy, { recursive: true });
  return copy;
}

function discardBundleCopy(bundleDir: string): void {
  rmSync(bundleDir, { recursive: true, force: true });
  const index = roots.indexOf(bundleDir);
  if (index !== -1) roots.splice(index, 1);
}

function rewriteManifest(bundleDir: string): void {
  const prior = json(join(bundleDir, "bundle.json"));
  const evidence = json(join(bundleDir, "evidence.json"));
  const paths = new Set<string>((prior.files as Array<{ path: string }>).map((entry) => entry.path)
    .filter((path) => !path.startsWith("records/") && existsSync(join(bundleDir, path))));
  for (const record of evidence.records as Array<{ sha256: string }>) {
    paths.add(`records/${record.sha256}.bin`);
  }
  writeFileSync(
    join(bundleDir, "bundle.json"),
    buildBundleManifest(bundleDir, [...paths], { format: CORE_BUNDLE_V4_FORMAT }).bytes,
  );
}

async function expectRejectedAt(bundleDir: string, path: string): Promise<void> {
  let actual = "";
  try {
    await verifyPublicBundle(bundleDir);
  } catch (cause) {
    actual = (cause as { readonly issues?: readonly { readonly path?: string }[] }).issues?.[0]?.path ?? "";
  }
  expect(actual).toBe(path);
}

function evidenceRecord(evidence: Record<string, any>, role: string): { sha256: string; roles: string[] } {
  const found = (evidence.records as Array<{ sha256: string; roles: string[] }>)
    .find((entry) => entry.roles.includes(role));
  if (found === undefined) throw new Error(`fixture carries no ${role} record`);
  return found;
}

function replaceEvidenceRecord(
  bundleDir: string,
  evidence: Record<string, any>,
  oldSha256: string,
  newBytes: Uint8Array,
): string {
  const records = evidence.records as Array<{ sha256: string; roles: string[] }>;
  const old = records.find((entry) => entry.sha256 === oldSha256);
  if (old === undefined) throw new Error(`evidence has no record ${oldSha256}`);
  const newSha256 = sha256Hex(newBytes);
  writeFileSync(join(bundleDir, "records", `${newSha256}.bin`), newBytes);
  old.sha256 = newSha256;
  if (newSha256 !== oldSha256) rmSync(join(bundleDir, "records", `${oldSha256}.bin`), { force: true });
  records.sort((left, right) => left.sha256 < right.sha256 ? -1 : left.sha256 > right.sha256 ? 1 : 0);
  return newSha256;
}

function readoutName(methodId: string, version: string): string {
  return `${methodId.slice(methodId.lastIndexOf("/") + 1)}@${version}`;
}

function walkTextFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTextFiles(path));
    else out.push(path);
  }
  return out;
}

function licenseScan(bundleDir: string, workspaceDir: string): void {
  for (const path of walkTextFiles(bundleDir)) {
    const bytes = readFileSync(path);
    if (bytes.includes(0)) continue;
    const text = bytes.toString("utf8");
    expect(text.includes(workspaceDir), path).toBe(false);
    expect(text, path).not.toMatch(/LoCoMo|licensed benchmark|api[_-]?key/iu);
  }
}

describe("packet P8 judge rehearsal (#2847)", () => {
  test("an existing four-arm two-stratum qualification bundle still cold-verifies with armCount 4 and the current qualification format", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "judge-p8-four-arm-"));
    roots.push(workspaceDir);
    const fixture = await createSyntheticV4BundleFixture({
      workspaceDir,
      truthAdmission: "operator-only",
    });
    const copied = mkdtempSync(join(tmpdir(), "judge-p8-four-arm-cold-"));
    roots.push(copied);
    cpSync(fixture.bundle.bundleDir, copied, { recursive: true });
    rmSync(workspaceDir, { recursive: true, force: true });
    expect(existsSync(workspaceDir)).toBe(false);

    const verified = await verifyPublicBundle(copied);
    expect(verified.format).toBe(BUNDLE_V4_FORMAT);
    if (verified.format !== BUNDLE_V4_FORMAT || verified.qualification === undefined) throw new Error("expected V4 qualification bundle");
    expect(verified.qualification.armCount).toBe(4);
    expect(verified.qualification.strata).toEqual(["core", "stress"]);

    const qualification = BundleQualificationSchema.parse(json(join(copied, "qualification.json")));
    expect(qualification.format).toBe(BUNDLE_QUALIFICATION_FORMAT);
    expect(qualification.format).toBe("benchmark-product-binary-qualification/1");
    expect(qualification.arms).toHaveLength(4);
  }, 120_000);

  test("drives the six-arm synthetic freeze path through publish, three-bundle cold verify, export, P7 partial, and the marked headline analogs", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "judge-p8-rehearsal-"));
    roots.push(workspaceDir);
    const fixture = await runJudgeRehearsalLifecycle({ workspaceDir });
    const context: OperationContext = fixture.context;

    expect([...JUDGE_REHEARSAL_ARM_IDS]).toEqual(["alpha", "beta", "delta", "epsilon", "gamma", "zeta"]);
    expect(JUDGE_REHEARSAL_PARSER_BY_ARM.alpha.id).toBe(JUDGE_REHEARSAL_PARSER_BY_ARM.beta.id);
    expect(new Set(Object.values(JUDGE_REHEARSAL_PARSER_BY_ARM).map((parser) => parser.id)).size).toBe(5);
    expect(JUDGE_REHEARSAL_CANDIDATE_CLASSES).toHaveLength(3);
    expect(JUDGE_REHEARSAL_STRATA).toHaveLength(4);
    expect(fixture.gateProbeItemIds).toHaveLength(12);
    expect(fixture.corruptKeyItemIds).toHaveLength(2);
    expect(fixture.instrumentSha256s).toHaveLength(6);

    expect(fixture.matrix.completeness.runOutcome).toBe("partial");
    expect(fixture.matrix.completeness.judged).toBeLessThan(fixture.matrix.completeness.expected);
    const couldNotGrade = fixture.journalEntries.filter((entry) =>
      entry.kind === "evaluation" && entry.evaluationTerminal === "could-not-grade",
    );
    expect(couldNotGrade.length).toBeGreaterThanOrEqual(1);
    expect(couldNotGrade.some((entry) =>
      "failureCategory" in entry && entry.failureCategory === "dependency-unavailable",
    )).toBe(true);
    expect(fixture.journalEntries.some((entry) => entry.kind === "evaluation-retryable-failure")).toBe(true);

    const exported = exportDerivedBundle(context, { draftId: fixture.draftId, armId: "alpha" });
    expect(exported.ok, JSON.stringify(exported)).toBe(true);
    if (!exported.ok) return;
    if (exported.result.shape !== "inspect-view") {
      throw new Error(`expected inspect-view export, got ${exported.result.shape}`);
    }
    expect(exported.result.mode).toBe("inspection-upload");
    expect(exported.result.instructions.split("\n")[0]).toContain(fixture.matrix.completeness.runOutcome);
    expect(exported.result.instructions.split("\n")[0]).toContain(`${fixture.matrix.completeness.judged} of ${fixture.matrix.completeness.expected} cells judged`);
    expect(exported.result.instructions).not.toContain(CERTIFICATION_ACCOUNTING_DIVERGENCE_SENTENCE);
    expect(exported.result.instructions).toContain("Do not treat this package as an Inspect Hub row or as the Colophon claim of record.");

    const refused = await runPublish(context, { draftId: fixture.draftId });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("validation");
    expect(refused.error.issues?.[0]?.path).toBe("includeNativeArtifacts");

    const published = await runPublish(context, { draftId: fixture.draftId, includeNativeArtifacts: true });
    expect(published.ok, JSON.stringify(published)).toBe(true);
    if (!published.ok) return;
    expect(published.result.draft.state).toBe("published-bundle");
    expect(published.result.additionalBundles).toHaveLength(2);

    const publishedBundles = [
      {
        method: BENCHMARKING_METHOD_IDS.binaryInstrument,
        version: BENCHMARKING_METHOD_VERSION,
        identity: published.result.bundleIdentity,
        relativePath: published.result.bundleRelativePath,
        checks: published.result.checks,
      },
      ...(published.result.additionalBundles ?? []).map((entry) => ({
        method: entry.method,
        version: entry.version,
        identity: entry.bundleIdentity,
        relativePath: entry.bundleRelativePath,
        checks: entry.checks,
      })),
    ].map((bundle) => ({ ...bundle, dir: join(workspaceDir, bundle.relativePath) }));
    expect(publishedBundles).toHaveLength(3);
    expect(publishedBundles.map((bundle) => `${bundle.method}@${bundle.version}`).sort()).toEqual([
      "jinn.benchmarking.method/binary-instrument@1",
      "jinn.benchmarking.method/paired-majority-delta@1",
      "jinn.benchmarking.method/pairwise-disagreement@1",
    ]);
    expect(new Set(publishedBundles.map((bundle) => bundle.identity)).size).toBe(3);
    for (const bundle of publishedBundles) {
      expect(bundle.identity).toMatch(/^[a-f0-9]{64}$/u);
      expect(bundle.relativePath).toBe(`artifacts/${fixture.draftId}/public-bundles/${bundle.identity}`);
      expect(bundle.checks).toEqual(expect.arrayContaining([
        "manifest",
        "evidence-closure",
        "trust",
        "matrix-rederivation",
        "report-verification",
        "claim-consistency",
      ]));
    }

    expect(readDraftDocument(workspaceDir, fixture.draftId).state).toBe("published-bundle");
    const runState = readRunState(workspaceDir, fixture.draftId);
    expect(runState).toBeDefined();
    if (runState === undefined) return;
    expect(runState.bundleIdentity).toBe(published.result.bundleIdentity);
    expect(runState.bundleRelativePath).toBe(published.result.bundleRelativePath);
    expect(runState.bundleChecks).toEqual(published.result.checks);
    expect(runState.additionalBundles).toEqual((published.result.additionalBundles ?? []).map((entry) => ({
      method: entry.method,
      version: entry.version,
      bundleIdentity: entry.bundleIdentity,
      bundleRelativePath: entry.bundleRelativePath,
      bundleChecks: [...entry.checks],
    })));
    expect(runState.publishedAt).toBeDefined();

    const copied = publishedBundles.map((bundle) => {
      const dir = mkdtempSync(join(tmpdir(), "judge-p8-cold-"));
      roots.push(dir);
      cpSync(bundle.dir, dir, { recursive: true });
      return { ...bundle, dir };
    });

    const primary = copied.find((bundle) => bundle.method === BENCHMARKING_METHOD_IDS.binaryInstrument)!;
    licenseScan(primary.dir, workspaceDir);

    rmSync(workspaceDir, { recursive: true, force: true });
    expect(existsSync(workspaceDir)).toBe(false);

    for (const bundle of copied) {
      const verified = await verifyPublicBundle(bundle.dir);
      expect(verified.checks).toContain("claim-consistency");
      if (bundle.method === BENCHMARKING_METHOD_IDS.binaryInstrument) {
        expect(verified.format).toBe(BUNDLE_V4_FORMAT);
        if (verified.format !== BUNDLE_V4_FORMAT || verified.qualification === undefined) throw new Error("primary rehearsal bundle must stay on the V4 qualification path");
        expect(verified.qualification.armCount).toBe(6);
        expect(verified.qualification.truthAdmission).toBe("screened-operator-sampled");
        expect(verified.qualification.exclusionCount).toBe(1);
        expect(verified.qualification.candidateClasses).toEqual([...JUDGE_REHEARSAL_CANDIDATE_CLASSES]);
      }
      if (externalVerifyAvailable) {
        assertExternalVerifyAllChecksPass(await runExternalVerify(bundle.dir));
      }
    }

    const claims = copied.map((bundle) => json(join(bundle.dir, "claim-package.json")));
    const records = claims.map((claim) => claim.records as {
      readonly runSha256: string;
      readonly matrixSha256: string;
      readonly reportSha256: string;
    });
    expect(new Set(records.map((record) => record.runSha256)).size).toBe(1);
    expect(new Set(records.map((record) => record.matrixSha256)).size).toBe(1);
    expect(new Set(records.map((record) => record.reportSha256)).size).toBe(3);
    expect(records[0]!.runSha256).toBe(fixture.runSha256);
    expect(records[0]!.matrixSha256).toBe(fixture.matrixSha256);
    for (const claim of claims) {
      expect(claim.verification.command).toBe("npx @colophon-claims/verify@0.2.1 <bundle-dir>");
      expect(claim.verification.compatibleCommand).toBe("npx @colophon-claims/verify@0.2 <bundle-dir>");
    }

    const readoutNames = [...claims.map((claim) => readoutName(String(claim.method.id), String(claim.method.version)))].sort();
    expect(readoutNames).toEqual([
      "binary-instrument@1",
      "paired-majority-delta@1",
      "pairwise-disagreement@1",
    ]);
    const publishedText = copied.flatMap((bundle) => walkTextFiles(bundle.dir).map((path) => readFileSync(path, "utf8"))).join("\n");
    expect(publishedText).not.toMatch(/jinn\.benchmarking\.method\/paired-delta(?!-majority)/u);
    expect(publishedText).not.toContain("paired-delta@1");
    expect(publishedText).not.toContain("bind-judge");
    expect(publishedText).not.toContain("method compute");

    const primaryClaim = claims.find((claim) => claim.method.id === BENCHMARKING_METHOD_IDS.binaryInstrument)!;
    const pairwiseClaim = claims.find((claim) => claim.method.id === BENCHMARKING_METHOD_IDS.pairwiseDisagreement)!;
    const deltaClaim = claims.find((claim) => claim.method.id === BENCHMARKING_METHOD_IDS.pairedMajorityDelta)!;
    const qualification = primaryClaim.qualification as Record<string, any>;
    const primaryRun = json(join(primary.dir, "run.json"));
    const primaryAnalysis = (primaryRun.analysisPlan as Array<Record<string, any>>)
      .find((analysis) => analysis.method === BENCHMARKING_METHOD_IDS.binaryInstrument);
    expect(primaryAnalysis?.parameters.promptedScreeningProfile).toBe(PROMPTED_SCREENING_PROFILE);
    const primaryReport = json(join(primary.dir, "report.json"));
    expect(primaryReport.limitations).toEqual(expect.arrayContaining([...PROMPTED_SCREENING_LIMITATIONS]));
    // Registry-verified vs sealed-companion is the rehearsal's classification of those analogs (corrupt-key and twelve-probe are §7.3 companions; the rest are registered-method outputs); R1 (#2849) is the column renderer. The sealed claim package does not carry that column.
    const marked = [
      { name: "per-arm false-accept", value: qualification.arms.alpha.falseAccept },
      { name: "per-arm false-reject", value: qualification.arms.alpha.falseReject },
      { name: "per-class correct", value: qualification.arms.alpha.byCandidateClass.correct },
      { name: "per-stratum category-1", value: qualification.arms.alpha.byStratum["category-1"] },
      { name: "instability", value: qualification.arms.delta.instability },
      { name: "parser-invalid", value: qualification.arms.gamma.parserInvalid },
      { name: "cross-arm disagreement", value: pairwiseClaim.pairwiseDisagreement },
      { name: "evidence contrast", value: deltaClaim.pairedMajorityDelta },
    ] as const;
    for (const analog of marked) {
      expect(analog.value, analog.name).toBeDefined();
    }
    expect(deltaClaim.pairedMajorityDelta.candidate).toBe(JUDGE_REHEARSAL_EVIDENCE_PAIR.declaring);
    expect(deltaClaim.pairedMajorityDelta.baseline).toBe(JUDGE_REHEARSAL_EVIDENCE_PAIR.twin);

    const evidence = json(join(primary.dir, "evidence.json"));
    const probe = evidenceRecord(evidence, "snapshot-probe");
    expect(existsSync(join(primary.dir, "records", `${probe.sha256}.bin`))).toBe(true);
    const promptRecord = evidenceRecord(evidence, "screening-prompt");
    const procedureRecord = evidenceRecord(evidence, "screening-procedure");
    const poolRecord = evidenceRecord(evidence, "screening-pool");
    const commitmentRecord = evidenceRecord(evidence, "screening-sample-commitment");
    const samplingScriptRecord = evidenceRecord(evidence, "screening-sampling-script");
    const transcriptRecord = evidenceRecord(evidence, "screening-transcript");
    expect(promptRecord.sha256).toBe(fixture.screeningRecords.promptSha256.slice("sha256:".length));
    expect(procedureRecord.sha256).toBe(fixture.screeningRecords.procedureSha256.slice("sha256:".length));
    expect(poolRecord.sha256).toBe(fixture.screeningRecords.poolSha256.slice("sha256:".length));
    expect(commitmentRecord.sha256).toBe(fixture.screeningRecords.sampleCommitmentSha256.slice("sha256:".length));
    expect(samplingScriptRecord.sha256).toBe(fixture.screeningRecords.samplingScriptSha256.slice("sha256:".length));
    expect(transcriptRecord.sha256).toBe(fixture.screeningRecords.transcriptSha256.slice("sha256:".length));
    for (const digest of Object.values(fixture.screeningRecords)) expect(fixture.instrumentSha256s).not.toContain(digest);
    expect(readFileSync(join(primary.dir, "records", `${samplingScriptRecord.sha256}.bin`)))
      .toEqual(Buffer.from("judge-rehearsal-sampling-script/v1"));
    expect(readFileSync(join(primary.dir, "records", `${transcriptRecord.sha256}.bin`)))
      .toEqual(Buffer.from([0, 255, 1, 254, 2, 253]));
    const nativeDir = join(primary.dir, "native", "inspect");
    expect(existsSync(nativeDir)).toBe(true);
    expect(readdirSync(nativeDir).some((name) => name.endsWith(".eval"))).toBe(true);

    const executionTamper = copyBundle(primary.dir, "execution");
    const executionEvidence = json(join(executionTamper, "evidence.json"));
    const selectionRecord = evidenceRecord(executionEvidence, "runtime-selection");
    const selection = json(join(executionTamper, "records", `${selectionRecord.sha256}.bin`));
    selection.runtime.imageDigest = `sha256:${"e".repeat(64)}`;
    replaceEvidenceRecord(executionTamper, executionEvidence, selectionRecord.sha256, canonicalJsonBytes(selection));
    writeCanonical(join(executionTamper, "evidence.json"), executionEvidence);
    rewriteManifest(executionTamper);
    await expectRejectedAt(executionTamper, "evidence-closure");
    discardBundleCopy(executionTamper);

    const truthTamper = copyBundle(primary.dir, "truth");
    const truthEvidence = json(join(truthTamper, "evidence.json"));
    const resolution = evidenceRecord(truthEvidence, "label-resolution");
    const resolutionBytes = JSON.parse(readFileSync(join(truthTamper, "records", `${resolution.sha256}.bin`), "utf8")) as Record<string, any>;
    resolutionBytes.tampered = true;
    replaceEvidenceRecord(truthTamper, truthEvidence, resolution.sha256, canonicalJsonBytes(resolutionBytes));
    writeCanonical(join(truthTamper, "evidence.json"), truthEvidence);
    rewriteManifest(truthTamper);
    await expectRejectedAt(truthTamper, "evidence-closure");
    discardBundleCopy(truthTamper);

    for (const role of [
      "screening-prompt", "screening-procedure", "screening-pool", "screening-sample-commitment",
      "screening-sampling-script", "screening-transcript", "screening-table", "screening-reveal-receipt",
    ]) {
      const nestedTamper = copyBundle(primary.dir, role);
      const nestedEvidence = json(join(nestedTamper, "evidence.json"));
      const nestedRecord = evidenceRecord(nestedEvidence, role);
      const original = readFileSync(join(nestedTamper, "records", `${nestedRecord.sha256}.bin`));
      replaceEvidenceRecord(
        nestedTamper,
        nestedEvidence,
        nestedRecord.sha256,
        new Uint8Array([...original, 0]),
      );
      writeCanonical(join(nestedTamper, "evidence.json"), nestedEvidence);
      rewriteManifest(nestedTamper);
      await expectRejectedAt(nestedTamper, "evidence-closure");
      discardBundleCopy(nestedTamper);
    }

    const roleTamper = copyBundle(primary.dir, "screening-role");
    const roleEvidence = json(join(roleTamper, "evidence.json"));
    evidenceRecord(roleEvidence, "screening-prompt").roles = ["screening-transcript"];
    writeCanonical(join(roleTamper, "evidence.json"), roleEvidence);
    rewriteManifest(roleTamper);
    await expectRejectedAt(roleTamper, "evidence-closure");
    discardBundleCopy(roleTamper);

    for (const [label, mutate] of [
      ["screening-decision", (row: Record<string, any>) => { row.ritsuDecision.verdict = "exclude"; }],
      ["screening-timestamp", (row: Record<string, any>) => { row.ritsuDecision.decidedAt = "2026-08-20T09:00:01.000Z"; }],
    ] as const) {
      const tableTamper = copyBundle(primary.dir, label);
      const tableEvidence = json(join(tableTamper, "evidence.json"));
      const tableRecord = evidenceRecord(tableEvidence, "screening-table");
      const envelope = json(join(tableTamper, "records", `${tableRecord.sha256}.bin`));
      const payload = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")) as Record<string, any>;
      const confirmedRow = (payload.rows as Array<Record<string, any>>)
        .find((row) => row.ritsuDecision?.verdict === "confirm");
      expect(confirmedRow).toBeDefined();
      mutate(confirmedRow!);
      envelope.payload = Buffer.from(canonicalJsonBytes(payload)).toString("base64");
      replaceEvidenceRecord(tableTamper, tableEvidence, tableRecord.sha256, canonicalJsonBytes(envelope));
      writeCanonical(join(tableTamper, "evidence.json"), tableEvidence);
      rewriteManifest(tableTamper);
      await expectRejectedAt(tableTamper, "evidence-closure");
      discardBundleCopy(tableTamper);
    }

    const metricTamper = copyBundle(primary.dir, "metric");
    const report = json(join(metricTamper, "report.json"));
    report.tamperedMetric = true;
    writeCanonical(join(metricTamper, "report.json"), report);
    rewriteManifest(metricTamper);
    await expectRejectedAt(metricTamper, "evidence-closure");
    discardBundleCopy(metricTamper);

    const claimTamper = copyBundle(primary.dir, "claim");
    const claimDoc = json(join(claimTamper, "claim-package.json"));
    claimDoc.records.reportSha256 = "a".repeat(64);
    writeCanonical(join(claimTamper, "claim-package.json"), claimDoc);
    rewriteManifest(claimTamper);
    await expectRejectedAt(claimTamper, "claim-consistency");
    discardBundleCopy(claimTamper);

    const assetTamper = copyBundle(primary.dir, "asset");
    const evalName = readdirSync(join(assetTamper, "native", "inspect")).find((name) => name.endsWith(".eval"));
    expect(evalName).toBeDefined();
    writeFileSync(join(assetTamper, "native", "inspect", evalName!), "tampered-native-eval-bytes");
    rewriteManifest(assetTamper);
    let assetPath = "";
    try {
      await verifyPublicBundle(assetTamper);
    } catch (cause) {
      assetPath = (cause as { readonly issues?: readonly { readonly path?: string }[] }).issues?.[0]?.path ?? "";
    }
    expect(assetPath).toMatch(/^native\/inspect\/[a-f0-9]{64}\.eval$/u);
    discardBundleCopy(assetTamper);
  }, 7_200_000);
});
