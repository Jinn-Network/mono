// SPDX-License-Identifier: Apache-2.0

import {
  generateKeyPairSync,
  sign as signEd25519,
  type KeyObject,
} from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BENCHMARKING_PROTOCOL_V2,
  CLAIM_PACKAGE_V3_PROFILE,
  EXECUTION_BATCH_CAPTURE_RECORD_KIND,
  documentDigest,
  evidenceReferenceKey,
  parseEvidenceCohort,
  parseEvidenceNativeClaimPackageV3,
  sealBenchmarkAnalysisManifest,
  sealBenchmarkDefinitionV2,
  sealEvidenceCohort,
  sealEvidenceNativeClaimPackageV3,
  type DigestBearingResourceDescriptor,
  type EvidenceNativeClaimPackageV3,
  type EvidenceRecordReference,
} from "@jinn-network/benchmarking-protocol";
import {
  assembleEvidenceMatrix,
  buildEvidenceNativeBundleManifestV5,
  deriveDefaultEvidenceCell,
  EVIDENCE_NATIVE_BUNDLE_V5_CHECKS,
  issueEvidenceNativeReport,
  verifyEvidenceCohort,
} from "@jinn-network/benchmarking-evidence";
import {
  DSSE_PAYLOAD_TYPE,
  IN_TOTO_STATEMENT_TYPE,
  RESULT_EVALUATION_PREDICATE_TYPE,
  recordDigest,
  validateExecutionEvidence,
  validateResultEvaluation,
} from "@jinn-network/evidence-protocol";
import {
  buildExecutionEvidence,
  type ExecutionEvidenceArtifactSource,
  type ExecutionEvidenceBuilderInput,
} from "@jinn-network/execution-evidence-builder";
import { dssePreAuthEncoding, sealDsseEnvelope, type DsseSigner } from "@jinn-network/trust-core";
import { describe, expect, test } from "vitest";
import { runVerifierCli, verifyPublicBundleSnapshot } from "@colophon-claims/check";

const encoder = new TextEncoder();
const origin = { kind: "producer-observed", observer: "urn:agent:colophon-v5-signers" } as const;

const GRADER_ID = "urn:evaluator:grader";
const SURPLUS_REVIEWER_ID = "urn:reviewer:surplus";
const PUBLISHER_ID = "urn:publisher:colophon";

interface SigningKey {
  readonly identity: string;
  readonly keyId: string;
  readonly privateKey: KeyObject;
  readonly publicKeyBytes: Uint8Array;
}

function makeKey(identity: string): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    identity,
    keyId: `urn:key:${identity}`,
    privateKey,
    publicKeyBytes: new Uint8Array(publicKey.export({ format: "der", type: "spki" })),
  };
}

const signingKeys = new Map<string, SigningKey>(
  [GRADER_ID, SURPLUS_REVIEWER_ID, PUBLISHER_ID].map((identity) => [identity, makeKey(identity)]),
);

const OPINION_VERDICT = {
  ACCEPT: "pass",
  REJECT: "fail",
  inconclusive: "inconclusive",
} as const;

function requireKey(identity: string): SigningKey {
  const key = signingKeys.get(identity);
  if (key === undefined) throw new Error(`missing signing key for ${identity}`);
  return key;
}

function signerFor(identity: string): DsseSigner {
  const key = requireKey(identity);
  return async ({ preAuthEncoding }) => [{
    keyid: key.keyId,
    signature: new Uint8Array(signEd25519(null, preAuthEncoding, key.privateKey)),
  }];
}

function compareSha256(
  left: { readonly digest: { readonly sha256: string } },
  right: { readonly digest: { readonly sha256: string } },
): number {
  return left.digest.sha256.localeCompare(right.digest.sha256);
}

function compareKeyId(
  left: { readonly keyId: string },
  right: { readonly keyId: string },
): number {
  return left.keyId.localeCompare(right.keyId);
}

function json(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function artifact(bytes: Uint8Array, name: string, mediaType: string): ExecutionEvidenceArtifactSource {
  return { digest: recordDigest(bytes), size: bytes.byteLength, name, mediaType };
}

function descriptor(name: string, digest: `sha256:${string}`, mediaType?: string): DigestBearingResourceDescriptor {
  return { name, digest: { sha256: digest.slice(7) }, ...(mediaType === undefined ? {} : { mediaType }) };
}

function publicKeyDescriptor(key: SigningKey): DigestBearingResourceDescriptor {
  return descriptor(
    `${encodeURIComponent(key.identity)}.ed25519-public-key.der`,
    recordDigest(key.publicKeyBytes),
    "application/vnd.jinn.ed25519-public-key+der",
  );
}

function trustSigner(
  key: SigningKey,
  purpose: EvidenceNativeClaimPackageV3["trust"]["signers"][number]["purpose"],
): EvidenceNativeClaimPackageV3["trust"]["signers"][number] {
  return {
    keyId: key.keyId,
    identity: key.identity,
    purpose,
    publicKey: publicKeyDescriptor(key),
    algorithm: "ed25519",
  };
}

function ref(family: EvidenceRecordReference["family"], name: string, bytes: Uint8Array): EvidenceRecordReference {
  return { family, record: descriptor(name, recordDigest(bytes)) };
}

function uuid(index: number): `urn:uuid:${string}` {
  return `urn:uuid:${index.toString(16).padStart(8, "0")}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function sortReferences(values: readonly EvidenceRecordReference[]): EvidenceRecordReference[] {
  return [...values].sort((left, right) => evidenceReferenceKey(left).localeCompare(evidenceReferenceKey(right), "en", { sensitivity: "variant" }));
}

function writeBundle(root: string, files: ReadonlyMap<string, Uint8Array>): void {
  for (const [path, bytes] of files) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
}

function execution(input: {
  readonly id: number;
  readonly name: string;
  readonly taskBytes: Uint8Array;
  readonly resultBytes: Uint8Array;
}): {
  readonly bytes: Uint8Array;
  readonly taskDigest: `sha256:${string}`;
  readonly resultDigest: `sha256:${string}`;
  readonly artifacts: ReadonlyMap<string, Uint8Array>;
} {
  const task = artifact(input.taskBytes, `${input.name}-task.json`, "application/json");
  const result = artifact(input.resultBytes, `${input.name}-result.json`, "application/json");
  const runtimeBytes = json({ runtime: "Harbor", version: "0.21.0" });
  const traceBytes = json({ events: [], unit: input.name });
  const executableBytes = encoder.encode("Harbor executable");
  const runtime = artifact(runtimeBytes, "harbor-runtime.json", "application/json");
  const trace = artifact(traceBytes, `${input.name}-trace.json`, "application/json");
  const executable = artifact(executableBytes, "harbor", "application/octet-stream");
  const builderInput: ExecutionEvidenceBuilderInput = {
    recording: {
      executionId: uuid(input.id),
      startedAt: `2026-08-16T09:${String(input.id % 60).padStart(2, "0")}:00.000Z`,
      record: {
        name: input.name,
        description: "One native Harbor atomic execution.",
        license: "https://creativecommons.org/publicdomain/zero/1.0/",
      },
      task: { entityId: "task/input.json", name: task.name!, source: task, origin },
      initialInputs: [],
      executor: {
        entityId: "urn:agent:memory-system",
        kind: "software",
        name: "Memory system",
        origin,
      },
      runtime: {
        entityId: "runtime/runtime.json",
        specification: runtime,
        name: "Harbor",
        softwareVersion: "0.21.0",
        origin,
        components: [{
          kind: "controlled",
          artifact: { kind: "file", entityId: "runtime/executable", source: executable, origin },
        }],
      },
      producer: {
        entityId: "urn:agent:colophon-v5-signers",
        kind: "software",
        name: "Colophon v5 signers fixture",
        origin,
      },
    },
    additionalInputs: [],
    runtimeObservations: [],
    outcome: "completed",
    endedAt: `2026-08-16T09:${String(input.id % 60).padStart(2, "0")}:01.000Z`,
    finalizedAt: "2026-08-16T10:30:00.000Z",
    results: [{ kind: "file", entityId: "results/output.json", source: result, origin }],
    nativeTrace: {
      artifact: { kind: "file", entityId: "trace/native.json", source: trace, origin },
      format: { entityId: "https://harborframework.com/formats/atif" },
    },
  };
  const bytes = buildExecutionEvidence(builderInput);
  expect(validateExecutionEvidence(bytes)).toMatchObject({ conforms: true, diagnostics: [] });
  return {
    bytes,
    taskDigest: task.digest,
    resultDigest: result.digest,
    artifacts: new Map([
      [task.digest.slice(7), input.taskBytes],
      [result.digest.slice(7), input.resultBytes],
      [runtime.digest.slice(7), runtimeBytes],
      [trace.digest.slice(7), traceBytes],
      [executable.digest.slice(7), executableBytes],
    ]),
  };
}

function evaluation(input: {
  readonly taskDigest: `sha256:${string}`;
  readonly resultDigest: `sha256:${string}`;
  readonly evaluator: string;
  readonly methodDigest: `sha256:${string}`;
  readonly opinion: "ACCEPT" | "REJECT" | "inconclusive";
  readonly evaluatedAt: string;
  readonly human?: boolean;
}): Uint8Array {
  const statement = {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [
      descriptor("candidate-answer.json", input.resultDigest, "application/json"),
      descriptor("memory-task.json", input.taskDigest, "application/json"),
    ],
    predicateType: RESULT_EVALUATION_PREDICATE_TYPE,
    predicate: {
      evaluatedAt: input.evaluatedAt,
      evaluator: { id: input.evaluator },
      evaluationMethod: descriptor("evaluation-method.json", input.methodDigest, "application/json"),
      taskSubject: "memory-task.json",
      resultSubjects: ["candidate-answer.json"],
      verdict: OPINION_VERDICT[input.opinion],
      measurements: input.human === true
        ? [{ name: "humanLabel", value: input.opinion }, { name: "blindIndependentReview", value: true }]
        : [{ name: "binary-opinion", value: input.opinion }, { name: "parseValid", value: true }],
      evidence: [],
      limitations: [],
    },
  };
  const payload = json(statement);
  const key = requireKey(input.evaluator);
  const signature = signEd25519(null, dssePreAuthEncoding(DSSE_PAYLOAD_TYPE, payload), key.privateKey);
  // Checker disclosure reads cohort-referenced keyids through `parseExactDsseEnvelope`.
  const bytes = sealDsseEnvelope({
    payloadType: DSSE_PAYLOAD_TYPE,
    payloadBytes: payload,
    signatures: [{ keyid: key.keyId, signature: new Uint8Array(signature) }],
  });
  expect(validateResultEvaluation(bytes)).toMatchObject({ conforms: true, diagnostics: [] });
  return bytes;
}

async function oneMemberV5Bundle(): Promise<{
  readonly files: Map<string, Uint8Array>;
  readonly claim: ReturnType<typeof sealEvidenceNativeClaimPackageV3>;
  readonly graderKeyId: string;
  readonly publisherKeyId: string;
  readonly surplusReviewerKeyId: string;
  readonly surplusEvaluation: { readonly reference: EvidenceRecordReference; readonly bytes: Uint8Array };
  readonly surplusPublicKey: { readonly descriptor: DigestBearingResourceDescriptor; readonly bytes: Uint8Array };
}> {
  const records = new Map<string, Uint8Array>();
  const artifacts = new Map<string, Uint8Array>();
  function put(reference: EvidenceRecordReference, bytes: Uint8Array): EvidenceRecordReference {
    records.set(evidenceReferenceKey(reference), bytes);
    return reference;
  }

  const taskBytes = json({ question: "Memory question 1", context: ["fact-1"] });
  const resultBytes = json({ answer: "candidate-1" });
  const subject = execution({
    id: 1,
    name: "harbor-trial-1",
    taskBytes,
    resultBytes,
  });
  for (const [digest, bytes] of subject.artifacts) artifacts.set(digest, bytes);
  const executionReference = put(ref("execution-evidence", "ro-crate-metadata.json", subject.bytes), subject.bytes);
  const graderMethod = recordDigest(json({ method: "binary-instrument", version: 1 }));
  const graderEvaluationBytes = evaluation({
    taskDigest: subject.taskDigest,
    resultDigest: subject.resultDigest,
    evaluator: GRADER_ID,
    methodDigest: graderMethod,
    opinion: "ACCEPT",
    evaluatedAt: "2026-08-16T11:00:01.000Z",
  });
  const graderEvaluation = put(ref("result-evaluation", "grader.dsse.json", graderEvaluationBytes), graderEvaluationBytes);

  const surplusMethod = recordDigest(json({ method: "blind-human-review", version: 1 }));
  const surplusEvaluationBytes = evaluation({
    taskDigest: subject.taskDigest,
    resultDigest: subject.resultDigest,
    evaluator: SURPLUS_REVIEWER_ID,
    methodDigest: surplusMethod,
    opinion: "ACCEPT",
    evaluatedAt: "2026-08-16T11:00:02.000Z",
    human: true,
  });
  const surplusReference = ref("result-evaluation", "surplus-reviewer.dsse.json", surplusEvaluationBytes);

  const grader = requireKey(GRADER_ID);
  const surplus = requireKey(SURPLUS_REVIEWER_ID);
  const publisher = requireKey(PUBLISHER_ID);
  for (const key of [grader, publisher]) {
    artifacts.set(recordDigest(key.publicKeyBytes).slice(7), key.publicKeyBytes);
  }

  const benchmarkRecord = sealBenchmarkDefinitionV2({
    protocol: BENCHMARKING_PROTOCOL_V2,
    name: "One-member v5 signer disclosure",
    description: "A single Harbor execution graded by one instrument.",
    author: "urn:agent:analysis-owner",
    version: "1.0.0",
    items: [{
      task: descriptor("memory-task-1.json", subject.taskDigest, "application/json"),
      identifiers: [{ scheme: "https://harborframework.com/identifiers/task", value: "memory-1" }],
    }],
    reveal: { policy: "immediate" },
    license: "https://creativecommons.org/publicdomain/zero/1.0/",
  });
  const benchmark = descriptor("benchmark-v2.json", benchmarkRecord.digest);
  const capture = {
    recordKind: EXECUTION_BATCH_CAPTURE_RECORD_KIND,
    record: descriptor("harbor-capture.json", recordDigest(json({ units: 1 }))),
  };
  const manifest = sealBenchmarkAnalysisManifest({
    protocol: BENCHMARKING_PROTOCOL_V2,
    benchmark,
    owner: "urn:agent:analysis-owner",
    sources: [{ source: capture, cutoff: "2026-08-16T14:00:00.000Z" }],
    groups: [{ groupId: "memory", selection: descriptor("all-one.json", recordDigest(json({ all: 1 }))) }],
    taskRelation: { exactDigestRequired: true },
    multiplicity: {
      correlationUnit: "execution",
      duplicatePolicy: "retain-distinct",
      retryPolicy: "correlated",
      assignmentPolicy: descriptor("assignment.json", recordDigest(json({ slot: "native-trial" }))),
    },
    evaluationAdmission: {
      evaluatorAllowlist: [GRADER_ID],
      methodAllowlist: [descriptor("grader.json", graderMethod)],
      minimumClaims: 1,
      distinctEvaluators: true,
      humanLabelPolicy: "not-required",
      conflictPolicy: "preserve-unresolved",
      supersessionPolicy: "preserve-all",
      trustPolicy: descriptor("trust.json", recordDigest(json({ policy: "one-member" }))),
    },
    verificationAdmission: {
      requiredChecks: [],
      trustPolicy: descriptor("verification-trust.json", recordDigest(json({ policy: "one-member" }))),
      failurePolicy: "disclose",
    },
    completeness: {
      required: "complete",
      unavailableSource: "indeterminate",
      discoveredOmission: "fail",
      excludedMember: "count-attrition",
    },
    analysisPlan: [{ id: "jinn.benchmarking.method/binary-instrument", version: "1", parameters: { k: 1 } }],
    closeAt: "2026-08-16T14:00:00.000Z",
    preregistration: "local-sealed-before-selection",
  });
  const evaluations = sortReferences([graderEvaluation]);
  const cohort = sealEvidenceCohort({
    protocol: BENCHMARKING_PROTOCOL_V2,
    manifest: descriptor("analysis-manifest.json", manifest.digest),
    boundary: { sources: [{ source: capture }], resolvedAt: "2026-08-16T14:01:00.000Z" },
    members: [{
      memberKey: "memory/01",
      execution: executionReference,
      taskDigest: subject.taskDigest,
      resultDigests: [subject.resultDigest],
      groupId: "memory",
      slotId: "01",
      replicate: 0,
      correlationKey: "harbor/job-memory/trial-1",
      evaluations: { considered: evaluations, admitted: evaluations, excluded: [] },
      verifications: { considered: [], admitted: [], excluded: [] },
      labelResolutions: { considered: [], admitted: [], excluded: [] },
      assurance: {
        origin: "native-direct",
        timing: "prospective-native-observed",
        closure: "complete-relative-to-sealed-source",
        availability: "public-exact",
        limitations: [],
      },
    }],
    excludedExecutions: [],
    closure: {
      status: "complete-relative-to-sealed-source",
      candidateCount: 1,
      admittedCount: 1,
      excludedCount: 0,
      unavailableCount: 0,
      limitations: [],
    },
  });
  const resolver = {
    resolve(reference: EvidenceRecordReference) {
      const bytes = records.get(evidenceReferenceKey(reference));
      if (bytes === undefined) throw new Error(`missing ${evidenceReferenceKey(reference)}`);
      return bytes;
    },
  };
  expect(verifyEvidenceCohort({
    cohortBytes: cohort.bytes,
    manifestBytes: manifest.bytes,
    records: resolver,
  })).toMatchObject({ conforms: true });

  const parameters = { instruments: [GRADER_ID], k: 1 };
  const implementation = descriptor("assembly-3.0.json", recordDigest(json({ procedure: "3.0" })));
  const matrix = assembleEvidenceMatrix({
    cohortBytes: cohort.bytes,
    manifestBytes: manifest.bytes,
    records: resolver,
    implementation,
    deriveCell: deriveDefaultEvidenceCell,
  });
  const results = { stage: "one-member" };
  const report = await issueEvidenceNativeReport({
    matrixBytes: matrix.record.bytes,
    signer: signerFor(PUBLISHER_ID),
    report: {
      protocol: BENCHMARKING_PROTOCOL_V2,
      subjects: [descriptor("matrix-v2.json", matrix.record.digest)],
      manifest: descriptor("analysis-manifest.json", manifest.digest),
      cohort: descriptor("cohort.json", cohort.digest),
      method: {
        id: "jinn.benchmarking.method/binary-instrument",
        version: "1",
        parameters,
        implementation,
      },
      preregistration: "local-sealed-before-selection",
      results,
      disclosures: {
        evidenceOrigin: { "native-direct": 1 },
        timing: { "prospective-native-observed": 1 },
        closure: { "complete-relative-to-sealed-source": 1 },
        taskRelation: { "exact-digest": 1 },
        availability: { "public-exact": 1 },
        conflictsPreserved: 0,
        commissioningRequired: false,
      },
      limitations: [],
      author: PUBLISHER_ID,
    },
  });

  const evidence = sortReferences([executionReference, graderEvaluation]);
  const artifactDescriptors = [...artifacts].map(([digest, bytes]) => ({
    ...descriptor(`${digest}.bin`, `sha256:${digest}`),
    size: bytes.byteLength,
  })).sort(compareSha256);
  const trustSigners = [
    trustSigner(grader, "automated-evaluator"),
    trustSigner(publisher, "report"),
  ].sort(compareKeyId);
  const claim = sealEvidenceNativeClaimPackageV3({
    claimSchema: "benchmark-product.claim-package/3",
    profile: CLAIM_PACKAGE_V3_PROFILE,
    records: {
      benchmark,
      manifest: descriptor("analysis-manifest.json", manifest.digest),
      cohort: descriptor("cohort.json", cohort.digest),
      matrix: descriptor("matrix.json", matrix.record.digest),
      reportPayload: descriptor("report.json", report.payload.digest),
      reportEnvelope: descriptor("report-envelope.json", documentDigest(report.envelopeBytes)),
      evidence,
      artifacts: artifactDescriptors,
    },
    method: {
      id: "jinn.benchmarking.method/binary-instrument",
      version: "1",
      parameters,
    },
    results,
    closure: parseEvidenceCohort(cohort.bytes).closure,
    trust: {
      signers: trustSigners,
      signatureValidityIsNotAuthorization: true,
    },
    verification: {
      checks: [...EVIDENCE_NATIVE_BUNDLE_V5_CHECKS],
      command: "colophon-verify",
    },
    issuedAt: "2026-08-16T16:00:00.000Z",
  });
  const files = new Map<string, Uint8Array>([
    ["benchmark.json", benchmarkRecord.bytes],
    ["analysis-manifest.json", manifest.bytes],
    ["cohort.json", cohort.bytes],
    ["matrix.json", matrix.record.bytes],
    ["report.json", report.payload.bytes],
    ["report-envelope.json", report.envelopeBytes],
    ["claim-package.json", claim.bytes],
  ]);
  for (const reference of evidence) {
    files.set(`records/${reference.record.digest.sha256}.bin`, records.get(evidenceReferenceKey(reference))!);
  }
  for (const [digest, bytes] of artifacts) files.set(`artifacts/${digest}.bin`, bytes);
  files.set("bundle.json", buildEvidenceNativeBundleManifestV5(files).bytes);
  return {
    files,
    claim,
    graderKeyId: grader.keyId,
    publisherKeyId: publisher.keyId,
    surplusReviewerKeyId: surplus.keyId,
    surplusEvaluation: { reference: surplusReference, bytes: surplusEvaluationBytes },
    surplusPublicKey: { descriptor: publicKeyDescriptor(surplus), bytes: surplus.publicKeyBytes },
  };
}

describe("evidence-native v5 bundle signers", () => {
  test("a signed unreferenced human-reviewer still verifies and is omitted from checker signers (#3283)", async () => {
    const built = await oneMemberV5Bundle();
    const claimDocument = parseEvidenceNativeClaimPackageV3(built.claim.bytes);
    const surplusClaim = sealEvidenceNativeClaimPackageV3({
      ...claimDocument,
      records: {
        ...claimDocument.records,
        evidence: sortReferences([...claimDocument.records.evidence, built.surplusEvaluation.reference]),
        artifacts: [...claimDocument.records.artifacts, built.surplusPublicKey.descriptor]
          .sort(compareSha256),
      },
      trust: {
        ...claimDocument.trust,
        signers: [
          ...claimDocument.trust.signers,
          trustSigner(requireKey(SURPLUS_REVIEWER_ID), "human-reviewer"),
        ].sort(compareKeyId),
      },
    });
    const surplusFiles = new Map(built.files);
    surplusFiles.delete("bundle.json");
    surplusFiles.set("claim-package.json", surplusClaim.bytes);
    surplusFiles.set(
      `records/${built.surplusEvaluation.reference.record.digest.sha256}.bin`,
      built.surplusEvaluation.bytes,
    );
    surplusFiles.set(
      `artifacts/${built.surplusPublicKey.descriptor.digest.sha256}.bin`,
      built.surplusPublicKey.bytes,
    );
    surplusFiles.set("bundle.json", buildEvidenceNativeBundleManifestV5(surplusFiles).bytes);

    const bundleDir = mkdtempSync(join(tmpdir(), "signers-v5-bundle-"));
    writeBundle(bundleDir, surplusFiles);

    const snapshot = await verifyPublicBundleSnapshot(bundleDir);
    const verification = snapshot.verification;
    if (verification.format !== "benchmark-product-public-bundle/5") {
      throw new Error(`expected v5 bundle, got ${verification.format}`);
    }
    const signers = verification.signers;
    if (signers === undefined) {
      throw new Error("v5 checker must attach signers");
    }
    expect(verification.checks).toEqual([...EVIDENCE_NATIVE_BUNDLE_V5_CHECKS]);
    expect(verification.verifiedSignerKeyIds).toEqual(expect.arrayContaining([
      built.graderKeyId,
      built.publisherKeyId,
      built.surplusReviewerKeyId,
    ]));
    expect(signers).toEqual([
      { role: "automated-grader", identity: GRADER_ID, keyId: built.graderKeyId, custody: "undeclared" },
      { role: "publisher", identity: PUBLISHER_ID, keyId: built.publisherKeyId, custody: "undeclared" },
    ]);
    expect(signers.some((signer) => signer.role === "human-reviewer")).toBe(false);
    expect(signers.some((signer) => signer.keyId === built.surplusReviewerKeyId)).toBe(false);

    const cli = await runVerifierCli([bundleDir, "--json"]);
    expect(cli.exitCode).toBe(0);
    const report = JSON.parse(cli.stdout) as {
      ok: boolean;
      verifiedSignerKeyIds: string[];
      signers: Array<{ role: string; keyId: string }>;
    };
    expect(report.ok).toBe(true);
    expect(Object.keys(report).sort()).toEqual(expect.arrayContaining([
      "ok",
      "verifiedSignerKeyIds",
      "signers",
    ]));
    expect(report.verifiedSignerKeyIds).toEqual(expect.arrayContaining([built.surplusReviewerKeyId]));
    expect(report.signers.map((signer) => signer.role)).toEqual(["automated-grader", "publisher"]);
    expect(report.signers.map((signer) => signer.keyId)).not.toContain(built.surplusReviewerKeyId);
  });
});
