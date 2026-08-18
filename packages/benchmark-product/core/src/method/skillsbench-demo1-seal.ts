import {
  BENCHMARKING_PROTOCOL_V2,
  EXECUTION_BATCH_CAPTURE_RECORD_KIND,
  sealBenchmarkAnalysisManifest,
  sealBenchmarkDefinitionV2,
  type DigestBearingResourceDescriptor,
} from "@jinn-network/benchmarking-protocol";
import { recordDigest } from "@jinn-network/evidence-protocol";
import type { SkillsBenchDemo1Declaration } from "./skillsbench-demo1-declaration.js";

/**
 * Deterministic sealing of Demo-1's Benchmark Definition and Analysis Manifest.
 *
 * Both records are pure functions of the declaration and fixed policy, so sealing them before the
 * deep run produces byte-identical records to the ones the final report build reseals — which is
 * what lets a reader check that the analysis was declared before the evidence completed: the
 * committed preregistration file and the final bundle must carry the same manifest bytes.
 *
 * Nothing here reads a cell, a reward, or any outcome.
 */
export const SKILLSBENCH_DEMO1_SEALED_AT = "2026-08-18T00:00:00.000Z" as const;
export const SKILLSBENCH_DEMO1_SOURCE_COMMIT = "b63b7b2850226b6aa4fb5929a8c1ac7bc4d9a6af" as const;
export const SKILLSBENCH_DEMO1_VERIFIER_ID = "urn:evaluator:skillsbench-verifier";
export const SKILLSBENCH_DEMO1_PUBLISHER_ID = "urn:publisher:colophon";

const encoder = new TextEncoder();
const json = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value));

export function demo1Descriptor(name: string, digest: `sha256:${string}`, mediaType?: string): DigestBearingResourceDescriptor {
  return { name, digest: { sha256: digest.slice(7) }, ...(mediaType === undefined ? {} : { mediaType }) };
}

/** The verifier method record: SkillsBench's own test.sh writing /logs/verifier/reward.txt. */
export function demo1MethodBytes(): Uint8Array {
  return json({ verifier: "skillsbench test.sh", reward: "/logs/verifier/reward.txt", fullSuccess: 1 });
}

export interface SkillsBenchDemo1SealedRecord {
  readonly bytes: Uint8Array;
  readonly digest: `sha256:${string}`;
}

export function sealDemo1Definition(declaration: SkillsBenchDemo1Declaration): SkillsBenchDemo1SealedRecord {
  return sealBenchmarkDefinitionV2({
    protocol: BENCHMARKING_PROTOCOL_V2,
    name: "Demo-1: Skill delivery A/B on SkillsBench v1.1",
    description: "Holding task, model, harness, instruction bodies, non-instruction resources and environment fixed: does native progressive Skill delivery change performance versus the same bytes in root CLAUDE.md, against a no-instruction manipulation control?",
    author: "urn:agent:colophon-skillsbench",
    version: "1.0.0",
    items: declaration.slate.map((entry) => ({
      task: demo1Descriptor(
        `${entry.taskId}-task.json`,
        recordDigest(json({ benchmark: "skillsbench", release: "v1.1", commit: SKILLSBENCH_DEMO1_SOURCE_COMMIT, task: entry.taskId, arm: "A-native-skill", replicate: 0 })),
        "application/json",
      ),
      identifiers: [{ scheme: "https://github.com/benchflow-ai/skillsbench/identifiers/task", value: entry.taskId }],
    })).sort((left, right) => left.task.digest.sha256.localeCompare(right.task.digest.sha256)),
    reveal: { policy: "immediate" },
    license: "https://www.apache.org/licenses/LICENSE-2.0",
  } as never) as SkillsBenchDemo1SealedRecord;
}

/** Total declared cells. Fail-closed admission makes this the admitted count by construction. */
export function demo1DeclaredCellCount(declaration: SkillsBenchDemo1Declaration): number {
  return [...declaration.slate, ...(declaration.screening ?? [])]
    .flatMap((entry) => Object.values(entry.expected))
    .reduce((sum, count) => sum + (count ?? 0), 0);
}

/** The capture-source reference the manifest and cohort both bind. Pre-run computable. */
export function demo1Capture(declaration: SkillsBenchDemo1Declaration): {
  readonly recordKind: string;
  readonly record: DigestBearingResourceDescriptor;
} {
  const declarationDigest = recordDigest(json(declaration));
  return {
    recordKind: EXECUTION_BATCH_CAPTURE_RECORD_KIND,
    record: demo1Descriptor(
      "skillsbench-arm-capture.json",
      recordDigest(json({ commit: SKILLSBENCH_DEMO1_SOURCE_COMMIT, declaration: declarationDigest, cells: demo1DeclaredCellCount(declaration) })),
    ),
  };
}

export function sealDemo1Manifest(
  declaration: SkillsBenchDemo1Declaration,
  stage: "pilot" | "final",
): SkillsBenchDemo1SealedRecord {
  const declarationDigest = recordDigest(json(declaration));
  const methodDigest = recordDigest(demo1MethodBytes());
  const benchmarkRecord = sealDemo1Definition(declaration);
  return sealBenchmarkAnalysisManifest({
    protocol: BENCHMARKING_PROTOCOL_V2,
    benchmark: demo1Descriptor("benchmark-v2.json", benchmarkRecord.digest),
    owner: "urn:agent:colophon-skillsbench",
    sources: [{ source: demo1Capture(declaration), cutoff: SKILLSBENCH_DEMO1_SEALED_AT }],
    groups: [
      { groupId: "A-native-skill", selection: demo1Descriptor("arm-a.json", recordDigest(json({ arm: "A-native-skill" }))) },
      { groupId: "B-flat-claude-md", selection: demo1Descriptor("arm-b.json", recordDigest(json({ arm: "B-flat-claude-md" }))) },
      { groupId: "C-no-instructions", selection: demo1Descriptor("arm-c.json", recordDigest(json({ arm: "C-no-instructions" }))) },
    ],
    taskRelation: { exactDigestRequired: true },
    multiplicity: {
      correlationUnit: "execution",
      duplicatePolicy: "retain-distinct",
      retryPolicy: "correlated",
      assignmentPolicy: demo1Descriptor("assignment.json", recordDigest(json({ slot: "skillsbench-arm-cell", declaration: declarationDigest }))),
    },
    evaluationAdmission: {
      evaluatorAllowlist: [SKILLSBENCH_DEMO1_VERIFIER_ID],
      methodAllowlist: [demo1Descriptor("skillsbench-verifier.json", methodDigest)],
      minimumClaims: 1,
      distinctEvaluators: true,
      humanLabelPolicy: "not-required",
      conflictPolicy: "preserve-unresolved",
      supersessionPolicy: "preserve-all",
      trustPolicy: demo1Descriptor("trust.json", recordDigest(json({ policy: "skillsbench-arm-cell" }))),
    },
    verificationAdmission: {
      requiredChecks: [],
      trustPolicy: demo1Descriptor("verification-trust.json", recordDigest(json({ policy: "skillsbench-arm-cell" }))),
      failurePolicy: "disclose",
    },
    completeness: {
      required: "complete",
      unavailableSource: "indeterminate",
      discoveredOmission: "fail",
      excludedMember: "count-attrition",
    },
    analysisPlan: [
      { id: "jinn.benchmarking.method/manipulation-check", version: "1", parameters: { control: "C-no-instructions", population: "slate" } },
      { id: "jinn.benchmarking.method/paired-delta", version: "1", parameters: { pairedBy: "task", arms: ["A-native-skill", "B-flat-claude-md"], population: "informative-subset", informativeRule: "C-no-instructions equals zero in every replicate AND max(mean A, mean B) greater than zero", equivalenceMarginPpm: 150000 } },
      { id: "jinn.benchmarking.method/variance-decomposition", version: "1", parameters: { components: ["replicate-noise", "task-heterogeneity"], population: "slate" } },
    ],
    closeAt: SKILLSBENCH_DEMO1_SEALED_AT,
    preregistration: stage === "final" ? "local-sealed-before-selection" : "post-hoc-exploratory",
  } as never) as SkillsBenchDemo1SealedRecord;
}
