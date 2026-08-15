import type { DeterministicProcessBlock, ParserIdentity } from "../evaluation-spec/family-blocks.js";
import type { EvaluationSpec } from "../evaluation-spec/schema.js";
import { sealEvaluationSpec } from "../evaluation-spec/seal.js";
import { EVALUATION_SPEC_FORMAT_URI, EVAL_SEMANTICS_VERSION } from "../identifiers.js";
import type { ResourceDescriptorLike } from "../resource-descriptor.js";

/**
 * `swe-rebench-v2.v1` needs no successor profile: a row becomes a `repository-work` Task plus a
 * per-instance `deterministic-process` EvaluationSpec (design §10.3/§13). `hf_dataset`/`hf_split`
 * (the upstream row lookup key) become locator hints, not sealed content, so they are
 * deliberately absent from this row shape — only the fields that promote into sealed bytes.
 */
export interface SweRebenchRow {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  language: string;
  image: ResourceDescriptorLike;
  testMaterial: ResourceDescriptorLike[];
  parser: ParserIdentity;
  transitions: { failToPass: string[]; passToPass: string[] };
  timeout: number;
}

export interface SweRebenchMapped {
  evaluationSpec: EvaluationSpec;
  evaluationSpecDigest: `sha256:${string}`;
  taskPayload: unknown;
  taskInputs: unknown;
}

function stripSha256Prefix(digest: string): string {
  return digest.startsWith("sha256:") ? digest.slice("sha256:".length) : digest;
}

/**
 * Maps one `swe-rebench-v2.v1` row into a `repository-work` Task payload/inputs pair and the
 * per-instance `deterministic-process` EvaluationSpec carrying the `TaskEnvironmentSpec.v1`
 * content (image, test material, parser identity, transitions, timeout). The spec is sealed
 * before the Task references it by digest (design §7).
 *
 * Access classes (design §10.3): swe-rebench rows are already public upstream, so their test
 * material stays public — a declared property this mapper enforces on every descriptor it embeds,
 * rather than trusting the caller to have already classified it.
 */
export function sweRebenchRowToTaskAndSpec(row: SweRebenchRow): SweRebenchMapped {
  const familyBlock: DeterministicProcessBlock = {
    image: row.image,
    platform: "linux/amd64",
    workspace: {},
    testMaterial: row.testMaterial.map((descriptor) => ({ ...descriptor, accessClass: "public" })),
    parser: row.parser,
    transitions: row.transitions,
    timeout: row.timeout,
  };

  const evaluationSpec: EvaluationSpec = {
    protocol: EVALUATION_SPEC_FORMAT_URI,
    semanticsVersion: EVAL_SEMANTICS_VERSION,
    family: "deterministic-process",
    grader: {
      name: row.parser.id,
      digest: { sha256: stripSha256Prefix(row.parser.digest) },
      accessClass: "public",
    },
    familyBlock,
    measurements: [{ name: "passed", type: "boolean", required: true }],
    verdictRule: { threshold: { measurement: "passed", op: "eq", value: true } },
    unscorable: [{ name: "environment-setup-failure", disposition: "retryable-infrastructure" }],
    evidenceConventions: { requiredRefs: [] },
  };

  const evaluationSpecDigest = sealEvaluationSpec(evaluationSpec).digest;

  const taskPayload = {
    instance_id: row.instance_id,
    language: row.language,
    provenance: { kind: "mined" },
  };

  const taskInputs: ResourceDescriptorLike[] = [
    {
      name: "repository-state",
      uri: `https://github.com/${row.repo}`,
      annotations: { ref: row.base_commit },
    },
  ];

  return { evaluationSpec, evaluationSpecDigest, taskPayload, taskInputs };
}
