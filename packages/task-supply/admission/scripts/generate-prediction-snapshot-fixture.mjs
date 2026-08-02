// SPDX-License-Identifier: Apache-2.0
// Regenerates the append-only v1 fixture from fixed public inputs and a test-only key.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createPrivateKey, sign } from "node:crypto";
import { fileURLToPath } from "node:url";
import { canonicalJsonBytes, recordDigest, sealSignedRecord } from "@jinn-network/trust-core";
import {
  admitPredictionSnapshot,
  sealPredictionSnapshotAdmissionReceipt,
} from "../dist/index.js";

const root = new URL("../fixtures/prediction-snapshot-v1/", import.meta.url);
const checkOnly = process.argv.includes("--check");
const payloadType = "application/vnd.in-toto+json";
// Multibase(base58btc) encoding of the Ed25519 public-key multicodec prefix plus `publicKey.x`.
const keyid = "did:key:z6MkscK4NdjtG8eXHWvCWjf4kW3oXoNp3Av9z7qNzuHaUJnF";
const publicKey = { crv: "Ed25519", x: "w3mQj5K2j3ApwYz0jm9g-TSxxXV-kQQgAUqZpiVBZWw", kty: "OKP" };
// This non-production key exists solely so committed fixture signatures reproduce byte-for-byte.
const privateKey = createPrivateKey({
  key: { ...publicKey, d: "niwIp2gCT8xDprfjUECmveaPUIgVaS0gZ4kR4U8YXN0" },
  format: "jwk",
});
const signer = async ({ preAuthEncoding }) => [{
  keyid,
  signature: new Uint8Array(sign(null, Buffer.from(preAuthEncoding), privateKey)),
}];
const bytes = (value) => canonicalJsonBytes(value);
const write = async (name, value) => writeFile(new URL(name, root), value);

const evaluationSpec = {
  protocol: "https://jinn.network/profiles/evaluation-spec/1.0",
  semanticsVersion: "4",
  family: "deterministic-process",
  grader: { name: "public-grader", digest: { sha256: "b".repeat(64) }, accessClass: "public" },
  familyBlock: {
    image: { name: "prediction-image", digest: { sha256: "c".repeat(64) }, accessClass: "public" },
    platform: "linux/amd64",
    workspace: {},
    testMaterial: [],
    parser: { id: "network.jinn.parser.prediction-market", version: "1.0.0", digest: "sha256:fdf33b359e1d142a372b374abddab4e582fd4cbff5a32e53de9333a5515c2d1a" },
    transitions: { failToPass: ["prediction-valid"], passToPass: [] },
    timeout: 60,
  },
  measurements: [
    { name: "integrity", type: "boolean", required: true },
    { name: "resolved", type: "boolean", required: true },
    { name: "outcomeYes", type: "boolean", required: false },
    { name: "solverBrier", type: "string", direction: "lower-better", required: false },
    { name: "consensusBrier", type: "string", required: false },
    { name: "brierSpread", type: "string", direction: "lower-better", required: false },
  ],
  verdictRule: { all: [
    { threshold: { measurement: "integrity", op: "eq", value: true } },
    { inconclusiveWhen: { threshold: { measurement: "resolved", op: "eq", value: false } }, class: "market-unresolved" },
  ] },
  unscorable: [{ name: "market-unresolved", disposition: "recorded-inconclusive" }],
  evidenceConventions: { requiredRefs: [] },
};
const evaluationSpecBytes = bytes(evaluationSpec);
const task = {
  protocol: "https://jinn.network/profiles/task-execution/1.0",
  profile: {
    uri: "https://jinn.network/task-profiles/prediction-forecast/1.0",
    digest: { sha256: "e61dc765d1a93b71639cb566d6bd3ca1335cfd53cb415e904ff840670d212937" },
  },
  instructions: "Forecast the named market.",
  payload: { forecast: {
    marketId: "will-jinn-ship",
    question: "Will Jinn ship?",
    consensusProbabilityYes: "0.750000",
    observedAt: "2026-08-02T00:00:00Z",
    resolvesAt: "2026-08-03T00:00:00Z",
  } },
  outputs: [{ name: "prediction", mediaType: "application/json", required: true, schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      probabilityYes: { type: "string", pattern: "^(0(\\.\\d+)?|1(\\.0+)?)$" },
      submittedAt: { type: "string", format: "date-time" },
    },
    required: ["probabilityYes", "submittedAt"],
  } }],
  evaluation: { name: "evaluation-spec.json", digest: { sha256: recordDigest(evaluationSpecBytes).slice(7) } },
};
const taskBytes = bytes(task);
const receipt = admitPredictionSnapshot({ taskBytes, evaluationSpecBytes, issuer: "did:jinn:admitter" });
const sealedReceipt = await sealPredictionSnapshotAdmissionReceipt(receipt, signer);
const submission = {
  protocol: "https://jinn.network/profiles/task-execution/1.0",
  submission: "urn:uuid:0f9a8b7c-1234-5abc-8def-123456789abc",
  requester: "did:jinn:requester-golden",
  task: { digest: { sha256: recordDigest(taskBytes).slice(7) } },
  deadline: "2026-08-02T12:00:00Z",
  idempotencyKey: "native-prediction-forecast-will-jinn-ship-2026-08-02",
  nonce: "native-prediction-forecast-nonce-1",
  annotations: { "https://jinn.network/annotations/admission-receipt/1.0": {
    name: "admission-receipt", mediaType: payloadType, digest: { sha256: sealedReceipt.receiptDigest.slice(7) },
  } },
};
const submissionBytes = bytes(submission);
const requesterSealed = await sealSignedRecord({
  payloadType,
  signer,
  record: {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: "submission", digest: { sha256: recordDigest(submissionBytes).slice(7) } }],
    predicateType: "https://jinn.network/attestations/requester-submission/v1",
    predicate: {
      requester: submission.requester,
      taskDigest: recordDigest(taskBytes),
      submissionDigest: recordDigest(submissionBytes),
      admissionReceiptDigest: sealedReceipt.receiptDigest,
    },
  },
});
const digests = {
  task: recordDigest(taskBytes),
  evaluationSpec: recordDigest(evaluationSpecBytes),
  admissionReceiptDsse: sealedReceipt.receiptDigest,
  submission: recordDigest(submissionBytes),
  requesterDsse: requesterSealed.recordDigest,
};
const manifest = {
  fixtureVersion: 1,
  provenance: {
    source: "Phase B B1 native prediction contract; deterministic cryptographic fixture with no chain or database dependency.",
    generator: "scripts/generate-prediction-snapshot-fixture.mjs; fixed test-only Ed25519 signing key; verification-key.json verifies both DSSE PAEs.",
  },
  profile: task.profile.uri,
  operation: {
    id: `native-prediction-forecast:${digests.task.slice(7, 23)}:${digests.submission.slice(7, 23)}`,
    relationship: "requester seals Task -> EvaluationSpec -> admission receipt DSSE -> Submission -> requester DSSE",
  },
  artifacts: {
    task: { path: "task.json", digest: digests.task },
    evaluationSpec: { path: "evaluation-spec.json", digest: digests.evaluationSpec },
    admissionReceiptDsse: { path: "admission-receipt.dsse.json", digest: digests.admissionReceiptDsse },
    submission: { path: "submission.json", digest: digests.submission },
    requesterDsse: { path: "requester.dsse.json", digest: digests.requesterDsse },
  },
  subjects: {
    taskDigest: digests.task,
    evaluationSpecDigest: digests.evaluationSpec,
    admissionReceiptDigest: digests.admissionReceiptDsse,
    submissionDigest: digests.submission,
    requesterDsseDigest: digests.requesterDsse,
  },
};

const generated = {
  "task.json": taskBytes,
  "evaluation-spec.json": evaluationSpecBytes,
  "admission-receipt.dsse.json": sealedReceipt.envelopeBytes,
  "submission.json": submissionBytes,
  "requester.dsse.json": requesterSealed.envelopeBytes,
  "manifest.json": bytes(manifest),
  "verification-key.json": bytes({ keyid, algorithm: "Ed25519", publicKey }),
};
if (checkOnly) {
  await Promise.all(Object.entries(generated).map(async ([name, content]) => {
    const committed = await readFile(new URL(name, root));
    if (!Buffer.from(committed).equals(Buffer.from(content))) throw new Error(`${name} differs from deterministic generated bytes`);
  }));
} else {
  await mkdir(fileURLToPath(root), { recursive: true });
  await Promise.all(Object.entries(generated).map(([name, content]) => write(name, content)));
}
