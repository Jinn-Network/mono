// SPDX-License-Identifier: Apache-2.0

import {
  createPublicKey,
  generateKeyPairSync,
  sign as signEd25519,
  verify as verifyEd25519,
  type KeyObject,
} from "node:crypto";
import {
  BENCHMARKING_PROTOCOL_V2,
  EXECUTION_BATCH_CAPTURE_RECORD_KIND,
  REPORT_V2_MEDIA_TYPE,
  documentDigest,
  evidenceReferenceKey,
  parseEvidenceCohort,
  sealBenchmarkDefinitionV2,
  sealBenchmarkAnalysisManifest,
  sealEvidenceCohort,
  sealEvidenceNativeClaimPackageV3,
  sealHumanLabelResolutionPayload,
  BENCHMARK_PRODUCT_PUBLIC_BUNDLE_V5_METADATA_FIRST_PROFILE,
  BENCHMARK_PRODUCT_PUBLIC_BUNDLE_V5_PROFILE,
  parseEvidenceNativeBundleManifestV5,
  type DigestBearingResourceDescriptor,
  type EvidenceRecordReference,
} from "@jinn-network/benchmarking-protocol";
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
import { dssePreAuthEncoding, sealSignedPayload, type DsseSigner } from "@jinn-network/trust-core";
import { describe, expect, test } from "vitest";

import {
  assembleEvidenceMatrix,
  buildEvidenceNativeBundleManifestV5,
  projectMetadataFirstEvidenceNativeBundle,
  computeEvidenceBinaryInstrumentQualification,
  deriveDefaultEvidenceCell,
  issueEvidenceNativeReport,
  verifyEvidenceNativePortableBundle,
  verifyEvidenceCohort,
  verifyEvidenceMatrix,
  verifyEvidenceNativeReport,
} from "./index.js";

const encoder = new TextEncoder();
const origin = { kind: "producer-observed", observer: "urn:agent:colophon-golden" } as const;

interface GoldenSigningKey {
  readonly identity: string;
  readonly keyId: string;
  readonly privateKey: KeyObject;
  readonly publicKeyBytes: Uint8Array;
}

const signingKeys = new Map([
  ...["A", "B", "C", "D"].map((armId) => ({
    identity: `urn:evaluator:instrument-${armId}`,
    keyId: `urn:key:urn:evaluator:instrument-${armId}`,
  })),
  ...["alice", "bob"].map((reviewer) => ({
    identity: `urn:reviewer:${reviewer}`,
    keyId: `urn:key:urn:reviewer:${reviewer}`,
  })),
  { identity: "urn:issuer:human-label-resolution", keyId: "urn:key:label-admission" },
  { identity: "urn:publisher:colophon", keyId: "urn:key:report" },
].map(({ identity, keyId }) => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const value: GoldenSigningKey = {
    identity,
    keyId,
    privateKey,
    publicKeyBytes: new Uint8Array(publicKey.export({ format: "der", type: "spki" })),
  };
  return [identity, value] as const;
}));

function signerFor(identity: string): DsseSigner {
  const key = signingKeys.get(identity);
  if (key === undefined) throw new Error(`missing golden signing key for ${identity}`);
  return async ({ preAuthEncoding }) => [{
    keyid: key.keyId,
    signature: new Uint8Array(signEd25519(null, preAuthEncoding, key.privateKey)),
  }];
}

const labelSigner = signerFor("urn:issuer:human-label-resolution");
const reportSigner = signerFor("urn:publisher:colophon");

function json(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function artifact(bytes: Uint8Array, name: string, mediaType: string): ExecutionEvidenceArtifactSource {
  return { digest: recordDigest(bytes), size: bytes.byteLength, name, mediaType };
}

function descriptor(name: string, digest: `sha256:${string}`, mediaType?: string): DigestBearingResourceDescriptor {
  return { name, digest: { sha256: digest.slice(7) }, ...(mediaType === undefined ? {} : { mediaType }) };
}

function ref(family: EvidenceRecordReference["family"], name: string, bytes: Uint8Array): EvidenceRecordReference {
  return { family, record: descriptor(name, recordDigest(bytes)) };
}

function uuid(index: number): `urn:uuid:${string}` {
  return `urn:uuid:${index.toString(16).padStart(8, "0")}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function execution(input: {
  readonly id: number;
  readonly name: string;
  readonly taskBytes: Uint8Array;
  readonly resultBytes: Uint8Array;
  readonly runtimeName: "Harbor" | "Inspect";
}): {
  readonly bytes: Uint8Array;
  readonly taskDigest: `sha256:${string}`;
  readonly resultDigest: `sha256:${string}`;
  readonly artifacts: ReadonlyMap<string, Uint8Array>;
} {
  const task = artifact(input.taskBytes, `${input.name}-task.json`, "application/json");
  const result = artifact(input.resultBytes, `${input.name}-result.json`, "application/json");
  const runtimeBytes = json({ runtime: input.runtimeName, version: input.runtimeName === "Harbor" ? "0.21.0" : "0.3.255" });
  const traceBytes = json({ events: [], unit: input.name });
  const executableBytes = encoder.encode(`${input.runtimeName} executable`);
  const runtime = artifact(runtimeBytes, `${input.runtimeName.toLowerCase()}-runtime.json`, "application/json");
  const trace = artifact(traceBytes, `${input.name}-trace.json`, "application/json");
  const executable = artifact(executableBytes, input.runtimeName.toLowerCase(), "application/octet-stream");
  const builderInput: ExecutionEvidenceBuilderInput = {
    recording: {
      executionId: uuid(input.id),
      startedAt: `2026-08-16T09:${String(input.id % 60).padStart(2, "0")}:00.000Z`,
      record: {
        name: input.name,
        description: `One native ${input.runtimeName} atomic execution.`,
        license: "https://creativecommons.org/publicdomain/zero/1.0/",
      },
      task: { entityId: "task/input.json", name: task.name!, source: task, origin },
      initialInputs: [],
      executor: {
        entityId: input.runtimeName === "Harbor" ? "urn:agent:memory-system" : "urn:agent:inspect-judge",
        kind: "software",
        name: input.runtimeName === "Harbor" ? "Memory system" : "Inspect judge",
        origin,
      },
      runtime: {
        entityId: "runtime/runtime.json",
        specification: runtime,
        name: input.runtimeName,
        softwareVersion: input.runtimeName === "Harbor" ? "0.21.0" : "0.3.255",
        origin,
        components: [{
          kind: "controlled",
          artifact: { kind: "file", entityId: "runtime/executable", source: executable, origin },
        }],
      },
      producer: {
        entityId: "urn:agent:colophon-golden",
        kind: "software",
        name: "Colophon golden capture",
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
      format: { entityId: input.runtimeName === "Harbor" ? "https://harborframework.com/formats/atif" : "https://inspect.aisi.org.uk/formats/eval-sample-trace" },
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
  readonly supportingExecution?: EvidenceRecordReference;
  readonly human?: boolean;
  readonly parseValid?: boolean;
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
      verdict: input.opinion === "ACCEPT" ? "pass" : input.opinion === "REJECT" ? "fail" : "inconclusive",
      measurements: input.human === true
        ? [{ name: "humanLabel", value: input.opinion }, { name: "blindIndependentReview", value: true }]
        : [{ name: "binary-opinion", value: input.opinion }, { name: "parseValid", value: input.parseValid ?? true }],
      evidence: input.supportingExecution === undefined ? [] : [{
        name: "evaluator-execution.ro-crate-metadata.json",
        digest: input.supportingExecution.record.digest,
        mediaType: "application/ld+json",
        annotations: { "https://spec.jinn.network/relationships/supporting-evaluator-execution": true },
      }],
      limitations: [],
    },
  };
  const payload = json(statement);
  const key = signingKeys.get(input.evaluator);
  if (key === undefined) throw new Error(`missing golden signing key for ${input.evaluator}`);
  const signature = signEd25519(null, dssePreAuthEncoding(DSSE_PAYLOAD_TYPE, payload), key.privateKey);
  const bytes = json({
    payloadType: DSSE_PAYLOAD_TYPE,
    payload: Buffer.from(payload).toString("base64"),
    signatures: [{ keyid: key.keyId, sig: signature.toString("base64") }],
  });
  expect(validateResultEvaluation(bytes)).toMatchObject({ conforms: true, diagnostics: [] });
  return bytes;
}

function sortReferences(values: readonly EvidenceRecordReference[]): EvidenceRecordReference[] {
  return [...values].sort((left, right) => evidenceReferenceKey(left).localeCompare(evidenceReferenceKey(right), "en", { sensitivity: "variant" }));
}

describe("Harbor → Inspect → human evidence-first golden lifecycle", () => {
  test("appends evaluator D without rerunning or mutating twelve original memory subjects", async () => {
    const records = new Map<string, Uint8Array>();
    const artifacts = new Map<string, Uint8Array>();
    const put = (reference: EvidenceRecordReference, bytes: Uint8Array) => {
      records.set(evidenceReferenceKey(reference), bytes);
      return reference;
    };
    const keepArtifacts = (values: ReadonlyMap<string, Uint8Array>) => {
      for (const [digest, bytes] of values) {
        const existing = artifacts.get(digest);
        if (existing !== undefined && recordDigest(existing).slice(7) !== recordDigest(bytes).slice(7)) {
          throw new Error(`artifact digest collision at sha256:${digest}`);
        }
        artifacts.set(digest, bytes);
      }
    };
    const instruments = ["A", "B", "C", "D"].map((armId, index) => ({
      armId,
      instrumentSha256: recordDigest(json({ instrument: armId, sealed: true, version: 1 + index * 0 })),
    }));
    // Exact PR #2706 qualification-144 outcomes, with the four frozen arms renamed A/B/C/D.
    // The old fixture's prompt included its reference answer; this evidence-first replay keeps
    // those registered outcomes and method semantics while deliberately constructing a blind
    // evaluator Task below. Bundle v4 bytes remain frozen and unchanged.
    const qualificationOutcomes = [
      ["AAA", "RRR", "AAA", "AAA"],
      ["RRR", "AAA", "RRR", "RRR"],
      ["AAA", "AAR", "AAA", "AAA"],
      ["RRR", "RRR", "IRR", "RRR"],
      ["AAA", "AAA", "AAA", "RRR"],
      ["RRR", "RRR", "RRR", "AAA"],
      ["AAA", "AAA", "AAA", "AAR"],
      ["RRR", "RRR", "RRR", "RRR"],
      ["AAA", "AAA", "AAA", "AAA"],
      ["RRR", "RRR", "RRR", "RRR"],
      ["AAA", "AAA", "AAA", "AAA"],
      ["RRR", "RRR", "RRR", "RRX"],
    ] as const;
    const humanMethod = recordDigest(json({ method: "blind-human-review", version: 1 }));
    const originals: {
      memberKey: string;
      execution: EvidenceRecordReference;
      taskDigest: `sha256:${string}`;
      resultDigest: `sha256:${string}`;
      truth: "ACCEPT" | "REJECT";
      humanEvaluations: EvidenceRecordReference[];
      resolution: EvidenceRecordReference;
      automated: Record<string, EvidenceRecordReference[]>;
    }[] = [];
    const evaluatorExecutions: EvidenceRecordReference[] = [];
    const judgeTaskBytes: Uint8Array[] = [];
    let nextExecution = 100;
    for (let item = 0; item < 12; item += 1) {
      const taskBytes = json({ question: `Memory question ${item + 1}`, context: [`fact-${item + 1}`] });
      const resultBytes = json({ answer: `candidate-${item + 1}` });
      const subject = execution({ id: item + 1, name: `harbor-trial-${item + 1}`, taskBytes, resultBytes, runtimeName: "Harbor" });
      keepArtifacts(subject.artifacts);
      const subjectReference = put(ref("execution-evidence", "ro-crate-metadata.json", subject.bytes), subject.bytes);
      const truth = item % 2 === 0 ? "ACCEPT" as const : "REJECT" as const;
      const humanEvaluations: EvidenceRecordReference[] = [];
      for (const reviewer of ["alice", "bob"] as const) {
        const bytes = evaluation({
          taskDigest: subject.taskDigest,
          resultDigest: subject.resultDigest,
          evaluator: `urn:reviewer:${reviewer}`,
          methodDigest: humanMethod,
          opinion: truth,
          evaluatedAt: `2026-08-16T11:${String(item).padStart(2, "0")}:0${reviewer === "alice" ? 1 : 2}.000Z`,
          human: true,
        });
        humanEvaluations.push(put(ref("result-evaluation", `${reviewer}.dsse.json`, bytes), bytes));
      }
      const resolutionPayload = sealHumanLabelResolutionPayload({
        protocol: BENCHMARKING_PROTOCOL_V2,
        task: descriptor("memory-task.json", subject.taskDigest),
        results: [descriptor("candidate-answer.json", subject.resultDigest)],
        policy: {
          id: "https://spec.jinn.network/policies/two-human-unanimity/v1",
          version: "1.0.0",
          requiredReviewers: 2,
          agreement: "unanimous",
        },
        basis: {
          kind: "independent-human-evaluations",
          evaluations: sortReferences(humanEvaluations),
          reviewers: ["urn:reviewer:alice", "urn:reviewer:bob"],
        },
        resolution: { status: "admitted", label: truth },
        admittingOperator: "urn:operator:admission",
        publisher: "urn:publisher:colophon",
        issuer: "urn:issuer:human-label-resolution",
        resolvedAt: "2026-08-16T12:00:00.000Z",
      });
      const resolutionEnvelope = await sealSignedPayload({
        payloadBytes: resolutionPayload.bytes,
        payloadType: "application/vnd.jinn.benchmarking.human-label-resolution.v1+json",
        signer: labelSigner,
      });
      const resolution = put(ref("human-label-resolution", "human-label-resolution.dsse.json", resolutionEnvelope.envelopeBytes), resolutionEnvelope.envelopeBytes);
      const automated: Record<string, EvidenceRecordReference[]> = { A: [], B: [], C: [], D: [] };
      for (const instrument of instruments) {
        for (let call = 1; call <= 3; call += 1) {
          const judgeTask = json({
            instruction: `Apply sealed instrument ${instrument.armId}`,
            originalTask: JSON.parse(new TextDecoder().decode(taskBytes)),
            candidateResult: JSON.parse(new TextDecoder().decode(resultBytes)),
          });
          judgeTaskBytes.push(judgeTask);
          const instrumentIndex = instruments.findIndex(({ armId }) => armId === instrument.armId);
          const token = qualificationOutcomes[item]![instrumentIndex]![call - 1]!;
          const opinion = token === "A" ? "ACCEPT" : token === "R" || token === "I" ? "REJECT" : "inconclusive";
          const parseValid = token !== "I";
          const responseBytes = json({ opinion, parseValid, observation: `instrument-${instrument.armId}-call-${call}` });
          const evaluatorExecution = execution({
            id: nextExecution++,
            name: `inspect-${instrument.armId}-${item + 1}-${call}`,
            taskBytes: judgeTask,
            resultBytes: responseBytes,
            runtimeName: "Inspect",
          });
          keepArtifacts(evaluatorExecution.artifacts);
          const evaluatorReference = put(ref("execution-evidence", "ro-crate-metadata.json", evaluatorExecution.bytes), evaluatorExecution.bytes);
          evaluatorExecutions.push(evaluatorReference);
          const evaluationBytes = evaluation({
            taskDigest: subject.taskDigest,
            resultDigest: subject.resultDigest,
            evaluator: `urn:evaluator:instrument-${instrument.armId}`,
            methodDigest: instrument.instrumentSha256,
            opinion,
            parseValid,
            supportingExecution: evaluatorReference,
            evaluatedAt: `2026-08-16T13:${String(item).padStart(2, "0")}:${String(call).padStart(2, "0")}.000Z`,
          });
          automated[instrument.armId]!.push(put(ref("result-evaluation", `${instrument.armId}-${call}.dsse.json`, evaluationBytes), evaluationBytes));
        }
      }
      originals.push({
        memberKey: `memory/${String(item + 1).padStart(2, "0")}`,
        execution: subjectReference,
        taskDigest: subject.taskDigest,
        resultDigest: subject.resultDigest,
        truth,
        humanEvaluations,
        resolution,
        automated,
      });
    }

    expect(originals).toHaveLength(12);
    expect(evaluatorExecutions).toHaveLength(144);
    expect(originals.flatMap(({ automated }) => Object.values(automated).flat())).toHaveLength(144);
    expect(originals.flatMap(({ humanEvaluations }) => humanEvaluations)).toHaveLength(24);
    expect(judgeTaskBytes.every((bytes) => !/truth|reference.?answer|CORRECT|WRONG/u.test(new TextDecoder().decode(bytes)))).toBe(true);

    const benchmarkRecord = sealBenchmarkDefinitionV2({
      protocol: BENCHMARKING_PROTOCOL_V2,
      name: "Memory evaluator qualification golden lifecycle",
      description: "Twelve exact memory tasks evaluated without rerunning their Harbor executions.",
      author: "urn:agent:analysis-owner",
      version: "1.0.0",
      items: originals.map(({ taskDigest }, index) => ({
        task: descriptor(`memory-task-${index + 1}.json`, taskDigest, "application/json"),
        identifiers: [{ scheme: "https://harborframework.com/identifiers/task", value: `memory-${index + 1}` }],
      })).sort((left, right) => left.task.digest.sha256.localeCompare(right.task.digest.sha256)),
      reveal: { policy: "immediate" },
      license: "https://creativecommons.org/publicdomain/zero/1.0/",
    });
    const benchmark = descriptor("benchmark-v2.json", benchmarkRecord.digest);
    const capture = {
      recordKind: EXECUTION_BATCH_CAPTURE_RECORD_KIND,
      record: descriptor("harbor-capture.json", recordDigest(json({ units: 12 }))),
    };
    const manifest = sealBenchmarkAnalysisManifest({
      protocol: BENCHMARKING_PROTOCOL_V2,
      benchmark,
      owner: "urn:agent:analysis-owner",
      sources: [{ source: capture, cutoff: "2026-08-16T14:00:00.000Z" }],
      groups: [{ groupId: "memory", selection: descriptor("all-twelve.json", recordDigest(json({ all: 12 }))) }],
      taskRelation: { exactDigestRequired: true },
      multiplicity: {
        correlationUnit: "execution",
        duplicatePolicy: "retain-distinct",
        retryPolicy: "correlated",
        assignmentPolicy: descriptor("assignment.json", recordDigest(json({ slot: "native-trial" }))),
      },
      evaluationAdmission: {
        evaluatorAllowlist: [
          "urn:evaluator:instrument-A", "urn:evaluator:instrument-B", "urn:evaluator:instrument-C", "urn:evaluator:instrument-D",
          "urn:reviewer:alice", "urn:reviewer:bob",
        ],
        methodAllowlist: [...instruments.map(({ armId, instrumentSha256 }) => descriptor(`${armId}.json`, instrumentSha256)), descriptor("human.json", humanMethod)]
          .sort((left, right) => left.digest.sha256.localeCompare(right.digest.sha256)),
        minimumClaims: 1,
        distinctEvaluators: true,
        humanLabelPolicy: "two-human-unanimous",
        conflictPolicy: "preserve-unresolved",
        supersessionPolicy: "preserve-all",
        trustPolicy: descriptor("trust.json", recordDigest(json({ policy: "golden" }))),
      },
      verificationAdmission: {
        requiredChecks: [],
        trustPolicy: descriptor("verification-trust.json", recordDigest(json({ policy: "golden" }))),
        failurePolicy: "disclose",
      },
      completeness: {
        required: "complete",
        unavailableSource: "indeterminate",
        discoveredOmission: "fail",
        excludedMember: "count-attrition",
      },
      analysisPlan: [{ id: "jinn.benchmarking.method/binary-instrument", version: "1", parameters: { k: 3 } }],
      closeAt: "2026-08-16T14:00:00.000Z",
      preregistration: "local-sealed-before-selection",
    });

    const freeze = (arms: readonly string[], resolvedAt: string, supersedes?: `sha256:${string}`) => sealEvidenceCohort({
      protocol: BENCHMARKING_PROTOCOL_V2,
      manifest: descriptor("analysis-manifest.json", manifest.digest),
      boundary: { sources: [{ source: capture }], resolvedAt },
      members: originals.map((subject, index) => {
        const automated = arms.flatMap((arm) => subject.automated[arm]!);
        const evaluations = sortReferences([...automated, ...subject.humanEvaluations]);
        return {
          memberKey: subject.memberKey,
          execution: subject.execution,
          taskDigest: subject.taskDigest,
          resultDigests: [subject.resultDigest],
          groupId: "memory",
          slotId: String(index + 1).padStart(2, "0"),
          replicate: 0,
          correlationKey: `harbor/job-memory/trial-${index + 1}`,
          evaluations: { considered: evaluations, admitted: evaluations, excluded: [] },
          verifications: { considered: [], admitted: [], excluded: [] },
          labelResolutions: { considered: [subject.resolution], admitted: [subject.resolution], excluded: [] },
          assurance: {
            origin: "native-direct",
            timing: "prospective-native-observed",
            closure: "complete-relative-to-sealed-source",
            availability: "public-exact",
            limitations: [],
          },
        };
      }),
      excludedExecutions: [],
      closure: {
        status: "complete-relative-to-sealed-source",
        candidateCount: 12,
        admittedCount: 12,
        excludedCount: 0,
        unavailableCount: 0,
        limitations: [],
      },
      ...(supersedes === undefined ? {} : { supersedes: descriptor("prior-cohort.json", supersedes) }),
    });
    const resolver = {
      resolve(reference: EvidenceRecordReference) {
        const bytes = records.get(evidenceReferenceKey(reference));
        if (bytes === undefined) throw new Error(`missing ${evidenceReferenceKey(reference)}`);
        return bytes;
      },
    };
    const cohortABC = freeze(["A", "B", "C"], "2026-08-16T14:01:00.000Z");
    const verifiedABC = verifyEvidenceCohort({ cohortBytes: cohortABC.bytes, manifestBytes: manifest.bytes, records: resolver });
    expect(verifiedABC).toMatchObject({ conforms: true, members: { length: 12 } });
    if (!verifiedABC.conforms) throw new Error("A/B/C cohort must conform");
    expect(verifiedABC.members.reduce((sum, member) => sum + member.evaluations.size, 0)).toBe(132);

    const deriveCell = deriveDefaultEvidenceCell;
    const implementation = descriptor("assembly-3.0.json", recordDigest(json({ procedure: "3.0" })));
    const matrixABC = assembleEvidenceMatrix({
      cohortBytes: cohortABC.bytes,
      manifestBytes: manifest.bytes,
      records: resolver,
      implementation,
      deriveCell,
    });
    const reportABC = await issueEvidenceNativeReport({
      matrixBytes: matrixABC.record.bytes,
      signer: reportSigner,
      report: {
        protocol: BENCHMARKING_PROTOCOL_V2,
        subjects: [descriptor("matrix-v2.json", matrixABC.record.digest)],
        manifest: descriptor("analysis-manifest.json", manifest.digest),
        cohort: descriptor("cohort-abc.json", cohortABC.digest),
        method: {
          id: "jinn.benchmarking.method/binary-instrument",
          version: "1",
          parameters: { instruments: ["A", "B", "C"], k: 3 },
          implementation,
        },
        preregistration: "local-sealed-before-selection",
        results: { stage: "ABC" },
        disclosures: {
          evidenceOrigin: { "native-direct": 12 },
          timing: { "prospective-native-observed": 12 },
          closure: { "complete-relative-to-sealed-source": 12 },
          taskRelation: { "exact-digest": 12 },
          availability: { "public-exact": 12 },
          conflictsPreserved: 0,
          commissioningRequired: false,
        },
        limitations: [],
        author: "urn:publisher:colophon",
      },
    });
    const frozenABC = {
      cohort: cohortABC.digest,
      matrix: matrixABC.record.digest,
      reportPayload: reportABC.payload.digest,
      reportEnvelope: documentDigest(reportABC.envelopeBytes),
    };

    const cohortABCD = freeze(["A", "B", "C", "D"], "2026-08-16T15:01:00.000Z", cohortABC.digest);
    const verifiedABCD = verifyEvidenceCohort({ cohortBytes: cohortABCD.bytes, manifestBytes: manifest.bytes, records: resolver });
    expect(verifiedABCD).toMatchObject({ conforms: true, members: { length: 12 } });
    if (!verifiedABCD.conforms) throw new Error("A/B/C/D cohort must conform");
    expect(verifiedABCD.members.reduce((sum, member) => sum + member.evaluations.size, 0)).toBe(168);
    expect(frozenABC).toEqual({
      cohort: cohortABC.digest,
      matrix: matrixABC.record.digest,
      reportPayload: reportABC.payload.digest,
      reportEnvelope: documentDigest(reportABC.envelopeBytes),
    });

    const parameters = {
      verdictRule: "sole",
      k: 3,
      reduction: "strict-majority",
      measurementProfile: "binary-instrument@1",
      candidateClasses: ["memory"],
      strata: ["core", "stress"],
      parserInvalidPolicy: "reject",
      truthAdmission: "two-human-unanimous",
      intervalAlpha: "0.05",
    };
    const qualification = computeEvidenceBinaryInstrumentQualification({
      cohort: verifiedABCD,
      parameters,
      instruments,
      contexts: originals.map((subject, index) => ({
        memberKey: subject.memberKey,
        candidateClass: "memory",
        stratum: index < 6 ? "core" as const : "stress" as const,
      })),
      analysisContextSha256: manifest.digest,
    }) as Record<string, any>;
    expect(Object.keys(qualification.arms)).toEqual(["A", "B", "C", "D"]);
    expect(qualification.itemDecisions).toHaveLength(47);
    expect(qualification.arms.A.confusion).toEqual({
      correctAccepted: 6,
      correctRejected: 0,
      wrongAccepted: 0,
      wrongRejected: 6,
    });
    expect(qualification.arms.B).toMatchObject({
      item: { expected: 12, complete: 12, excluded: 0, unstable: 1 },
      call: { expected: 36, evaluated: 36, parseInvalid: 0 },
      confusion: { correctAccepted: 5, correctRejected: 1, wrongAccepted: 1, wrongRejected: 5 },
    });
    expect(qualification.arms.C).toMatchObject({
      item: { expected: 12, complete: 12, excluded: 0, unstable: 0 },
      call: { expected: 36, evaluated: 36, parseInvalid: 1 },
      confusion: { correctAccepted: 6, correctRejected: 0, wrongAccepted: 0, wrongRejected: 6 },
    });
    expect(qualification.arms.D).toMatchObject({
      item: { expected: 12, complete: 11, excluded: 1, unstable: 1 },
      call: { expected: 36, evaluated: 35, parseInvalid: 0 },
      confusion: { correctAccepted: 5, correctRejected: 1, wrongAccepted: 1, wrongRejected: 4 },
    });
    expect(qualification.excluded.count).toBe(1);

    const matrixABCD = assembleEvidenceMatrix({
      cohortBytes: cohortABCD.bytes,
      manifestBytes: manifest.bytes,
      records: resolver,
      implementation,
      deriveCell,
    });
    expect(verifyEvidenceMatrix({
      matrixBytes: matrixABCD.record.bytes,
      cohortBytes: cohortABCD.bytes,
      manifestBytes: manifest.bytes,
      records: resolver,
      implementation,
      deriveCell,
    })).toMatchObject({ conforms: true });
    const finalReport = await issueEvidenceNativeReport({
      matrixBytes: matrixABCD.record.bytes,
      signer: reportSigner,
      report: {
        protocol: BENCHMARKING_PROTOCOL_V2,
        subjects: [descriptor("matrix-v2.json", matrixABCD.record.digest)],
        manifest: descriptor("analysis-manifest.json", manifest.digest),
        cohort: descriptor("cohort-abcd.json", cohortABCD.digest),
        method: {
          id: "jinn.benchmarking.method/binary-instrument",
          version: "1",
          parameters,
          implementation,
        },
        preregistration: "local-sealed-before-selection",
        results: qualification,
        disclosures: {
          evidenceOrigin: { "native-direct": 156 },
          timing: { "prospective-native-observed": 156 },
          closure: { "complete-relative-to-sealed-source": 12 },
          taskRelation: { "exact-digest": 12 },
          availability: { "public-exact": 12 },
          conflictsPreserved: 0,
          commissioningRequired: false,
        },
        limitations: [],
        author: "urn:publisher:colophon",
      },
    });
    expect(verifyEvidenceNativeReport({
      envelopeBytes: finalReport.envelopeBytes,
      matrixBytes: matrixABCD.record.bytes,
    }).report.results).toEqual(qualification);
    expect(new TextDecoder().decode(matrixABCD.record.bytes)).not.toMatch(/Submission|Attempt|Delivery/u);
    expect(REPORT_V2_MEDIA_TYPE).toBe("application/vnd.jinn.benchmarking.report.v2+json");

    const publicKeys = new Map<string, DigestBearingResourceDescriptor>();
    for (const key of signingKeys.values()) {
      const digest = recordDigest(key.publicKeyBytes).slice(7);
      artifacts.set(digest, key.publicKeyBytes);
      publicKeys.set(key.identity, descriptor(
        `${encodeURIComponent(key.identity)}.ed25519-public-key.der`,
        `sha256:${digest}`,
        "application/vnd.jinn.ed25519-public-key+der",
      ));
    }
    const evidence = sortReferences([
      ...originals.map(({ execution }) => execution),
      ...evaluatorExecutions,
      ...originals.flatMap(({ humanEvaluations }) => humanEvaluations),
      ...originals.flatMap(({ resolution }) => [resolution]),
      ...originals.flatMap(({ automated }) => Object.values(automated).flat()),
    ]);
    const artifactDescriptors = [...artifacts].map(([digest, bytes]) => ({
      ...descriptor(`${digest}.bin`, `sha256:${digest}`),
      size: bytes.byteLength,
    })).sort((left, right) => left.digest.sha256.localeCompare(right.digest.sha256));
    const trustSigner = (
      identity: string,
      purpose: "automated-evaluator" | "human-reviewer" | "label-admission" | "report",
    ) => {
      const key = signingKeys.get(identity)!;
      return { keyId: key.keyId, identity, purpose, publicKey: publicKeys.get(identity)!, algorithm: "ed25519" as const };
    };
    const trustSigners = [
      ...instruments.map(({ armId }) => trustSigner(`urn:evaluator:instrument-${armId}`, "automated-evaluator")),
      ...(["alice", "bob"] as const).map((reviewer) => trustSigner(`urn:reviewer:${reviewer}`, "human-reviewer")),
      trustSigner("urn:issuer:human-label-resolution", "label-admission"),
      trustSigner("urn:publisher:colophon", "report"),
    ].sort((left, right) => left.keyId.localeCompare(right.keyId));
    const claim = sealEvidenceNativeClaimPackageV3({
      claimSchema: "benchmark-product.claim-package/3",
      profile: "https://spec.jinn.network/profiles/claim-package/3",
      records: {
        benchmark,
        manifest: descriptor("analysis-manifest.json", manifest.digest),
        cohort: descriptor("cohort.json", cohortABCD.digest),
        matrix: descriptor("matrix.json", matrixABCD.record.digest),
        reportPayload: descriptor("report.json", finalReport.payload.digest),
        reportEnvelope: descriptor("report-envelope.json", documentDigest(finalReport.envelopeBytes)),
        evidence,
        artifacts: artifactDescriptors,
      },
      method: {
        id: "jinn.benchmarking.method/binary-instrument",
        version: "1",
        parameters,
      },
      results: qualification,
      closure: parseEvidenceCohort(cohortABCD.bytes).closure,
      trust: {
        signers: trustSigners,
        signatureValidityIsNotAuthorization: true,
      },
      verification: {
        checks: [
          "manifest",
          "evidence-closure",
          "artifact-integrity",
          "signature-validity",
          "matrix-rederivation",
          "report-verification",
          "claim-consistency",
        ],
        command: "colophon-verify evidence-bundle ./bundle",
      },
      issuedAt: "2026-08-16T16:00:00.000Z",
    });
    const bundleFiles = new Map<string, Uint8Array>([
      ["benchmark.json", benchmarkRecord.bytes],
      ["analysis-manifest.json", manifest.bytes],
      ["cohort.json", cohortABCD.bytes],
      ["matrix.json", matrixABCD.record.bytes],
      ["report.json", finalReport.payload.bytes],
      ["report-envelope.json", finalReport.envelopeBytes],
      ["claim-package.json", claim.bytes],
    ]);
    for (const reference of evidence) {
      bundleFiles.set(`records/${reference.record.digest.sha256}.bin`, records.get(evidenceReferenceKey(reference))!);
    }
    for (const [digest, bytes] of artifacts) bundleFiles.set(`artifacts/${digest}.bin`, bytes);
    const bundleManifest = buildEvidenceNativeBundleManifestV5(bundleFiles);
    bundleFiles.set("bundle.json", bundleManifest.bytes);
    const portable = await verifyEvidenceNativePortableBundle({
      files: bundleFiles,
      verifySignature: ({ publicKeyBytes, preAuthEncoding, signature }) => {
        const key = createPublicKey({ key: Buffer.from(publicKeyBytes), format: "der", type: "spki" });
        return key.asymmetricKeyType === "ed25519" && verifyEd25519(
          null,
          Buffer.from(preAuthEncoding),
          key,
          Buffer.from(signature),
        );
      },
    });
    expect(portable).toMatchObject({
      format: "benchmark-product-public-bundle/5",
      checks: [
        "manifest",
        "evidence-closure",
        "artifact-integrity",
        "signature-validity",
        "matrix-rederivation",
        "report-verification",
        "claim-consistency",
      ],
      evidenceRecords: 336,
    });

    // `trust.signers` is a publisher-written lookup table: the closure never contradicts an entry
    // no signature selects. A surplus declaration must therefore stay out of the verified set, or a
    // reader-facing surface built on it would print a reviewer that signed nothing (issue #3024).
    expect(portable.verifiedSignerKeyIds.length).toBeGreaterThan(0);
    const surplusClaimDocument = JSON.parse(new TextDecoder().decode(claim.bytes)) as any;
    surplusClaimDocument.trust.signers = [...surplusClaimDocument.trust.signers, {
      ...surplusClaimDocument.trust.signers[0],
      keyId: "zz-declared-but-never-used",
      identity: "urn:evaluator:declared-but-never-used",
      purpose: "human-reviewer",
    }];
    const surplusClaim = sealEvidenceNativeClaimPackageV3(surplusClaimDocument);
    const surplusFiles = new Map(bundleFiles);
    surplusFiles.delete("bundle.json");
    surplusFiles.set("claim-package.json", surplusClaim.bytes);
    surplusFiles.set("bundle.json", buildEvidenceNativeBundleManifestV5(surplusFiles).bytes);
    const withSurplus = await verifyEvidenceNativePortableBundle({
      files: surplusFiles,
      verifySignature: ({ publicKeyBytes, preAuthEncoding, signature }) => {
        const key = createPublicKey({ key: Buffer.from(publicKeyBytes), format: "der", type: "spki" });
        return key.asymmetricKeyType === "ed25519" && verifyEd25519(
          null,
          Buffer.from(preAuthEncoding),
          key,
          Buffer.from(signature),
        );
      },
    });
    expect(withSurplus.verifiedSignerKeyIds).toEqual(portable.verifiedSignerKeyIds);
    expect(withSurplus.verifiedSignerKeyIds).not.toContain("zz-declared-but-never-used");

    const unboundClaimDocument = JSON.parse(new TextDecoder().decode(claim.bytes)) as any;
    unboundClaimDocument.trust.signers[0].identity = "urn:evaluator:unbound-identity";
    const unboundClaim = sealEvidenceNativeClaimPackageV3(unboundClaimDocument);
    const unboundFiles = new Map(bundleFiles);
    unboundFiles.delete("bundle.json");
    unboundFiles.set("claim-package.json", unboundClaim.bytes);
    unboundFiles.set("bundle.json", buildEvidenceNativeBundleManifestV5(unboundFiles).bytes);
    await expect(verifyEvidenceNativePortableBundle({
      files: unboundFiles,
      verifySignature: () => true,
    })).rejects.toThrow(/invalid or unbound/u);

    // --- Metadata-first profile (issue #2986) -------------------------------------------------
    // The same bundle minus its evidence artifact bodies: same records, same digests, same seven
    // checks, with `artifact-integrity` disclosed as not fetched instead of passed or failed.
    const verifyEd25519Signature = ({ publicKeyBytes, preAuthEncoding, signature }: {
      publicKeyBytes: Uint8Array; preAuthEncoding: Uint8Array; signature: Uint8Array;
    }) => {
      const key = createPublicKey({ key: Buffer.from(publicKeyBytes), format: "der", type: "spki" });
      return key.asymmetricKeyType === "ed25519" && verifyEd25519(
        null,
        Buffer.from(preAuthEncoding),
        key,
        Buffer.from(signature),
      );
    };

    expect(parseEvidenceNativeBundleManifestV5(bundleFiles.get("bundle.json")!).profile)
      .toBe(BENCHMARK_PRODUCT_PUBLIC_BUNDLE_V5_PROFILE);
    expect(portable.profile).toBe(BENCHMARK_PRODUCT_PUBLIC_BUNDLE_V5_PROFILE);
    expect(portable.artifactContent).toMatchObject({ status: "verified", notFetched: 0, notFetchedDigests: [] });
    expect(portable.artifactContent.verified).toBe(portable.artifacts);

    const metadataFirstFiles = projectMetadataFirstEvidenceNativeBundle(bundleFiles);
    const signerPublicKeyDigests = new Set(
      trustSigners.map((signer) => signer.publicKey.digest.sha256),
    );
    const droppedPaths = [...bundleFiles.keys()].filter((path) => !metadataFirstFiles.has(path));
    expect(droppedPaths.length).toBeGreaterThan(0);
    // Only artifact bodies are dropped, and never the trust material the signature check reads.
    for (const path of droppedPaths) {
      const match = /^artifacts\/([0-9a-f]{64})\.bin$/u.exec(path);
      expect(match).not.toBeNull();
      expect(signerPublicKeyDigests.has(match![1]!)).toBe(false);
    }
    // Every retained member keeps its exact bytes; only bundle.json differs.
    for (const [path, bytes] of metadataFirstFiles) {
      if (path === "bundle.json") continue;
      expect(bytes).toBe(bundleFiles.get(path));
    }
    const metadataFirstManifest = parseEvidenceNativeBundleManifestV5(metadataFirstFiles.get("bundle.json")!);
    expect(metadataFirstManifest.format).toBe("benchmark-product-public-bundle/5");
    expect(metadataFirstManifest.profile).toBe(BENCHMARK_PRODUCT_PUBLIC_BUNDLE_V5_METADATA_FIRST_PROFILE);

    const metadataFirst = await verifyEvidenceNativePortableBundle({
      files: metadataFirstFiles,
      verifySignature: verifyEd25519Signature,
    });
    expect(metadataFirst.checks).toEqual(portable.checks);
    expect(metadataFirst.profile).toBe(BENCHMARK_PRODUCT_PUBLIC_BUNDLE_V5_METADATA_FIRST_PROFILE);
    expect(metadataFirst.artifactContent.status).toBe("not-fetched");
    expect(metadataFirst.artifactContent.notFetched).toBe(droppedPaths.length);
    expect(metadataFirst.artifactContent.notFetchedDigests)
      .toEqual([...metadataFirst.artifactContent.notFetchedDigests].sort());
    // The digests the reader is handed are exactly the bodies it can fetch from the full form.
    const declaredArtifactDigests = new Set(claimRecordsArtifactDigests(claim.bytes));
    for (const digest of metadataFirst.artifactContent.notFetchedDigests) {
      expect(declaredArtifactDigests.has(digest)).toBe(true);
      expect(bundleFiles.has(`artifacts/${digest}.bin`)).toBe(true);
    }
    // Everything the profile still promises is fully checked.
    expect(metadataFirst.evidenceRecords).toBe(portable.evidenceRecords);
    expect(metadataFirst.artifacts).toBe(portable.artifacts);
    expect(metadataFirst.matrixDigest).toBe(portable.matrixDigest);
    expect(metadataFirst.reportDigest).toBe(portable.reportDigest);
    expect(metadataFirst.verifiedSignerKeyIds).toEqual(portable.verifiedSignerKeyIds);
    // Two forms, two identities: a reader can tell which one it holds without reading a filename.
    expect(metadataFirst.identity).not.toBe(portable.identity);

    // A metadata-first bundle that carries an omitted body is not the profile it declares.
    const smuggledDigest = /^artifacts\/([0-9a-f]{64})\.bin$/u.exec(droppedPaths[0]!)![1]!;
    const smuggledFiles = new Map(metadataFirstFiles);
    smuggledFiles.delete("bundle.json");
    smuggledFiles.set(`artifacts/${smuggledDigest}.bin`, bundleFiles.get(droppedPaths[0]!)!);
    smuggledFiles.set("bundle.json", buildEvidenceNativeBundleManifestV5(smuggledFiles, {
      profile: BENCHMARK_PRODUCT_PUBLIC_BUNDLE_V5_METADATA_FIRST_PROFILE,
    }).bytes);
    await expect(verifyEvidenceNativePortableBundle({
      files: smuggledFiles,
      verifySignature: verifyEd25519Signature,
    })).rejects.toThrow(/carries the omitted artifact body/u);

    // A retained body is still digest-checked: deferring evidence never relaxes trust material.
    const retainedDigest = [...signerPublicKeyDigests][0]!;
    const tamperedFiles = new Map(metadataFirstFiles);
    tamperedFiles.delete("bundle.json");
    tamperedFiles.set(`artifacts/${retainedDigest}.bin`, new Uint8Array([0, 1, 2, 3]));
    tamperedFiles.set("bundle.json", buildEvidenceNativeBundleManifestV5(tamperedFiles, {
      profile: BENCHMARK_PRODUCT_PUBLIC_BUNDLE_V5_METADATA_FIRST_PROFILE,
    }).bytes);
    await expect(verifyEvidenceNativePortableBundle({
      files: tamperedFiles,
      verifySignature: verifyEd25519Signature,
    })).rejects.toThrow(/digest does not match its exact descriptor/u);

    // The full-evidence profile is unchanged: an omitted body is still a hard failure there.
    const truncatedFullFiles = new Map(bundleFiles);
    truncatedFullFiles.delete("bundle.json");
    truncatedFullFiles.delete(droppedPaths[0]!);
    truncatedFullFiles.set("bundle.json", buildEvidenceNativeBundleManifestV5(truncatedFullFiles).bytes);
    await expect(verifyEvidenceNativePortableBundle({
      files: truncatedFullFiles,
      verifySignature: verifyEd25519Signature,
    })).rejects.toThrow(/is missing artifacts\//u);
  });
});

function claimRecordsArtifactDigests(claimBytes: Uint8Array): readonly string[] {
  const document = JSON.parse(new TextDecoder().decode(claimBytes)) as {
    records: { artifacts: readonly { digest: { sha256: string } }[] };
  };
  return document.records.artifacts.map((artifact) => artifact.digest.sha256);
}
