#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * The single offline verification of the sealed Demo-1 report.
 *
 *   cd packages/benchmark-product/core && yarn demo1:verify
 *
 * From a clean checkout (after `yarn install && yarn build`) this replays, with no network:
 *   1. fail-closed admission of the declared cells from the sealed cells file
 *   2. recomputation of every statistic, compared against the committed report
 *   3. digest integrity of every record and artifact in the evidence bundle
 *   4. cohort, matrix, and report verification through the product chain
 *   5. ed25519 DSSE signature checks against the bundle's committed public keys
 *   6. the binding between each evidence record's result artifact and the cells file
 *
 * Any failure exits non-zero naming what broke. Nothing here can shrink a denominator:
 * admission re-throws on missing or unparseable cells exactly as the sealing build did.
 */
import { createHash, createPublicKey, verify as verifyEd25519 } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evidenceReferenceKey,
} from "@jinn-network/benchmarking-protocol";
import {
  assembleEvidenceMatrix,
  deriveDefaultEvidenceCell,
  verifyEvidenceCohort,
  verifyEvidenceMatrix,
  verifyEvidenceNativeReport,
} from "@jinn-network/benchmarking-evidence";
import { DSSE_PAYLOAD_TYPE, recordDigest } from "@jinn-network/evidence-protocol";
import { dssePreAuthEncoding } from "@jinn-network/trust-core";
import { admitDeclaredCells } from "../dist/method/skillsbench-demo1-declaration.js";
import {
  informativeSubset,
  manipulationCheck,
  pairedDeltaEstimate,
  varianceDecomposition,
} from "../dist/method/skillsbench-demo1-stats.js";

const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const REPO_ROOT = resolve(PACKAGE_ROOT, "../../..");
const BASE = resolve(REPO_ROOT, "docs/superpowers/plans/demo-report-1");

const bundle = JSON.parse(readFileSync(resolve(BASE, "E1-demo1-evidence-bundle.v1.json"), "utf8"));
const summary = JSON.parse(readFileSync(resolve(BASE, "demo1-report.v1.json"), "utf8"));
const cellsDocument = JSON.parse(readFileSync(
  resolve(BASE, bundle.stage === "final" ? "E1-demo1-confirmatory-cells.v1.json" : "E1-arm-cells.v1.json"),
  "utf8",
));

const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}`);
  if (!ok) failures.push(label);
};
const fromB64 = (text) => new Uint8Array(Buffer.from(text, "base64"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const encoder = new TextEncoder();
const json = (value) => encoder.encode(JSON.stringify(value));

// 1. Fail-closed admission from the sealed cells file, against the bundled declaration.
const admission = admitDeclaredCells(bundle.declaration, cellsDocument);
check(admission.cells.length === summary.cells, `admission: ${admission.cells.length} cells match the report`);
check(recordDigest(json(bundle.declaration)) === summary.digests.declaration, "declaration digest matches the report");

// 2. Recompute every statistic over the declared slate and compare to the committed report.
const slateCells = admission.cells.filter((cell) => cell.section === "slate");
const estimate = pairedDeltaEstimate(informativeSubset(slateCells));
const decomposition = varianceDecomposition(estimate);
const manipulation = manipulationCheck(slateCells);
const closeTo = (a, b) => Math.abs(a - b) < 1e-9;
const ppm = (value) => Math.round(value * 1_000_000);
const sealedDelta = summary.resultsSealedPpm.pairedDelta;
check(closeTo(estimate.mean, summary.results.pairedDelta.mean), "paired A-B mean recomputes");
check(closeTo(estimate.ci95.lower, summary.results.pairedDelta.ci95.lower)
  && closeTo(estimate.ci95.upper, summary.results.pairedDelta.ci95.upper), "confidence interval recomputes");
check(ppm(estimate.mean) === sealedDelta.meanPpm && ppm(estimate.se) === sealedDelta.sePpm, "sealed ppm statistics recompute");
check(closeTo(decomposition.taskHeterogeneity, summary.results.varianceDecomposition.taskHeterogeneity), "variance decomposition recomputes");
check(manipulation.cFullPass === summary.results.manipulationCheck.cFullPass
  && closeTo(manipulation.uplift, summary.results.manipulationCheck.uplift), "manipulation check recomputes");

// 3. Digest integrity of every bundled record and artifact.
const records = new Map(Object.entries(bundle.records).map(([key, text]) => [key, fromB64(text)]));
const artifacts = new Map(Object.entries(bundle.artifacts).map(([digest, text]) => [digest, fromB64(text)]));
check([...records].every(([key, bytes]) => key.endsWith(sha256(bytes))), `${records.size} evidence records hash to their keys`);
check([...artifacts].every(([digest, bytes]) => digest === sha256(bytes)), `${artifacts.size} artifacts hash to their keys`);

const manifestBytes = fromB64(bundle.manifest);
const cohortBytes = fromB64(bundle.cohort);
const matrixBytes = fromB64(bundle.matrix);
const envelopeBytes = fromB64(bundle.reportEnvelope);

// The committed preregistration must carry byte-identical declaration and manifest — that equality
// is what shows the analysis was declared before the evidence completed, not fit to it.
const preregistration = JSON.parse(readFileSync(resolve(BASE, "E1-demo1-preregistration.v1.json"), "utf8"));
check(JSON.stringify(preregistration.declaration) === JSON.stringify(bundle.declaration),
  "preregistered declaration matches the bundle");
check(preregistration.manifest === bundle.manifest, "preregistered manifest bytes match the bundle");
check(recordDigest(manifestBytes) === summary.digests.analysisManifest, "analysis manifest digest matches");
check(recordDigest(cohortBytes) === summary.digests.cohort, "cohort digest matches");
check(recordDigest(matrixBytes) === summary.digests.matrix, "matrix digest matches");
check(recordDigest(envelopeBytes) === summary.digests.report, "report envelope digest matches");

// 4. Product-chain verification: cohort, matrix, report.
const resolver = {
  resolve(reference) {
    const bytes = records.get(evidenceReferenceKey(reference));
    if (bytes === undefined) throw new Error(`missing ${evidenceReferenceKey(reference)}`);
    return bytes;
  },
};
check(verifyEvidenceCohort({ cohortBytes, manifestBytes, records: resolver }).conforms === true, "evidence cohort verifies");
const implementation = { name: "assembly-3.0.json", digest: { sha256: recordDigest(json({ procedure: "3.0" })).slice(7) } };
check(verifyEvidenceMatrix({
  matrixBytes, cohortBytes, manifestBytes, records: resolver, implementation, deriveCell: deriveDefaultEvidenceCell,
}).conforms === true, "evidence matrix verifies");
const reportVerdict = verifyEvidenceNativeReport({ envelopeBytes, matrixBytes });
check(reportVerdict.report !== undefined, "evidence-native report verifies against the matrix");

// 5. DSSE ed25519 signatures against the committed public keys.
function verifyDsse(bytes, label) {
  const envelope = JSON.parse(Buffer.from(bytes).toString("utf8"));
  const payload = Buffer.from(envelope.payload, "base64");
  const preAuth = dssePreAuthEncoding(envelope.payloadType ?? DSSE_PAYLOAD_TYPE, payload);
  const allValid = envelope.signatures.length > 0 && envelope.signatures.every((entry) => {
    const spki = bundle.publicKeys[entry.keyid];
    if (spki === undefined) return false;
    const key = createPublicKey({ key: Buffer.from(spki, "base64"), format: "der", type: "spki" });
    return verifyEd25519(null, preAuth, key, Buffer.from(entry.sig, "base64"));
  });
  check(allValid, label);
}
verifyDsse(envelopeBytes, "report envelope signature verifies");
const evaluationRecords = [...records.entries()].filter(([key]) => key.startsWith("result-evaluation"));
check(evaluationRecords.length === admission.cells.length, `one evaluation per admitted cell (${evaluationRecords.length})`);
let evaluationSignatures = 0;
for (const [, bytes] of evaluationRecords) {
  const envelope = JSON.parse(Buffer.from(bytes).toString("utf8"));
  const payload = Buffer.from(envelope.payload, "base64");
  const preAuth = dssePreAuthEncoding(envelope.payloadType, payload);
  const valid = envelope.signatures.every((entry) => {
    const spki = bundle.publicKeys[entry.keyid];
    if (spki === undefined) return false;
    const key = createPublicKey({ key: Buffer.from(spki, "base64"), format: "der", type: "spki" });
    return verifyEd25519(null, preAuth, key, Buffer.from(entry.sig, "base64"));
  });
  if (valid) evaluationSignatures += 1;
}
check(evaluationSignatures === evaluationRecords.length, `${evaluationSignatures} evaluation signatures verify`);

// 6. Bind each execution record's result artifact back to the cells file.
let bound = 0;
for (const cell of admission.cells) {
  const expected = json({ reward: cell.reward, source: "/logs/verifier/reward.txt" });
  if (artifacts.get(sha256(expected)) !== undefined) bound += 1;
}
check(bound === admission.cells.length, `${bound} result artifacts bind to the sealed cells file`);

console.log("");
if (failures.length > 0) {
  console.error(`DEMO-1 VERIFICATION FAILED (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`DEMO-1 VERIFIED: ${admission.cells.length} cells, ${estimate.n} tasks, stage=${bundle.stage}`);
console.log(`paired A-B ${estimate.mean.toFixed(3)} (95% CI ${estimate.ci95.lower.toFixed(3)} to ${estimate.ci95.upper.toFixed(3)})`);
console.log(`report ${summary.digests.report}`);
