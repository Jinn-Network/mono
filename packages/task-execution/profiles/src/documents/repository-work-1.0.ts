import type { EffortTier } from "@jinn-network/task-execution-protocol";
import { REPOSITORY_WORK_PROFILE_URI, TASK_PROFILE_FORMAT_URI } from "../identifiers.js";
import type { ResourceDescriptorLike } from "../resource-descriptor.js";
import type { TaskProfileDocument } from "../task-profile/schema.js";

/**
 * The `jinn-repo.v1` successor, slimmed to what is task-semantic (design §8). The old `source`
 * union dissolves into `provenance` + EvaluationSpec choice; the Autopilot session variant is a
 * deferred stricter sub-profile (out of lane, design §8/§17).
 */
export function buildRepositoryWorkProfile(): TaskProfileDocument {
  return {
    protocol: TASK_PROFILE_FORMAT_URI,
    profile: REPOSITORY_WORK_PROFILE_URI,
    description:
      "Real-repository code-change work: a pinned repository ref and problem statement, "
      + "delivered as a unified-diff patch (design §8).",
    payloadSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        instance_id: { type: "string" },
        language: { type: "string" },
        interface: { type: "string" },
        provenance: {
          type: "object",
          additionalProperties: true,
          properties: {
            kind: { enum: ["mined", "synthetic", "live"] },
            sourceCommitment: { type: "string" },
          },
          required: ["kind"],
        },
      },
      required: ["language"],
    },
    inputConventions: {
      slots: [
        {
          name: "repository-state",
          required: true,
          // The repository URL rides `uri`; the immutable 40-hex ref rides
          // `annotations.ref`; an optional tree digest rides `digest` (not required, design §8).
          descriptorMustCarry: ["uri", "annotations.ref"],
        },
        {
          name: "knowledge-packet",
          required: false,
          descriptorMustCarry: [],
        },
      ],
    },
    outputConventions: {
      slots: [
        { name: "patch", required: true, mediaType: "text/x-diff" },
        { name: "summary", required: false, mediaType: "text/markdown" },
        { name: "evidence", required: false, mediaType: "application/json" },
      ],
    },
    evaluationFamilies: ["deterministic-process", "model-graded"],
    requirementKeys: [{ key: "effort", comparisonClass: "floor" }],
  };
}

/**
 * Provenance kinds a migrated repository-work Task payload may carry (design §8).
 */
export type RepositoryWorkProvenanceKind = "mined" | "synthetic" | "live";

/**
 * A structural subset of the legacy `jinn-repo.v1` SolverType task fields
 * (`operator/src/solver-types/jinn-repo.ts`, backed by `@jinn-network/sdk/solvernets/jinn-repo`)
 * this migration needs. Declared locally, never imported: profiles imports
 * `task-execution-protocol` only (Global Constraints) — no SDK/client dependency.
 */
export interface LegacyJinnRepoTask {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  language: string;
  /** A raw document with no `source` field is legacy data, treated as `merged-pr` (design §13). */
  source?: "merged-pr" | "live-issue" | "autopilot-session";
  effort?: EffortTier;
}

export interface MigratedRepositoryWorkTask {
  instructions: string;
  payload: Record<string, unknown>;
  inputs: ResourceDescriptorLike[];
  /** Present only when the legacy task carried an `effort` tier (design §13: "effort → core
   * requirement key"); the profile's `requirementKeys` declares `effort` as a `floor` comparison
   * class (design §5.1), consumed by `mergeRequirements` at Submission time. */
  requirements?: Record<string, unknown>;
}

const PROVENANCE_KIND_BY_SOURCE: Record<string, RepositoryWorkProvenanceKind> = {
  "merged-pr": "mined",
  "live-issue": "live",
  // The Autopilot session branch is a deferred stricter sub-profile (design §8/§17); migrated
  // conservatively to `synthetic` (minted work) here, pending that dedicated sub-profile.
  "autopilot-session": "synthetic",
};

/**
 * `jinn-repo.v1` → `repository-work/1.0` (design §13): `problem_statement` → `instructions`;
 * `repo`/`base_commit` → the `repository-state` input; `source` union → `provenance`; `effort` →
 * a core requirement key.
 */
export function migrateJinnRepoTask(legacy: LegacyJinnRepoTask): MigratedRepositoryWorkTask {
  const source = legacy.source ?? "merged-pr";
  const provenanceKind = PROVENANCE_KIND_BY_SOURCE[source] ?? "mined";

  const payload: Record<string, unknown> = {
    instance_id: legacy.instance_id,
    language: legacy.language,
    provenance: { kind: provenanceKind },
  };

  const inputs: ResourceDescriptorLike[] = [
    {
      name: "repository-state",
      uri: `https://github.com/${legacy.repo}`,
      annotations: { ref: legacy.base_commit },
    },
  ];

  const migrated: MigratedRepositoryWorkTask = {
    instructions: legacy.problem_statement,
    payload,
    inputs,
  };
  if (legacy.effort !== undefined) {
    migrated.requirements = { effort: legacy.effort };
  }
  return migrated;
}
