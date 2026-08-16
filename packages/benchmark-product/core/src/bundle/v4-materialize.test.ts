// SPDX-License-Identifier: Apache-2.0

import { generateKeyPairSync } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  BENCHMARKING_METHOD_IDS,
  BENCHMARKING_METHOD_VERSION,
  parseMatrix,
  parseReport,
} from "@jinn-network/benchmarking-records";
import { exportStaticBundle } from "@jinn-network/benchmarking-interop";
import { verifyPublicBundle } from "@colophon-claims/verify";
import {
  canonicalJsonBytes,
  dssePreAuthEncoding,
  parseExactDsseEnvelope,
  sealDsseEnvelope,
} from "@jinn-network/trust-core";
import { sha256Hex } from "../workspace/sealed-store.js";
import { didKeyFromEd25519PublicKey, loadOrCreateReportSigningKey } from "../report/signing.js";
import {
  createVerdictDsseSigner,
  loadOrCreateEvaluatorSigningKeys,
  sealVerdictStatement,
  verdictKeyIdFromEd25519PublicKey,
} from "../venue/signing.js";
import { INSPECT_EMBEDDED_EVALUATOR_ID } from "../runtime/inspect/artifacts.js";
import {
  BUNDLE_V4_EVIDENCE_FORMAT,
  BUNDLE_V4_TRUST_FORMAT,
} from "./schema.js";
import { BUNDLE_V4_FORMAT, buildBundleManifest } from "./manifest.js";
import {
  createSyntheticV4BundleFixture,
  type SyntheticV4BundleFixture,
  type SyntheticV4IntakeBytes,
  type SyntheticV4TruthAdmission,
} from "./testing/v4-synthetic-fixture.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function json(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
}

function writeCanonical(path: string, value: unknown): void {
  writeFileSync(path, canonicalJsonBytes(value));
}

function copyBundle(bundleDir: string, label: string): string {
  const copy = mkdtempSync(join(tmpdir(), `binary-v4-tamper-${label}-`));
  roots.push(copy);
  cpSync(bundleDir, copy, { recursive: true });
  return copy;
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
    buildBundleManifest(bundleDir, [...paths], { format: BUNDLE_V4_FORMAT }).bytes,
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
  options: { readonly keepOld?: boolean } = {},
): string {
  const records = evidence.records as Array<{ sha256: string; roles: string[] }>;
  const old = records.find((entry) => entry.sha256 === oldSha256);
  if (old === undefined) throw new Error(`evidence has no record ${oldSha256}`);
  const newSha256 = sha256Hex(newBytes);
  writeFileSync(join(bundleDir, "records", `${newSha256}.bin`), newBytes);
  if (options.keepOld === true) {
    const existing = records.find((entry) => entry.sha256 === newSha256);
    if (existing === undefined) records.push({ sha256: newSha256, roles: [...old.roles] });
  } else {
    old.sha256 = newSha256;
    if (newSha256 !== oldSha256) rmSync(join(bundleDir, "records", `${oldSha256}.bin`), { force: true });
  }
  records.sort((left, right) => left.sha256 < right.sha256 ? -1 : left.sha256 > right.sha256 ? 1 : 0);
  return newSha256;
}

function canonicalJsonlMutation(
  source: string,
  rowIndex: number,
  mutate: (row: Record<string, any>) => void,
): string {
  const rows = source.trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
  mutate(rows[rowIndex]!);
  return `${rows.map((row) => Buffer.from(canonicalJsonBytes(row)).toString("utf8")).join("\n")}\n`;
}

function replaceDigest(value: any, oldSha256: string, newSha256: string): any {
  if (value === oldSha256) return newSha256;
  if (value === `sha256:${oldSha256}`) return `sha256:${newSha256}`;
  if (Array.isArray(value)) return value.map((entry) => replaceDigest(entry, oldSha256, newSha256));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replaceDigest(entry, oldSha256, newSha256)]));
  }
  return value;
}

function readAssembly(bundleDir: string): Array<Record<string, any>> {
  return readFileSync(join(bundleDir, "verification", "assembly.jsonl"), "utf8")
    .trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
}

function writeAssembly(bundleDir: string, lines: readonly Record<string, any>[]): void {
  writeFileSync(
    join(bundleDir, "verification", "assembly.jsonl"),
    `${lines.map((line) => Buffer.from(canonicalJsonBytes(line)).toString("utf8")).join("\n")}\n`,
  );
}

function replaceDigests(value: any, replacements: readonly (readonly [string, string])[]): any {
  return replacements.reduce((current, [oldSha256, newSha256]) =>
    replaceDigest(current, oldSha256, newSha256), value);
}

async function authenticatedSolveArtifactTamper(
  fixture: SyntheticV4BundleFixture,
  kind: "response" | "observation",
): Promise<string> {
  const bundleDir = copyBundle(fixture.bundle.bundleDir, `authenticated-${kind}`);
  const evidence = json(join(bundleDir, "evidence.json"));
  const assembly = readAssembly(bundleDir);
  const header = assembly[0]!;
  const cellIndex = assembly.findIndex((line) => line.kind === "cell");
  const cell = assembly[cellIndex]!;
  const cellKey = cell.cellKey as string;
  const deliverySha256 = cell.deliverySha256 as string;
  const verdictSha256 = cell.verdicts[0].sha256 as string;
  const responseOutput = (cell.solveOutputs as Array<{ name: string; sha256: string }>)
    .find((entry) => entry.name === "judge-response")!;
  const observationOutput = (cell.solveOutputs as Array<{ name: string; sha256: string }>)
    .find((entry) => entry.name === "judge-observation")!;
  const oldResponseSha256 = responseOutput.sha256;
  const oldObservationSha256 = observationOutput.sha256;

  const oldResponseBytes = new Uint8Array(readFileSync(join(bundleDir, "records", `${oldResponseSha256}.bin`)));
  const newResponseBytes = kind === "response" ? new TextEncoder().encode("REJECT") : oldResponseBytes;
  const newResponseSha256 = sha256Hex(newResponseBytes);
  const observation = json(join(bundleDir, "records", `${oldObservationSha256}.bin`));
  if (kind === "response") {
    observation.response.digest = `sha256:${newResponseSha256}`;
  } else {
    observation.armId = observation.armId === "alpha" ? "beta" : "alpha";
  }
  const newObservationBytes = canonicalJsonBytes(observation);
  const newObservationSha256 = sha256Hex(newObservationBytes);

  const delivery = json(join(bundleDir, "records", `${deliverySha256}.bin`));
  for (const output of delivery.outputs as Array<Record<string, any>>) {
    if (output.name === "judge-response") output.digest.sha256 = newResponseSha256;
    if (output.name === "judge-observation") output.digest.sha256 = newObservationSha256;
  }
  const newDeliveryBytes = canonicalJsonBytes(delivery);
  const newDeliverySha256 = sha256Hex(newDeliveryBytes);

  const oldVerdictBytes = new Uint8Array(readFileSync(join(bundleDir, "records", `${verdictSha256}.bin`)));
  const oldVerdictEnvelope = parseExactDsseEnvelope(oldVerdictBytes);
  const statement = JSON.parse(Buffer.from(oldVerdictEnvelope.payloadBytes).toString("utf8"));
  const rewrittenStatement = replaceDigests(statement, [
    [oldResponseSha256, newResponseSha256],
    [oldObservationSha256, newObservationSha256],
  ]);
  const evaluatorId = cell.verdicts[0].evaluator as string;
  expect(evaluatorId).toBe(INSPECT_EMBEDDED_EVALUATOR_ID);
  const [{ key }] = loadOrCreateEvaluatorSigningKeys(fixture.workspaceDir, [{ id: evaluatorId }]);
  const newVerdictBytes = await sealVerdictStatement({
    statementBytes: canonicalJsonBytes(rewrittenStatement),
    evaluatorId,
    expectedEvaluationSpecificationSha256: cell.verdicts[0].evaluationSpecSha256,
    signer: createVerdictDsseSigner(key),
  });
  const newVerdictSha256 = sha256Hex(newVerdictBytes);

  if (newResponseSha256 !== oldResponseSha256) {
    replaceEvidenceRecord(bundleDir, evidence, oldResponseSha256, newResponseBytes, { keepOld: true });
  }
  replaceEvidenceRecord(bundleDir, evidence, oldObservationSha256, newObservationBytes);
  replaceEvidenceRecord(bundleDir, evidence, deliverySha256, newDeliveryBytes);
  replaceEvidenceRecord(bundleDir, evidence, verdictSha256, newVerdictBytes);
  writeCanonical(join(bundleDir, "evidence.json"), evidence);

  const replacements = [
    [oldResponseSha256, newResponseSha256],
    [oldObservationSha256, newObservationSha256],
    [deliverySha256, newDeliverySha256],
    [verdictSha256, newVerdictSha256],
  ] as const;
  const solveDeliveryIndex = (header.graph.solveDeliveries as Array<Record<string, any>>)
    .findIndex((edge) => edge.cellKey === cellKey);
  header.graph.solveDeliveries[solveDeliveryIndex] = replaceDigests(
    header.graph.solveDeliveries[solveDeliveryIndex],
    replacements,
  );
  const evaluationIndex = (header.graph.evaluations as Array<Record<string, any>>)
    .findIndex((edge) => edge.cellKey === cellKey && edge.verdictSha256 === verdictSha256);
  header.graph.evaluations[evaluationIndex] = replaceDigests(
    header.graph.evaluations[evaluationIndex],
    replacements,
  );
  assembly[cellIndex] = replaceDigests(cell, replacements);
  writeAssembly(bundleDir, assembly);

  const catalog = json(join(bundleDir, "verdicts.json"));
  const catalogEntry = (catalog.verdicts as Array<Record<string, any>>)
    .find((entry) => entry.sha256 === verdictSha256)!;
  catalogEntry.sha256 = newVerdictSha256;
  (catalog.verdicts as Array<Record<string, any>>).sort((left, right) =>
    left.sha256 < right.sha256 ? -1 : left.sha256 > right.sha256 ? 1 : 0);
  writeCanonical(join(bundleDir, "verdicts.json"), catalog);

  const matrix = json(join(bundleDir, "matrix.json"));
  const matrixCellIndex = (matrix.cells as Array<Record<string, any>>)
    .findIndex((entry) => entry.cellKey === cellKey);
  matrix.cells[matrixCellIndex] = replaceDigests(matrix.cells[matrixCellIndex], replacements);
  const matrixBytes = canonicalJsonBytes(matrix);
  parseMatrix(matrixBytes);
  const oldMatrixSha256 = sha256Hex(readFileSync(join(bundleDir, "matrix.json")));
  const newMatrixSha256 = sha256Hex(matrixBytes);
  writeFileSync(join(bundleDir, "matrix.json"), matrixBytes);

  const report = replaceDigest(json(join(bundleDir, "report.json")), oldMatrixSha256, newMatrixSha256);
  const reportBytes = canonicalJsonBytes(report);
  parseReport(reportBytes);
  writeFileSync(join(bundleDir, "report.json"), reportBytes);
  const reportKey = loadOrCreateReportSigningKey(fixture.workspaceDir);
  const oldReportEnvelope = parseExactDsseEnvelope(readFileSync(join(bundleDir, "report-envelope.json")));
  const reportPreAuth = dssePreAuthEncoding(oldReportEnvelope.payloadType, reportBytes);
  writeFileSync(join(bundleDir, "report-envelope.json"), sealDsseEnvelope({
    payloadType: oldReportEnvelope.payloadType,
    payloadBytes: reportBytes,
    signatures: [{ keyid: reportKey.keyId, signature: reportKey.sign(reportPreAuth) }],
  }));
  writeCanonical(
    join(bundleDir, "static-bundle.json"),
    exportStaticBundle(parseMatrix(matrixBytes), [parseReport(reportBytes)]),
  );
  rewriteManifest(bundleDir);
  return bundleDir;
}

describe("binary public-bundle/4 producer closure", () => {
  test.each([
    ["operator-only", false],
    ["two-human-unanimous", true],
  ] as const)("materializes a complete provider-free %s admission graph", async (truthAdmission, publicationGrade) => {
    const root = mkdtempSync(join(tmpdir(), `binary-v4-${truthAdmission}-`));
    roots.push(root);
    const fixture = await createSyntheticV4BundleFixture({ workspaceDir: root, truthAdmission });
    const bundleDir = fixture.bundle.bundleDir;
    const manifest = json(join(bundleDir, "bundle.json"));
    const qualification = json(join(bundleDir, "qualification.json"));
    const evidence = json(join(bundleDir, "evidence.json"));
    const trust = json(join(bundleDir, "trust", "public-keys.json"));
    const claim = json(join(bundleDir, "claim-package.json"));

    expect(manifest.format).toBe(BUNDLE_V4_FORMAT);
    expect(manifest.files.map((file: { path: string }) => file.path)).toContain("qualification.json");
    for (const file of manifest.files as Array<{ path: string; sha256: string; bytes: number }>) {
      const bytes = readFileSync(join(bundleDir, file.path));
      expect(bytes.byteLength, file.path).toBe(file.bytes);
      expect(sha256Hex(bytes), file.path).toBe(file.sha256);
    }

    expect(claim).toMatchObject({
      claimSchema: "benchmark-product.claim-package/2",
      method: { id: BENCHMARKING_METHOD_IDS.binaryInstrument, version: BENCHMARKING_METHOD_VERSION },
    });
    expect(claim).not.toHaveProperty("headline");
    expect(claim).not.toHaveProperty("comparison");
    expect(JSON.stringify(claim)).not.toMatch(/rank(?:ing|ed)?/iu);
    expect(qualification).toMatchObject({
      claimSchema: "benchmark-product.claim-package/2",
      publicationGrade,
      truthAdmission,
      candidateClasses: ["synthetic"],
      strata: ["core", "stress"],
      admissionManifestSha256: `sha256:${fixture.admissionManifestSha256}`,
    });
    expect(qualification.arms).toHaveLength(4);
    expect(qualification.items).toHaveLength(2);
    expect(qualification.items.map((item: { taskSha256: string }) => item.taskSha256).sort())
      .toEqual(fixture.taskSha256s.map((digest) => `sha256:${digest}`).sort());
    expect(qualification.reachableSha256s).toEqual([...qualification.reachableSha256s].sort());

    expect(evidence.format).toBe(BUNDLE_V4_EVIDENCE_FORMAT);
    const evidenceByDigest = new Map<string, string[]>(
      evidence.records.map((record: { sha256: string; roles: string[] }) => [record.sha256, record.roles]),
    );
    for (const prefixedDigest of qualification.reachableSha256s as string[]) {
      const digest = prefixedDigest.slice("sha256:".length);
      expect(evidenceByDigest.has(digest), prefixedDigest).toBe(true);
      const recordPath = join(bundleDir, "records", `${digest}.bin`);
      expect(existsSync(recordPath), prefixedDigest).toBe(true);
      expect(sha256Hex(readFileSync(recordPath)), prefixedDigest).toBe(digest);
    }
    for (const instrumentSha256 of fixture.instrumentSha256s) {
      expect(evidenceByDigest.get(instrumentSha256.slice("sha256:".length)))
        .toContain("judge-instrument");
    }
    expect([...evidenceByDigest.values()].some((roles) => roles.includes("source-manifest"))).toBe(true);
    expect([...evidenceByDigest.values()].some((roles) => roles.includes("analysis-context"))).toBe(true);
    expect([...evidenceByDigest.values()].some((roles) => roles.includes("label-resolution"))).toBe(true);

    expect(trust.format).toBe(BUNDLE_V4_TRUST_FORMAT);
    expect(trust.admission.authorities).toEqual(truthAdmission === "operator-only"
      ? [expect.objectContaining({ role: "operator-truth-attestor" })]
      : [
        expect.objectContaining({ role: "roster-attestor" }),
        expect.objectContaining({ role: "truth-reveal-attestor" }),
      ]);
    expect(trust.admission.reviewers).toHaveLength(truthAdmission === "operator-only" ? 0 : 2);
    expect(evidence.records.some((record: { roles: string[] }) =>
      record.roles.includes(truthAdmission === "operator-only" ? "operator-assertion" : "human-review-verdict")))
      .toBe(true);

    const allPublicBytes = Buffer.concat((manifest.files as Array<{ path: string }>).map((file) =>
      readFileSync(join(bundleDir, file.path))));
    expect(allPublicBytes.includes(Buffer.from(root))).toBe(false);
    expect(allPublicBytes.toString("utf8")).not.toMatch(/LoCoMo|licensed benchmark|api[_-]?key/iu);

    const verification = await verifyPublicBundle(bundleDir);
    expect(verification.format).toBe(BUNDLE_V4_FORMAT);
    if (verification.format !== BUNDLE_V4_FORMAT) {
      throw new Error(`expected ${BUNDLE_V4_FORMAT}, received ${verification.format}`);
    }
    expect(verification.checks).toEqual([
      "manifest",
      "evidence-closure",
      "trust",
      "matrix-rederivation",
      "report-verification",
      "claim-consistency",
    ]);
    expect(verification.qualification).toEqual({
      publicationGrade,
      truthAdmission,
      candidateClasses: ["synthetic"],
      strata: ["core", "stress"],
      armCount: 4,
      itemCount: 2,
      exclusionCount: 0,
    });
  }, 120_000);
});

describe("binary public-bundle/4 standalone-reader rejection boundaries", () => {
  async function fixture(truthAdmission: SyntheticV4TruthAdmission = "operator-only") {
    const root = mkdtempSync(join(tmpdir(), `binary-v4-tamper-base-${truthAdmission}-`));
    roots.push(root);
    return createSyntheticV4BundleFixture({ workspaceDir: root, truthAdmission });
  }

  test("rejects missing, extra, and role-swapped evidence after an authenticated catalog rewrite", async () => {
    const base = await fixture();
    const sourceBundle = base.bundle.bundleDir;

    const missing = copyBundle(sourceBundle, "missing");
    const missingEvidence = json(join(missing, "evidence.json"));
    const missingRecord = evidenceRecord(missingEvidence, "operator-assertion");
    missingEvidence.records = (missingEvidence.records as Array<{ sha256: string; roles: string[] }>)
      .filter((entry) => entry.sha256 !== missingRecord.sha256);
    rmSync(join(missing, "records", `${missingRecord.sha256}.bin`));
    writeCanonical(join(missing, "evidence.json"), missingEvidence);
    rewriteManifest(missing);
    await expectRejectedAt(missing, "evidence-closure");

    const extra = copyBundle(sourceBundle, "extra");
    const extraEvidence = json(join(extra, "evidence.json"));
    const extraBytes = canonicalJsonBytes({ fixture: "unreachable-authenticated-extra" });
    const extraSha256 = sha256Hex(extraBytes);
    writeFileSync(join(extra, "records", `${extraSha256}.bin`), extraBytes);
    (extraEvidence.records as Array<{ sha256: string; roles: string[] }>).push({
      sha256: extraSha256,
      roles: ["source-item"],
    });
    extraEvidence.records.sort((left: { sha256: string }, right: { sha256: string }) =>
      left.sha256 < right.sha256 ? -1 : left.sha256 > right.sha256 ? 1 : 0);
    writeCanonical(join(extra, "evidence.json"), extraEvidence);
    rewriteManifest(extra);
    await expectRejectedAt(extra, "evidence-closure");

    const swapped = copyBundle(sourceBundle, "role-swap");
    const swappedEvidence = json(join(swapped, "evidence.json"));
    const source = evidenceRecord(swappedEvidence, "source-item");
    const resolution = evidenceRecord(swappedEvidence, "label-resolution");
    source.roles = source.roles.map((role) => role === "source-item" ? "label-resolution" : role);
    resolution.roles = resolution.roles.map((role) => role === "label-resolution" ? "source-item" : role);
    writeCanonical(join(swapped, "evidence.json"), swappedEvidence);
    rewriteManifest(swapped);
    await expectRejectedAt(swapped, "evidence-closure");
  }, 120_000);

  test("rejects unsupported v3 and unknown bundle formats before dispatch", async () => {
    const base = await fixture();
    for (const [label, format] of [
      ["v3", "benchmark-product-public-bundle/3"],
      ["unknown", "benchmark-product-public-bundle/999"],
    ] as const) {
      const bundleDir = copyBundle(base.bundle.bundleDir, label);
      const manifest = json(join(bundleDir, "bundle.json"));
      manifest.format = format;
      writeCanonical(join(bundleDir, "bundle.json"), manifest);
      await expectRejectedAt(bundleDir, "bundle.json");
    }
  }, 120_000);

  test.each([
    ["substitution", (selection: Record<string, any>) => {
      selection.runtime.imageDigest = `sha256:${"e".repeat(64)}`;
    }],
    ["generation drift", (selection: Record<string, any>) => {
      for (const arm of selection.arms as Array<Record<string, any>>) arm.generation.reasoningEffort = "medium";
    }],
  ] as const)("rejects Run-anchored runtime-selection %s", async (_label, mutate) => {
    const base = await fixture();
    const bundleDir = copyBundle(base.bundle.bundleDir, "runtime-selection");
    const evidence = json(join(bundleDir, "evidence.json"));
    const selectionRecord = evidenceRecord(evidence, "runtime-selection");
    const selection = json(join(bundleDir, "records", `${selectionRecord.sha256}.bin`));
    mutate(selection);
    replaceEvidenceRecord(bundleDir, evidence, selectionRecord.sha256, canonicalJsonBytes(selection));
    writeCanonical(join(bundleDir, "evidence.json"), evidence);
    rewriteManifest(bundleDir);
    await expectRejectedAt(bundleDir, "evidence-closure");
  }, 120_000);

  test.each([
    ["item extra field", (intake: SyntheticV4IntakeBytes): SyntheticV4IntakeBytes => ({
      ...intake,
      itemBankJsonl: canonicalJsonlMutation(intake.itemBankJsonl, 0, (row) => { row.extra = true; }),
    })],
    ["source extra field", (intake: SyntheticV4IntakeBytes): SyntheticV4IntakeBytes => ({
      ...intake,
      sourceManifestJsonl: canonicalJsonlMutation(intake.sourceManifestJsonl, 0, (row) => { row.extra = true; }),
    })],
    ["admission wrong protocol", (intake: SyntheticV4IntakeBytes): SyntheticV4IntakeBytes => ({
      ...intake,
      admissionIndexJsonl: canonicalJsonlMutation(intake.admissionIndexJsonl, 0, (row) => {
        row.protocol = "https://spec.jinn.network/binary-judgment/admission-index-entry/v999";
      }),
    })],
    ["source metadata digest mismatch", (intake: SyntheticV4IntakeBytes): SyntheticV4IntakeBytes => ({
      ...intake,
      sourceManifestJsonl: canonicalJsonlMutation(intake.sourceManifestJsonl, 0, (row) => {
        row.source.digest.sha256 = "f".repeat(64);
      }),
    })],
    ["non-canonical JSONL spelling", (intake: SyntheticV4IntakeBytes): SyntheticV4IntakeBytes => ({
      ...intake,
      itemBankJsonl: intake.itemBankJsonl.replace(/\n/gu, "\r\n"),
    })],
  ] as const)("refuses strict intake violation: %s", async (_label, mutateIntake) => {
    const root = mkdtempSync(join(tmpdir(), "binary-v4-intake-reject-"));
    roots.push(root);
    await expect(createSyntheticV4BundleFixture({
      workspaceDir: root,
      truthAdmission: "operator-only",
      mutateIntake,
    })).rejects.toThrow(/binary item-bank import/iu);
  }, 30_000);

  test.each([
    ["operator-only", ["roster-attestor", "truth-reveal-attestor"]],
    ["two-human-unanimous", ["operator-truth-attestor"]],
  ] as const)("rejects a %s admission authority-role substitution", async (truthAdmission, roles) => {
    const base = await fixture(truthAdmission);
    const bundleDir = copyBundle(base.bundle.bundleDir, `trust-role-${truthAdmission}`);
    const trust = json(join(bundleDir, "trust", "public-keys.json"));
    trust.admission.authorities = roles.map((role) => ({ role, keyId: trust.report.keyId }));
    writeCanonical(join(bundleDir, "trust", "public-keys.json"), trust);
    rewriteManifest(bundleDir);
    await expectRejectedAt(bundleDir, "evidence-closure");
  }, 120_000);

  test("rejects an operator authority key substitution", async () => {
    const base = await fixture("operator-only");
    const bundleDir = copyBundle(base.bundle.bundleDir, "operator-key");
    const trust = json(join(bundleDir, "trust", "public-keys.json"));
    const { publicKey } = generateKeyPairSync("ed25519");
    const keyId = didKeyFromEd25519PublicKey(publicKey);
    trust.report.keyId = keyId;
    trust.report.didKey = keyId;
    trust.report.spkiDerBase64 = Buffer.from(publicKey.export({ type: "spki", format: "der" })).toString("base64");
    trust.admission.authorities[0].keyId = keyId;
    writeCanonical(join(bundleDir, "trust", "public-keys.json"), trust);
    rewriteManifest(bundleDir);
    await expectRejectedAt(bundleDir, "evidence-closure");
  }, 120_000);

  test("rejects a human reviewer key substitution", async () => {
    const base = await fixture("two-human-unanimous");
    const bundleDir = copyBundle(base.bundle.bundleDir, "reviewer-key");
    const trust = json(join(bundleDir, "trust", "public-keys.json"));
    const reviewer = trust.admission.reviewers[0] as { evaluator: string; keyId: string };
    const evaluator = (trust.evaluators as Array<Record<string, any>>)
      .find((entry) => entry.evaluator === reviewer.evaluator)!;
    const { publicKey } = generateKeyPairSync("ed25519");
    const keyId = verdictKeyIdFromEd25519PublicKey(publicKey);
    evaluator.keyId = keyId;
    evaluator.spkiDerBase64 = Buffer.from(publicKey.export({ type: "spki", format: "der" })).toString("base64");
    reviewer.keyId = keyId;
    writeCanonical(join(bundleDir, "trust", "public-keys.json"), trust);
    rewriteManifest(bundleDir);
    await expectRejectedAt(bundleDir, "evidence-closure");
  }, 120_000);

  test.each([
    "response",
    "observation",
  ] as const)("rejects a fully authenticated %s rewrite at report-verification", async (kind) => {
    const base = await fixture("operator-only");
    const bundleDir = await authenticatedSolveArtifactTamper(base, kind);
    await expectRejectedAt(bundleDir, "report-verification");
  }, 120_000);
});
