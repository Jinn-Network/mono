// SPDX-License-Identifier: MIT

/**
 * Test-only fixture builders for the wave engine. Excluded from `tsconfig.build.json`.
 *
 * Everything here is derived from spec text and from the shapes the packages this unit composes
 * already publish — never from a product run. Two conventions worth stating, because both are
 * deliberate:
 *
 * - **Task documents are canonicalized, not sealed by the protocol package.** The product's
 *   source boundary does not admit `@jinn-network/task-execution-protocol`, so the fixtures build
 *   the document and serialize it with `serializeCanonicalJson`. Nothing is trusted about the
 *   result: the in-memory backend runs `validateTask` on the exact bytes and rejects a malformed
 *   document, so the fixture's correctness is enforced by the same validator `sealTask` would use.
 * - **Objective methods are real registry methods.** `avg-at-k@1` requires only `verdictRule`, so
 *   it is the smallest campaign objective that can actually produce a Report — a fixture method id
 *   would make every Report test vacuous.
 */

import {
  BENCHMARKING_METHOD_IDS,
  BENCHMARKING_METHOD_VERSION,
  BENCHMARKING_PROTOCOL,
  documentDigest,
  parseBenchmark,
  sealBenchmark,
  serializeCanonicalJson,
  sha256Hex,
  type BenchmarkRecord,
} from "@jinn-network/benchmarking-records";
import {
  EXECUTION_TUPLE_FORMAT_TOKEN,
  tupleDigest,
  type ExecutionPolicyTuple,
} from "@jinn-network/policy-identity";
import { CAMPAIGN_FORMAT_TOKEN } from "../tokens.js";
import type { CampaignAllocation, CampaignDocument, JsonValue } from "../types.js";
import type { AdmittedCandidate, WaveRunSettings } from "../wave-types.js";

export const OWNER = "urn:uuid:20000000-0000-5000-8000-000000000001";
export const SOLVER = "urn:uuid:30000000-0000-5000-8000-000000000001";
export const EVALUATOR = "urn:uuid:30000000-0000-5000-8000-000000000002";
export const AUTHOR = "urn:uuid:10000000-0000-5000-8000-000000000001";

export const HARNESS = { id: "claude-code", version: "2.1.34" } as const;
export const MODEL = { id: "anthropic/claude-haiku-4-5" } as const;
export const ISOLATION = "unrestricted";

export const OBJECTIVE_METHOD = {
  id: BENCHMARKING_METHOD_IDS.avgAtK,
  version: BENCHMARKING_METHOD_VERSION,
  parameters: { verdictRule: "sole" } as Readonly<Record<string, JsonValue>>,
};

export function loadout(name: string, fill: string) {
  return {
    kind: "jinn.harness-state.v1",
    name,
    digest: `sha256:${fill.repeat(64).slice(0, 64)}`,
  } as const;
}

export function tupleFor(name: string, fill: string): ExecutionPolicyTuple {
  return {
    formatToken: EXECUTION_TUPLE_FORMAT_TOKEN,
    harness: { ...HARNESS },
    model: { ...MODEL },
    loadout: loadout(name, fill),
    isolationPolicy: ISOLATION,
  } as ExecutionPolicyTuple;
}

export function candidateFor(armId: string, name: string, fill: string): AdmittedCandidate {
  const tuple = tupleFor(name, fill);
  const digest = tupleDigest(tuple);
  return { armId, tupleDigest: digest, tuple, source: { kind: "tuple", digest } };
}

export const PARENT = candidateFor("parent", "repo-work-parent", "1");
export const CANDIDATE = candidateFor("candidate", "repo-work-candidate", "2");

/** A minimal, valid sealed Task document. `evaluation` is required for benchmark judgeability. */
export function taskBytes(instructions: string): Uint8Array {
  return serializeCanonicalJson({
    protocol: "https://spec.jinn.network/profiles/task-execution/v1",
    profile: { digest: { sha256: "f".repeat(64) } },
    instructions,
    outputs: [{ name: "answer", mediaType: "text/plain", required: true }],
    evaluation: { digest: { sha256: "2".repeat(64) } },
  } as JsonValue);
}

export interface TaskFixture {
  readonly digest: string;
  readonly bytes: Uint8Array;
}

export function tasksFor(instructions: readonly string[]): readonly TaskFixture[] {
  return instructions.map((text) => {
    const bytes = taskBytes(text);
    return { digest: sha256Hex(bytes), bytes };
  });
}

export function benchmarkFor(input: {
  readonly name: string;
  readonly tasks: readonly TaskFixture[];
  readonly reveal: BenchmarkRecord["reveal"];
}): { readonly digest: `sha256:${string}`; readonly bytes: Uint8Array; readonly record: BenchmarkRecord } {
  const sealed = sealBenchmark({
    protocol: BENCHMARKING_PROTOCOL,
    name: input.name,
    description: `Fixture slate: ${input.name}.`,
    author: AUTHOR,
    version: "1.0.0",
    items: input.tasks.map((task) => ({ task: { digest: { sha256: task.digest } } })),
    reveal: input.reveal,
  });
  return { digest: sealed.digest, bytes: sealed.bytes, record: parseBenchmark(sealed.bytes) };
}

export function campaignFor(input: {
  readonly developmentBenchmark: string;
  readonly promotionBenchmark: string;
  readonly seeds: readonly AdmittedCandidate[];
  readonly allocation: CampaignAllocation;
  readonly evaluationCells?: number;
  readonly hardCapCells?: number;
  readonly maxWaves?: number;
  readonly objectiveParameters?: Readonly<Record<string, JsonValue>>;
}): CampaignDocument {
  return {
    formatToken: CAMPAIGN_FORMAT_TOKEN,
    target: {
      taskProfile: "https://profiles.jinn.network/repository-work/1.0",
      developmentBenchmark: input.developmentBenchmark,
      promotionBenchmark: input.promotionBenchmark,
    },
    seeds: input.seeds.map((seed) => ({ kind: "tuple" as const, digest: seed.tupleDigest })),
    mutationSurface: ["loadout"],
    frozenAxes: {
      harness: { ...HARNESS },
      model: { ...MODEL },
      isolationPolicy: ISOLATION,
    },
    objective: {
      methods: [{
        id: OBJECTIVE_METHOD.id,
        version: OBJECTIVE_METHOD.version,
        parameters: input.objectiveParameters ?? OBJECTIVE_METHOD.parameters,
      }],
      constraints: [],
    },
    budgets: {
      proposal: { maxProposals: 8 },
      evaluation: { maxCells: input.evaluationCells ?? 200 },
      hardCap: { maxCells: input.hardCapCells ?? 260 },
    },
    allocation: input.allocation,
    stoppingRule: { ruleRef: "max-waves/1.0", parameters: { maxWaves: input.maxWaves ?? 4 } },
  } as CampaignDocument;
}

export function runSettings(overrides: Partial<WaveRunSettings> = {}): WaveRunSettings {
  return {
    owner: OWNER,
    closeAt: "2026-09-01T00:00:00Z",
    cellWindowMs: 3_600_000,
    completenessFloor: "0.5",
    independence: "disclosed",
    replacement: { allowed: false },
    evaluation: { minVerdicts: 1, distinctEvaluator: false },
    venue: { kind: "self-run", note: "local backend" },
    ...overrides,
  };
}

export function digestOfBytes(bytes: Uint8Array): `sha256:${string}` {
  return documentDigest(bytes);
}
