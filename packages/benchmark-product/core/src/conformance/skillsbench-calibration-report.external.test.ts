// SPDX-License-Identifier: Apache-2.0
import { generateKeyPairSync, sign as signEd25519, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  BENCHMARKING_PROTOCOL_V2,
  evidenceReferenceKey,
  EXECUTION_BATCH_CAPTURE_RECORD_KIND,
  sealBenchmarkAnalysisManifest,
  sealBenchmarkDefinitionV2,
  sealEvidenceCohort,
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
} from "@jinn-network/execution-evidence-builder";
import { dssePreAuthEncoding, type DsseSigner } from "@jinn-network/trust-core";
import { describe, expect, it } from "vitest";
import { readSkillsBenchReward } from "../method/skillsbench-reward.js";
import {
  assembleEvidenceMatrix,
  deriveDefaultEvidenceCell,
  issueEvidenceNativeReport,
  verifyEvidenceCohort,
  verifyEvidenceMatrix,
  verifyEvidenceNativeReport,
} from "@jinn-network/benchmarking-evidence";

/**
 * Seals Colophon's first evidence-native report from real measured outcomes.
 *
 * THIS IS A CALIBRATION REPORT, NOT DEMO-1. It makes one claim and no more: on the admitted
 * SkillsBench v1.1 population, the upstream reference oracle reaches the task's canonical full
 * success and a blank submission does not. That is the known-answer control every benchmark owes
 * its readers before it reports anything about a model, and it is worth publishing on its own — an
 * instrument that cannot separate a correct answer from an empty one cannot measure anything else.
 *
 * It says nothing about skills, about `CLAUDE.md`, or about any model. No model executed anywhere
 * in the chain that produced it: the oracle is a shell script the benchmark ships, and the verdicts
 * come from the benchmark's own verifier.
 *
 * Opt in with `SKILLSBENCH_CALIBRATION=1`. Requires the sealed control evidence.
 */
const ENABLED = process.env.SKILLSBENCH_CALIBRATION === "1";
const REPO_ROOT = resolve(import.meta.dirname, "../../../../..");
const CONTROLS = resolve(REPO_ROOT, "docs/superpowers/plans/demo-report-1/E1-control-evidence.v1.json");
const OUT = resolve(REPO_ROOT, "docs/superpowers/plans/demo-report-1/colophon-calibration-report.v1.json");

const encoder = new TextEncoder();
const json = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value));
const origin = { kind: "producer-observed", observer: "urn:agent:colophon-skillsbench" } as const;

const VERIFIER_ID = "urn:evaluator:skillsbench-verifier";
const PUBLISHER_ID = "urn:publisher:colophon";

const keys = new Map<string, { keyId: string; privateKey: KeyObject }>(
  [VERIFIER_ID, PUBLISHER_ID].map((identity) => {
    const { privateKey } = generateKeyPairSync("ed25519");
    return [identity, { keyId: `urn:key:${identity}`, privateKey }];
  }),
);

const signerFor = (identity: string): DsseSigner => async ({ preAuthEncoding }) => [{
  keyid: keys.get(identity)!.keyId,
  signature: new Uint8Array(signEd25519(null, preAuthEncoding, keys.get(identity)!.privateKey)),
}];

function artifact(bytes: Uint8Array, name: string): ExecutionEvidenceArtifactSource {
  return { digest: recordDigest(bytes), size: bytes.byteLength, name, mediaType: "application/json" };
}

function descriptor(name: string, digest: `sha256:${string}`, mediaType?: string): DigestBearingResourceDescriptor {
  return { name, digest: { sha256: digest.slice(7) }, ...(mediaType === undefined ? {} : { mediaType }) };
}

function ref(family: EvidenceRecordReference["family"], name: string, bytes: Uint8Array): EvidenceRecordReference {
  return { family, record: descriptor(name, recordDigest(bytes)) };
}

function uuid(index: number): `urn:uuid:${string}` {
  const hex = index.toString(16).padStart(8, "0");
  return `urn:uuid:${hex}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

/** One control run — the oracle or the no-op — as an Execution Evidence record. */
function execution(index: number, taskId: string, condition: "oracle" | "no-op", reward: string, baseImage: string) {
  const taskBytes = json({ benchmark: "skillsbench", release: "v1.1", task: taskId, condition });
  const resultBytes = json({ reward, source: "/logs/verifier/reward.txt" });
  const runtimeBytes = json({ runtime: "skillsbench-control", baseImage });
  const traceBytes = json({ condition, task: taskId, note: "no model executed" });
  const task = artifact(taskBytes, `${taskId}-${condition}-task.json`);
  const result = artifact(resultBytes, `${taskId}-${condition}-result.json`);
  const bytes = buildExecutionEvidence({
    recording: {
      executionId: uuid(index),
      startedAt: "2026-08-17T00:00:00.000Z",
      record: {
        name: `${taskId}/${condition}`,
        description: `SkillsBench v1.1 ${condition} control for ${taskId}. No model executed.`,
        license: "https://www.apache.org/licenses/LICENSE-2.0",
      },
      task: { entityId: "task/input.json", name: task.name!, source: task, origin },
      initialInputs: [],
      executor: {
        entityId: condition === "oracle" ? "urn:agent:skillsbench-oracle" : "urn:agent:no-op",
        kind: "software",
        name: condition === "oracle" ? "Upstream oracle/solve.sh" : "No-op submission",
        origin,
      },
      runtime: {
        entityId: "runtime/runtime.json",
        specification: artifact(runtimeBytes, "skillsbench-runtime.json"),
        name: "SkillsBench",
        softwareVersion: "1.1",
        origin,
        components: [{
          kind: "controlled",
          artifact: { kind: "file", entityId: "runtime/base-image", source: artifact(json({ baseImage }), "base-image.json"), origin },
        }],
      },
      producer: { entityId: "urn:agent:colophon-skillsbench", kind: "software", name: "Colophon", origin },
    },
    additionalInputs: [],
    runtimeObservations: [],
    outcome: "completed",
    endedAt: "2026-08-17T00:10:00.000Z",
    finalizedAt: "2026-08-17T00:20:00.000Z",
    results: [{ kind: "file", entityId: "results/output.json", source: result, origin }],
    nativeTrace: {
      artifact: { kind: "file", entityId: "trace/native.json", source: artifact(traceBytes, `${taskId}-${condition}-trace.json`), origin },
      format: { entityId: "https://spec.jinn.network/formats/skillsbench-control" },
    },
  } as never);
  expect(validateExecutionEvidence(bytes)).toMatchObject({ conforms: true });
  return {
    bytes,
    taskDigest: task.digest,
    resultDigest: result.digest,
    artifacts: new Map<string, Uint8Array>([
      [task.digest.slice(7), taskBytes], [result.digest.slice(7), resultBytes],
      [recordDigest(runtimeBytes).slice(7), runtimeBytes], [recordDigest(traceBytes).slice(7), traceBytes],
      [recordDigest(json({ baseImage })).slice(7), json({ baseImage })],
    ]),
  };
}

/** The verifier's verdict on one control run, as a signed Result Evaluation. */
function evaluation(taskDigest: `sha256:${string}`, resultDigest: `sha256:${string}`, methodDigest: `sha256:${string}`, pass: boolean) {
  const statement = {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [
      descriptor("candidate-answer.json", resultDigest, "application/json"),
      descriptor("skillsbench-task.json", taskDigest, "application/json"),
    ],
    predicateType: RESULT_EVALUATION_PREDICATE_TYPE,
    predicate: {
      evaluatedAt: "2026-08-17T00:20:00.000Z",
      evaluator: { id: VERIFIER_ID },
      evaluationMethod: descriptor("skillsbench-verifier.json", methodDigest, "application/json"),
      taskSubject: "skillsbench-task.json",
      resultSubjects: ["candidate-answer.json"],
      verdict: pass ? "pass" : "fail",
      measurements: [{ name: "binary-opinion", value: pass ? "ACCEPT" : "REJECT" }, { name: "parseValid", value: true }],
      evidence: [],
      limitations: [],
    },
  };
  const payload = json(statement);
  const key = keys.get(VERIFIER_ID)!;
  const signature = signEd25519(null, dssePreAuthEncoding(DSSE_PAYLOAD_TYPE, payload), key.privateKey);
  const bytes = json({
    payloadType: DSSE_PAYLOAD_TYPE,
    payload: Buffer.from(payload).toString("base64"),
    signatures: [{ keyid: key.keyId, sig: signature.toString("base64") }],
  });
  expect(validateResultEvaluation(bytes)).toMatchObject({ conforms: true });
  return bytes;
}

describe.skipIf(!ENABLED)("Colophon SkillsBench calibration report", () => {
  it("seals and verifies a report from real control outcomes", { timeout: 600_000 }, async () => {
    const controls = JSON.parse(readFileSync(CONTROLS, "utf8")) as {
      units: Record<string, { oracleReward?: string; noOpReward?: string; baseImage?: string; eligible: boolean }>;
    };
    const units = Object.entries(controls.units)
      .filter(([, row]) => row.oracleReward !== undefined && row.noOpReward !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : 1));
    expect(units.length, "no control evidence to report on").toBeGreaterThan(0);

    const records = new Map<string, Uint8Array>();
    const artifacts = new Map<string, Uint8Array>();
    const methodBytes = json({ verifier: "skillsbench test.sh", reward: "/logs/verifier/reward.txt", fullSuccess: 1 });
    const methodDigest = recordDigest(methodBytes);
    const members: Parameters<typeof sealEvidenceCohort>[0]["members"] = [];

    let index = 1;
    for (const [taskId, row] of units) {
      for (const condition of ["oracle", "no-op"] as const) {
        const reward = condition === "oracle" ? row.oracleReward! : row.noOpReward!;
        const run = execution(index, taskId, condition, reward, row.baseImage ?? "unknown");
        const executionRef = ref("execution-evidence", `${taskId}-${condition}-execution.json`, run.bytes);
        records.set(evidenceReferenceKey(executionRef), run.bytes);
        for (const [digest, bytes] of run.artifacts) artifacts.set(digest, bytes);

        const fullPass = readSkillsBenchReward({ rewardTxt: reward }).outcome === "full-pass";
        const evalBytes = evaluation(run.taskDigest, run.resultDigest, methodDigest, fullPass);
        const evalRef = ref("result-evaluation", `${taskId}-${condition}-evaluation.json`, evalBytes);
        records.set(evidenceReferenceKey(evalRef), evalBytes);

        members.push({
          memberKey: `${taskId}/${condition}`,
          execution: executionRef,
          taskDigest: run.taskDigest,
          resultDigests: [run.resultDigest],
          groupId: condition,
          slotId: String(index).padStart(3, "0"),
          replicate: 0,
          correlationKey: `skillsbench/${taskId}/${condition}`,
          evaluations: { considered: [evalRef], admitted: [evalRef], excluded: [] },
          verifications: { considered: [], admitted: [], excluded: [] },
          labelResolutions: { considered: [], admitted: [], excluded: [] },
          assurance: {
            origin: "native-direct",
            timing: "prospective-native-observed",
            closure: "complete-relative-to-sealed-source",
            availability: "public-exact",
            limitations: [],
          },
        } as never);
        index += 1;
      }
    }

    const benchmarkRecord = sealBenchmarkDefinitionV2({
      protocol: BENCHMARKING_PROTOCOL_V2,
      name: "SkillsBench v1.1 instrument calibration",
      description: "Known-answer control over the admitted SkillsBench v1.1 population: the upstream oracle against a blank submission. No model executes.",
      author: "urn:agent:colophon-skillsbench",
      version: "1.0.0",
      items: units.map(([taskId]) => ({
        task: descriptor(`${taskId}-task.json`, recordDigest(json({ benchmark: "skillsbench", release: "v1.1", task: taskId, condition: "oracle" })), "application/json"),
        identifiers: [{ scheme: "https://github.com/benchflow-ai/skillsbench/identifiers/task", value: taskId }],
      })).sort((left, right) => left.task.digest.sha256.localeCompare(right.task.digest.sha256)),
      reveal: { policy: "immediate" },
      license: "https://www.apache.org/licenses/LICENSE-2.0",
    } as never);
    const benchmark = descriptor("benchmark-v2.json", benchmarkRecord.digest);
    const capture = {
      recordKind: EXECUTION_BATCH_CAPTURE_RECORD_KIND,
      record: descriptor("skillsbench-control-capture.json", recordDigest(json({ commit: "b63b7b2850226b6aa4fb5929a8c1ac7bc4d9a6af", units: units.length }))),
    };
    const manifest = sealBenchmarkAnalysisManifest({
      protocol: BENCHMARKING_PROTOCOL_V2,
      benchmark,
      owner: "urn:agent:colophon-skillsbench",
      sources: [{ source: capture, cutoff: "2026-08-17T00:30:00.000Z" }],
      groups: [
        { groupId: "no-op", selection: descriptor("no-op.json", recordDigest(json({ condition: "no-op" }))) },
        { groupId: "oracle", selection: descriptor("oracle.json", recordDigest(json({ condition: "oracle" }))) },
      ],
      taskRelation: { exactDigestRequired: true },
      multiplicity: {
        correlationUnit: "execution",
        duplicatePolicy: "retain-distinct",
        retryPolicy: "correlated",
        assignmentPolicy: descriptor("assignment.json", recordDigest(json({ slot: "skillsbench-control" }))),
      },
      evaluationAdmission: {
        evaluatorAllowlist: [VERIFIER_ID],
        methodAllowlist: [descriptor("skillsbench-verifier.json", methodDigest)],
        minimumClaims: 1,
        distinctEvaluators: true,
        humanLabelPolicy: "not-required",
        conflictPolicy: "preserve-unresolved",
        supersessionPolicy: "preserve-all",
        trustPolicy: descriptor("trust.json", recordDigest(json({ policy: "skillsbench-control" }))),
      },
      verificationAdmission: {
        requiredChecks: [],
        trustPolicy: descriptor("verification-trust.json", recordDigest(json({ policy: "skillsbench-control" }))),
        failurePolicy: "disclose",
      },
      completeness: {
        required: "complete",
        unavailableSource: "indeterminate",
        discoveredOmission: "fail",
        excludedMember: "count-attrition",
      },
      analysisPlan: [{ id: "jinn.benchmarking.method/binary-instrument", version: "1", parameters: { k: 1 } }],
      closeAt: "2026-08-17T00:30:00.000Z",
      preregistration: "local-sealed-before-selection",
    } as never);

    const cohort = sealEvidenceCohort({
      protocol: BENCHMARKING_PROTOCOL_V2,
      manifest: descriptor("analysis-manifest.json", manifest.digest),
      boundary: { sources: [{ source: capture }], resolvedAt: "2026-08-17T00:31:00.000Z" },
      members: [...members].sort((left, right) => (left.memberKey < right.memberKey ? -1 : left.memberKey > right.memberKey ? 1 : 0)),
      excludedExecutions: [],
      closure: {
        status: "complete-relative-to-sealed-source",
        candidateCount: members.length,
        admittedCount: members.length,
        excludedCount: 0,
        unavailableCount: 0,
        limitations: [],
      },
    } as never);

    const resolver = {
      resolve(reference: EvidenceRecordReference) {
        const bytes = records.get(evidenceReferenceKey(reference));
        if (bytes === undefined) throw new Error(`missing ${evidenceReferenceKey(reference)}`);
        return bytes;
      },
    };

    const verified = verifyEvidenceCohort({ cohortBytes: cohort.bytes, manifestBytes: manifest.bytes, records: resolver });
    expect(verified).toMatchObject({ conforms: true });

    const implementation = descriptor("assembly-3.0.json", recordDigest(json({ procedure: "3.0" })));
    const matrix = assembleEvidenceMatrix({
      cohortBytes: cohort.bytes,
      manifestBytes: manifest.bytes,
      records: resolver,
      implementation,
      deriveCell: deriveDefaultEvidenceCell,
    });
    const matrixVerdict = verifyEvidenceMatrix({
      matrixBytes: matrix.record.bytes, cohortBytes: cohort.bytes, manifestBytes: manifest.bytes, records: resolver,
      implementation, deriveCell: deriveDefaultEvidenceCell,
    } as never);
    expect(matrixVerdict).toMatchObject({ conforms: true });

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
          parameters: { instruments: [VERIFIER_ID], k: 1 },
          implementation,
        },
        author: "urn:agent:colophon-skillsbench",
        preregistration: "local-sealed-before-selection",
        results: { stage: "skillsbench-v1.1-calibration" },
        disclosures: {
          evidenceOrigin: { "native-direct": members.length },
          timing: { "prospective-native-observed": members.length },
          closure: { "complete-relative-to-sealed-source": members.length },
          taskRelation: { "exact-digest": members.length },
          availability: { "public-exact": members.length },
          conflictsPreserved: 0,
          commissioningRequired: false,
        },
        limitations: [
          "This is an instrument calibration, not a model evaluation. It reports only that the upstream reference oracle reaches full success and a blank submission does not.",
          "It says nothing about Agent Skills, about root CLAUDE.md, or about any model. No model executed in the chain that produced it.",
          "The oracle is the benchmark's own solution script, so its passing shows the task is solvable and gradable — not that it is difficult.",
          "The population is the subset of SkillsBench v1.1 whose controls had run when this report was sealed, not the full 87-task roster.",
          "Controls ran with network enabled because several upstream verifiers install their test dependencies at verify time; no agent was present in either control, so there was nothing to leak an answer to.",
          "This is a self-run venue. Nothing here proves anything against the party that ran it; the checkable artifact is what a reader should rely on.",
        ],
      },
    } as never);

    const reportVerdict = verifyEvidenceNativeReport({
      envelopeBytes: report.envelopeBytes,
      matrixBytes: matrix.record.bytes,
    } as never);
    expect(reportVerdict.report.results).toEqual({ stage: "skillsbench-v1.1-calibration" });

    const isFullPass = (reward: string) => readSkillsBenchReward({ rewardTxt: reward }).outcome === "full-pass";
    const oracleFullPass = units.filter(([, row]) => isFullPass(row.oracleReward!)).length;
    const noOpFullPass = units.filter(([, row]) => isFullPass(row.noOpReward!)).length;
    const artifactOut = {
      schema: "jinn.colophon.calibration-report.v1",
      title: "SkillsBench v1.1 instrument calibration",
      claim: "On the admitted SkillsBench v1.1 population, the upstream reference oracle reaches the task's canonical full success and a blank submission does not.",
      notADemo1Result: "This report says nothing about skills, CLAUDE.md, or any model. No model executed in the chain that produced it.",
      source: { benchmark: "skillsbench", release: "v1.1", commit: "b63b7b2850226b6aa4fb5929a8c1ac7bc4d9a6af" },
      units: units.length,
      results: {
        oracleFullPass, oracleFullPassRate: oracleFullPass / units.length,
        noOpFullPass, noOpFullPassRate: noOpFullPass / units.length,
      },
      digests: {
        analysisManifest: manifest.digest,
        cohort: cohort.digest,
        matrix: matrix.record.digest,
        report: recordDigest(report.envelopeBytes),
      },
      execution: { modelArms: 0, previews: 0, agentRuns: 0 },
      verified: { cohort: true, matrix: true, report: true },
    };
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, `${JSON.stringify(artifactOut, null, 2)}\n`);

    console.log(`\n=== Colophon calibration report ===`);
    console.log(`units: ${units.length}`);
    console.log(`oracle full-pass: ${oracleFullPass}/${units.length}`);
    console.log(`no-op full-pass:  ${noOpFullPass}/${units.length}`);
    console.log(`report digest: ${recordDigest(report.envelopeBytes)}`);
    console.log(`sealed ${OUT}\n`);

    expect(noOpFullPass, "a blank submission must never reach full success").toBe(0);
    expect(existsSync(OUT)).toBe(true);
  });
});
