// SPDX-License-Identifier: Apache-2.0
import { createPublicKey, generateKeyPairSync, sign as signEd25519, type KeyObject } from "node:crypto";
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
import {
  assembleEvidenceMatrix,
  deriveDefaultEvidenceCell,
  issueEvidenceNativeReport,
  verifyEvidenceCohort,
  verifyEvidenceMatrix,
  verifyEvidenceNativeReport,
} from "@jinn-network/benchmarking-evidence";
import { SKILLSBENCH_DEMO1_PILOT_DECLARATION } from "../method/skillsbench-demo1-current.js";
import {
  admitDeclaredCells,
  type SkillsBenchDemo1AdmittedCell,
  type SkillsBenchDemo1CellRecord,
} from "../method/skillsbench-demo1-declaration.js";
import {
  manipulationCheck,
  pairedDeltaEstimate,
  varianceDecomposition,
} from "../method/skillsbench-demo1-stats.js";

/**
 * Seals the Demo-1 report through the evidence-native product chain.
 *
 * Every admitted arm cell becomes an Execution Evidence record with a signed Result Evaluation;
 * the pre-declared analysis flows them into an Evidence Cohort, an Evidence Matrix, and a signed
 * evidence-native Report. The committed bundle carries every byte a reader needs to re-verify the
 * chain offline — `yarn demo1:verify` replays it from a clean checkout.
 *
 * Admission is fail-closed by construction: `admitDeclaredCells` throws on any missing,
 * unparseable, or wrong-model cell, so a report cannot be sealed over a shrunken denominator.
 *
 * Opt in with `SKILLSBENCH_DEMO1_REPORT=1`. Set `SKILLSBENCH_DEMO1_STAGE=final` once the final
 * declaration replaces the pilot.
 */
const ENABLED = process.env.SKILLSBENCH_DEMO1_REPORT === "1";
const REPO_ROOT = resolve(import.meta.dirname, "../../../../..");
const CELLS = resolve(REPO_ROOT, "docs/superpowers/plans/demo-report-1/E1-arm-cells.v1.json");
const BUNDLE_OUT = resolve(REPO_ROOT, "docs/superpowers/plans/demo-report-1/E1-demo1-evidence-bundle.v1.json");
const REPORT_OUT = resolve(REPO_ROOT, "docs/superpowers/plans/demo-report-1/demo1-report.v1.json");

const SEALED_AT = "2026-08-18T00:00:00.000Z";
const SOURCE_COMMIT = "b63b7b2850226b6aa4fb5929a8c1ac7bc4d9a6af";

const encoder = new TextEncoder();
const json = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value));
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
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

function publicKeyB64(identity: string): string {
  const spki = createPublicKey(keys.get(identity)!.privateKey).export({ type: "spki", format: "der" });
  return Buffer.from(spki).toString("base64");
}

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
  return `urn:uuid:${index.toString(16).padStart(8, "0")}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

/** Sealing errors carry their schema issues in `.errors`; surface them or a failure is unreadable. */
function sealing<T>(label: string, seal: () => T): T {
  try {
    return seal();
  } catch (error) {
    console.error(`${label}:`, JSON.stringify((error as { errors?: unknown }).errors, null, 1));
    throw error;
  }
}

/** One arm cell as an Execution Evidence record whose artifacts carry the measured outcome. */
function execution(index: number, cell: SkillsBenchDemo1AdmittedCell, model: string) {
  const taskBytes = json({ benchmark: "skillsbench", release: "v1.1", commit: SOURCE_COMMIT, task: cell.taskId, arm: cell.arm, replicate: cell.replicate });
  const resultBytes = json({ reward: cell.reward, source: "/logs/verifier/reward.txt" });
  const runtimeBytes = json({ runtime: "skillsbench-arm-cell", agentLocation: "host", model, baseImage: cell.baseImage ?? "unknown" });
  const task = artifact(taskBytes, `${cell.cellId}-task.json`);
  const result = artifact(resultBytes, `${cell.cellId}-result.json`);
  const bytes = buildExecutionEvidence({
    recording: {
      executionId: uuid(index),
      startedAt: SEALED_AT,
      record: {
        name: cell.cellId,
        description: `Demo-1 arm cell ${cell.cellId} on ${model}. The agent ran on the host; grading ran in the task's pinned container.`,
        license: "https://www.apache.org/licenses/LICENSE-2.0",
      },
      task: { entityId: "task/input.json", name: task.name!, source: task, origin },
      initialInputs: [],
      executor: { entityId: `urn:agent:${model}`, kind: "software", name: `Claude Code (${model})`, origin },
      runtime: {
        entityId: "runtime/runtime.json",
        specification: artifact(runtimeBytes, "skillsbench-arm-runtime.json"),
        name: "SkillsBench",
        softwareVersion: "1.1",
        origin,
        components: [{
          kind: "controlled",
          artifact: { kind: "file", entityId: "runtime/base-image", source: artifact(json({ baseImage: cell.baseImage ?? "unknown" }), "base-image.json"), origin },
        }],
      },
      producer: { entityId: "urn:agent:colophon-skillsbench", kind: "software", name: "Colophon", origin },
    },
    additionalInputs: [],
    runtimeObservations: [],
    outcome: "completed",
    endedAt: SEALED_AT,
    finalizedAt: SEALED_AT,
    results: [{ kind: "file", entityId: "results/output.json", source: result, origin }],
    nativeTrace: {
      artifact: { kind: "file", entityId: "trace/native.json", source: artifact(json({ cell: cell.cellId }), `${cell.cellId}-trace.json`), origin },
      format: { entityId: "https://spec.jinn.network/formats/skillsbench-arm-cell" },
    },
  } as never);
  expect(validateExecutionEvidence(bytes)).toMatchObject({ conforms: true });
  return {
    bytes,
    taskDigest: task.digest,
    resultDigest: result.digest,
    artifacts: new Map<string, Uint8Array>([
      [task.digest.slice(7), taskBytes],
      [result.digest.slice(7), resultBytes],
      [recordDigest(runtimeBytes).slice(7), runtimeBytes],
      [recordDigest(json({ cell: cell.cellId })).slice(7), json({ cell: cell.cellId })],
      [recordDigest(json({ baseImage: cell.baseImage ?? "unknown" })).slice(7), json({ baseImage: cell.baseImage ?? "unknown" })],
    ]),
  };
}

function evaluation(taskDigest: `sha256:${string}`, resultDigest: `sha256:${string}`, methodDigest: `sha256:${string}`, pass: boolean): Uint8Array {
  const statement = {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [
      descriptor("candidate-answer.json", resultDigest, "application/json"),
      descriptor("skillsbench-task.json", taskDigest, "application/json"),
    ],
    predicateType: RESULT_EVALUATION_PREDICATE_TYPE,
    predicate: {
      evaluatedAt: SEALED_AT,
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

describe.skipIf(!ENABLED)("Demo-1 evidence-native report", () => {
  it("seals and verifies the report from admitted arm cells", { timeout: 600_000 }, async () => {
    const stage = process.env.SKILLSBENCH_DEMO1_STAGE === "final" ? "final" : "pilot";
    const declaration = SKILLSBENCH_DEMO1_PILOT_DECLARATION;
    const document = JSON.parse(readFileSync(CELLS, "utf8")) as { cells: Record<string, SkillsBenchDemo1CellRecord> };

    // Fail-closed admission: any missing, unparseable, or wrong-model declared cell throws here.
    // Every admitted cell — slate and screening alike — enters the evidence cohort; only the
    // declared slate enters the paired analysis.
    const admission = admitDeclaredCells(declaration, document);
    const slateCells = admission.cells.filter((cell) => cell.section === "slate");
    const estimate = pairedDeltaEstimate(slateCells);
    const decomposition = varianceDecomposition(estimate);
    const check = manipulationCheck(slateCells);

    const records = new Map<string, Uint8Array>();
    const artifacts = new Map<string, Uint8Array>();
    const methodBytes = json({ verifier: "skillsbench test.sh", reward: "/logs/verifier/reward.txt", fullSuccess: 1 });
    const methodDigest = recordDigest(methodBytes);
    const members: Array<{ memberKey: string } & Record<string, unknown>> = [];

    let index = 1;
    for (const cell of admission.cells) {
      const run = execution(index, cell, declaration.model);
      const executionRef = ref("execution-evidence", `${cell.cellId}-execution.json`, run.bytes);
      records.set(evidenceReferenceKey(executionRef), run.bytes);
      for (const [digest, bytes] of run.artifacts) artifacts.set(digest, bytes);

      const evalBytes = evaluation(run.taskDigest, run.resultDigest, methodDigest, cell.fullPass);
      const evalRef = ref("result-evaluation", `${cell.cellId}-evaluation.json`, evalBytes);
      records.set(evidenceReferenceKey(evalRef), evalBytes);

      members.push({
        memberKey: cell.cellId,
        execution: executionRef,
        taskDigest: run.taskDigest,
        resultDigests: [run.resultDigest],
        groupId: cell.arm,
        slotId: cell.taskId,
        replicate: cell.replicate,
        correlationKey: `skillsbench/${cell.cellId}`,
        evaluations: { considered: [evalRef], admitted: [evalRef], excluded: [] },
        verifications: { considered: [], admitted: [], excluded: [] },
        labelResolutions: { considered: [], admitted: [], excluded: [] },
        assurance: {
          origin: "native-direct",
          timing: "retrospective-artifacts-only",
          closure: "complete-relative-to-sealed-source",
          availability: "public-exact",
          limitations: ["The agent ran on the host rather than inside the task image; grading ran in the pinned container."],
        },
      });
      index += 1;
    }

    const declarationDigest = recordDigest(json(declaration));
    const benchmarkRecord = sealBenchmarkDefinitionV2({
      protocol: BENCHMARKING_PROTOCOL_V2,
      name: "Demo-1: Skill delivery A/B on SkillsBench v1.1",
      description: "Holding task, model, harness, instruction bodies, non-instruction resources and environment fixed: does native progressive Skill delivery change performance versus the same bytes in root CLAUDE.md, against a no-instruction manipulation control?",
      author: "urn:agent:colophon-skillsbench",
      version: "1.0.0",
      items: declaration.slate.map((entry) => ({
        task: descriptor(`${entry.taskId}-task.json`, recordDigest(json({ benchmark: "skillsbench", release: "v1.1", commit: SOURCE_COMMIT, task: entry.taskId, arm: "A-native-skill", replicate: 0 })), "application/json"),
        identifiers: [{ scheme: "https://github.com/benchflow-ai/skillsbench/identifiers/task", value: entry.taskId }],
      })).sort((left, right) => left.task.digest.sha256.localeCompare(right.task.digest.sha256)),
      reveal: { policy: "immediate" },
      license: "https://www.apache.org/licenses/LICENSE-2.0",
    } as never);
    const benchmark = descriptor("benchmark-v2.json", benchmarkRecord.digest);
    const capture = {
      recordKind: EXECUTION_BATCH_CAPTURE_RECORD_KIND,
      record: descriptor("skillsbench-arm-capture.json", recordDigest(json({ commit: SOURCE_COMMIT, declaration: declarationDigest, cells: admission.cells.length }))),
    };

    const manifest = sealing("manifest", () => sealBenchmarkAnalysisManifest({
      protocol: BENCHMARKING_PROTOCOL_V2,
      benchmark,
      owner: "urn:agent:colophon-skillsbench",
      sources: [{ source: capture, cutoff: SEALED_AT }],
      groups: [
        { groupId: "A-native-skill", selection: descriptor("arm-a.json", recordDigest(json({ arm: "A-native-skill" }))) },
        { groupId: "B-flat-claude-md", selection: descriptor("arm-b.json", recordDigest(json({ arm: "B-flat-claude-md" }))) },
        { groupId: "C-no-instructions", selection: descriptor("arm-c.json", recordDigest(json({ arm: "C-no-instructions" }))) },
      ],
      taskRelation: { exactDigestRequired: true },
      multiplicity: {
        correlationUnit: "execution",
        duplicatePolicy: "retain-distinct",
        retryPolicy: "correlated",
        assignmentPolicy: descriptor("assignment.json", recordDigest(json({ slot: "skillsbench-arm-cell", declaration: declarationDigest }))),
      },
      evaluationAdmission: {
        evaluatorAllowlist: [VERIFIER_ID],
        methodAllowlist: [descriptor("skillsbench-verifier.json", methodDigest)],
        minimumClaims: 1,
        distinctEvaluators: true,
        humanLabelPolicy: "not-required",
        conflictPolicy: "preserve-unresolved",
        supersessionPolicy: "preserve-all",
        trustPolicy: descriptor("trust.json", recordDigest(json({ policy: "skillsbench-arm-cell" }))),
      },
      verificationAdmission: {
        requiredChecks: [],
        trustPolicy: descriptor("verification-trust.json", recordDigest(json({ policy: "skillsbench-arm-cell" }))),
        failurePolicy: "disclose",
      },
      completeness: {
        required: "complete",
        unavailableSource: "indeterminate",
        discoveredOmission: "fail",
        excludedMember: "count-attrition",
      },
      analysisPlan: [
        { id: "jinn.benchmarking.method/manipulation-check", version: "1", parameters: { control: "C-no-instructions" } },
        { id: "jinn.benchmarking.method/paired-delta", version: "1", parameters: { pairedBy: "task", arms: ["A-native-skill", "B-flat-claude-md"] } },
        { id: "jinn.benchmarking.method/variance-decomposition", version: "1", parameters: { components: ["replicate-noise", "task-heterogeneity"] } },
      ],
      closeAt: SEALED_AT,
      preregistration: stage === "final" ? "local-sealed-before-selection" : "post-hoc-exploratory",
    } as never));

    const cohort = sealing("cohort", () => sealEvidenceCohort({
      protocol: BENCHMARKING_PROTOCOL_V2,
      manifest: descriptor("analysis-manifest.json", manifest.digest),
      boundary: { sources: [{ source: capture }], resolvedAt: SEALED_AT },
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
    } as never));

    const resolver = {
      resolve(reference: EvidenceRecordReference) {
        const bytes = records.get(evidenceReferenceKey(reference));
        if (bytes === undefined) throw new Error(`missing ${evidenceReferenceKey(reference)}`);
        return bytes;
      },
    };
    expect(verifyEvidenceCohort({ cohortBytes: cohort.bytes, manifestBytes: manifest.bytes, records: resolver })).toMatchObject({ conforms: true });

    const implementation = descriptor("assembly-3.0.json", recordDigest(json({ procedure: "3.0" })));
    const matrix = assembleEvidenceMatrix({
      cohortBytes: cohort.bytes, manifestBytes: manifest.bytes, records: resolver, implementation, deriveCell: deriveDefaultEvidenceCell,
    });
    expect(verifyEvidenceMatrix({
      matrixBytes: matrix.record.bytes, cohortBytes: cohort.bytes, manifestBytes: manifest.bytes, records: resolver,
      implementation, deriveCell: deriveDefaultEvidenceCell,
    } as never)).toMatchObject({ conforms: true });

    // The protocol's I-JSON admits integers only, so the sealed results carry every statistic in
    // parts-per-million of reward. The unsealed summary file keeps the readable floats alongside.
    const ppm = (value: number): number => Math.round(value * 1_000_000);
    const results = {
      stage: `skillsbench-v1.1-demo1-${stage}`,
      unit: "ppm-of-reward",
      pairedDelta: {
        n: estimate.n,
        meanPpm: ppm(estimate.mean),
        sdPpm: ppm(estimate.sd),
        sePpm: ppm(estimate.se),
        tCriticalPpm: ppm(estimate.tCritical),
        ci95Ppm: { lower: ppm(estimate.ci95.lower), upper: ppm(estimate.ci95.upper) },
        perTask: estimate.perTask.map((task) => ({
          taskId: task.taskId,
          meanAPpm: ppm(task.meanA),
          meanBPpm: ppm(task.meanB),
          deltaPpm: ppm(task.delta),
          replicatesA: task.replicatesA,
          replicatesB: task.replicatesB,
          samplingVariancePpm: ppm(task.samplingVariance),
        })),
      },
      varianceDecomposition: {
        betweenTaskVariancePpm: ppm(decomposition.betweenTaskVariance),
        meanSamplingVariancePpm: ppm(decomposition.meanSamplingVariance),
        taskHeterogeneityPpm: ppm(decomposition.taskHeterogeneity),
        heterogeneitySharePpm: ppm(decomposition.heterogeneityShare),
      },
      manipulationCheck: {
        cCells: check.cCells,
        cFullPass: check.cFullPass,
        cMeanPpm: ppm(check.cMean),
        abMeanPpm: ppm(check.abMean),
        upliftPpm: ppm(check.uplift),
      },
    };
    const resultsReadable = {
      pairedDelta: { n: estimate.n, mean: estimate.mean, sd: estimate.sd, se: estimate.se, tCritical: estimate.tCritical, ci95: estimate.ci95, perTask: estimate.perTask },
      varianceDecomposition: decomposition,
      manipulationCheck: check,
    };

    const report = await sealing("report", () =>
  issueEvidenceNativeReport({
    matrixBytes: matrix.record.bytes,
    signer: signerFor(PUBLISHER_ID),
    report: {
      protocol: BENCHMARKING_PROTOCOL_V2,
      subjects: [descriptor("matrix-v2.json", matrix.record.digest)],
      manifest: descriptor("analysis-manifest.json", manifest.digest),
      cohort: descriptor("cohort.json", cohort.digest),
      method: {
        id: "jinn.benchmarking.method/paired-delta",
        version: "1",
        parameters: { pairedBy: "task", arms: ["A-native-skill", "B-flat-claude-md"], control: "C-no-instructions" },
        implementation,
      },
      author: "urn:agent:colophon-skillsbench",
      preregistration: stage === "final" ? "local-sealed-before-selection" : "post-hoc-exploratory",
      results,
      disclosures: {
        evidenceOrigin: { "native-direct": members.length },
        timing: { "retrospective-artifacts-only": members.length },
        closure: { "complete-relative-to-sealed-source": members.length },
        taskRelation: { "exact-digest": members.length },
        availability: { "public-exact": members.length },
        conflictsPreserved: 0,
        commissioningRequired: false,
      },
      limitations: [
        `PILOT SCALE: ${declaration.slate.length} informative tasks against the official Demo-1 floor of 21 units in 13 independence clusters. That floor is unreachable for this model on this corpus; this is the strongest claim the data can honestly carry.`,
        "SLATE SELECTION: tasks were selected for demonstrated instruction-content uplift — first from the upstream coverage data, then symmetrically via Jinn's own arm-A and arm-B screens. The A-vs-B contrast is therefore conditional on content mattering, which is what the manipulation check certifies per task.",
        "HOST-AGENT DEVIATION: the agent ran on the host (Claude Code authenticates itself there), not inside the task image; grading always ran inside the pinned container. Agent-side environment is therefore the host interpreter, not the task's.",
        `SUBJECT MODEL: every cell ran ${declaration.model}. Nothing here generalizes to other models; upstream rescue data shows the skill effect is strongly model-dependent.`,
        "SELF-RUN VENUE: the same operator produced and sealed every cell. The checkable artifact chain, not the operator, is what a reader should rely on.",
      ],
    },
  } as never))
    ;
    expect(verifyEvidenceNativeReport({ envelopeBytes: report.envelopeBytes, matrixBytes: matrix.record.bytes } as never).report.results).toMatchObject({ stage: `skillsbench-v1.1-demo1-${stage}` });

    const bundle = {
      schema: "jinn.demo1.evidence-bundle.v1",
      stage,
      sealedAt: SEALED_AT,
      declaration,
      declarationDigest,
      records: Object.fromEntries([...records.entries()].map(([key, bytes]) => [key, b64(bytes)])),
      artifacts: Object.fromEntries([...artifacts.entries()].map(([digest, bytes]) => [digest, b64(bytes)])),
      benchmark: b64(benchmarkRecord.bytes),
      manifest: b64(manifest.bytes),
      cohort: b64(cohort.bytes),
      matrix: b64(matrix.record.bytes),
      reportEnvelope: b64(report.envelopeBytes),
      publicKeys: {
        [`urn:key:${VERIFIER_ID}`]: publicKeyB64(VERIFIER_ID),
        [`urn:key:${PUBLISHER_ID}`]: publicKeyB64(PUBLISHER_ID),
      },
    };
    mkdirSync(dirname(BUNDLE_OUT), { recursive: true });
    writeFileSync(BUNDLE_OUT, `${JSON.stringify(bundle, null, 2)}\n`);

    const summary = {
      schema: "jinn.demo1.report.v1",
      title: "Demo-1: Skill delivery A/B on SkillsBench v1.1",
      stage,
      pilotScale: `PILOT SCALE — ${declaration.slate.length} informative tasks against the official floor of 21 units / 13 clusters, which is unreachable for this model on this corpus.`,
      slateSelection: "Uplift-selected from upstream coverage data, then symmetrically screened with Jinn's own arm-A and arm-B rescue screens.",
      hostAgentDeviation: "Agent on host; grading in the pinned container.",
      model: declaration.model,
      source: { benchmark: "skillsbench", release: "v1.1", commit: SOURCE_COMMIT },
      cells: admission.cells.length,
      slateCells: slateCells.length,
      screeningCells: admission.cells.length - slateCells.length,
      undeclaredCellsInFile: admission.undeclaredCellCount,
      results: resultsReadable,
      resultsSealedPpm: results,
      digests: {
        declaration: declarationDigest,
        benchmark: benchmarkRecord.digest,
        analysisManifest: manifest.digest,
        cohort: cohort.digest,
        matrix: matrix.record.digest,
        report: recordDigest(report.envelopeBytes),
      },
      verify: "cd packages/benchmark-product/core && yarn demo1:verify",
      verified: { cohort: true, matrix: true, report: true },
    };
    writeFileSync(REPORT_OUT, `${JSON.stringify(summary, null, 2)}\n`);

    console.log(`\n=== Demo-1 ${stage} report sealed ===`);
    console.log(`cells: ${admission.cells.length} | tasks: ${estimate.n}`);
    console.log(`paired A-B: ${estimate.mean.toFixed(3)} (95% CI ${estimate.ci95.lower.toFixed(3)} to ${estimate.ci95.upper.toFixed(3)})`);
    console.log(`manipulation check: C full-pass ${check.cFullPass}/${check.cCells}, uplift ${check.uplift.toFixed(3)}`);
    console.log(`report digest: ${recordDigest(report.envelopeBytes)}`);
    expect(existsSync(BUNDLE_OUT)).toBe(true);
  });
});
