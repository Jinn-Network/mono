import { compareCodeUnitStrings } from "@jinn-network/benchmarking-records";
import {
  DEMO1_PRE_E2_OFFICIAL_FEASIBILITY_FLOOR,
  DEMO1_REHEARSAL_POOL_REQUIREMENT,
  DEMO1_SUITABILITY_POOL_REQUIREMENT,
} from "./demo1-prerun.js";
import {
  deriveSkillsBenchClusters,
  skillsBenchClusterOf,
  type SkillsBenchClusterGraph,
  type SkillsBenchClusterInput,
} from "./skillsbench-clusters.js";
import type { SkillsBenchUnit } from "./skillsbench-unit.js";

/**
 * Static admission: everything provable from source bytes, before any container runs and with no
 * model execution anywhere.
 *
 * The staging is load-bearing rather than an optimisation. If static capacity cannot reach the
 * pool floors, the method stops without ever pulling an image — which is exactly what the
 * superseded method did at its domain ceiling, and exactly what this one must be able to do again.
 */
export const SKILLSBENCH_ADMISSION_POLICY = "skillsbench-static-admission@1" as const;

/**
 * Instruction files that would collide with the experiment's own materialization. Reused verbatim
 * from the superseded method's conflict list, which is the same hazard in a different workspace.
 */
export const SKILLSBENCH_CONFLICTING_INSTRUCTION_PATHS = [
  "CLAUDE.md",
  "AGENTS.md",
  "SKILL.md",
  ".cursorrules",
] as const;

/** Terms in a task statement that would disclose the treatment or name the bundled mechanism. */
const DISCLOSURE_TERMS = /\b(?:SKILL\.md|CLAUDE\.md|AGENTS\.md|agent skill|skills? (?:folder|director)|progressive disclosure)\b/iu;

export type SkillsBenchCheckStatus = "match" | "mismatch" | "unverifiable";

/**
 * Every check a unit must clear. Dynamic checks are declared here and resolved `unverifiable` at
 * this stage with an exact reason, so a missing proof is never silently read as a pass.
 */
export const SKILLSBENCH_ADMISSION_CHECKS = [
  "sourceIdentityAuthenticated",
  "packageSelfContained",
  "licenseCompatible",
  "conflictingInstructionFileAbsent",
  "statementDisclosureAbsent",
  "answerCollisionAbsent",
  "runtimeIsolationSatisfiable",
  "immutableRuntimeIdentity",
  "oracleReachesFullSuccess",
  "noOpSubmissionFails",
  "treatmentTransformFeasible",
] as const;
export type SkillsBenchAdmissionCheck = typeof SKILLSBENCH_ADMISSION_CHECKS[number];

/** Checks resolvable without Docker or a model. The rest are staged for later, never assumed. */
export const SKILLSBENCH_STATIC_CHECKS: readonly SkillsBenchAdmissionCheck[] = [
  "sourceIdentityAuthenticated",
  "packageSelfContained",
  "licenseCompatible",
  "conflictingInstructionFileAbsent",
  "statementDisclosureAbsent",
  "answerCollisionAbsent",
  "runtimeIsolationSatisfiable",
];

export interface SkillsBenchCheckResult {
  readonly status: SkillsBenchCheckStatus;
  readonly detail: string;
}

export interface SkillsBenchUnitVerdict {
  readonly taskId: string;
  readonly clusterId: string;
  readonly checks: Readonly<Record<SkillsBenchAdmissionCheck, SkillsBenchCheckResult>>;
  readonly staticallyEligible: boolean;
  readonly rejectionReasons: readonly string[];
}

export interface SkillsBenchCapacity {
  readonly units: number;
  readonly clusters: number;
  readonly requiredUnits: number;
  readonly requiredClusters: number;
  readonly sufficient: boolean;
}

export interface SkillsBenchStaticAdmission {
  readonly policy: typeof SKILLSBENCH_ADMISSION_POLICY;
  readonly checks: typeof SKILLSBENCH_ADMISSION_CHECKS;
  readonly staticChecks: readonly SkillsBenchAdmissionCheck[];
  readonly clusterGraph: SkillsBenchClusterGraph;
  readonly verdicts: readonly SkillsBenchUnitVerdict[];
  readonly capacity: SkillsBenchCapacity;
  readonly rejectionSummary: readonly { readonly reason: string; readonly units: number }[];
  readonly execution: { readonly modelArms: 0; readonly previews: 0; readonly dockerControls: 0 };
}

/**
 * Combined floor: 6 suitability + 10 rehearsal + 5 official-feasibility units across
 * 6 + 5 + 2 cluster-disjoint clusters. Imported from the superseded method's constants so the two
 * lineages cannot drift apart.
 */
export const SKILLSBENCH_REQUIRED_UNITS =
  DEMO1_SUITABILITY_POOL_REQUIREMENT.tasks
  + DEMO1_REHEARSAL_POOL_REQUIREMENT.tasks
  + DEMO1_PRE_E2_OFFICIAL_FEASIBILITY_FLOOR.tasks;

export const SKILLSBENCH_REQUIRED_CLUSTERS =
  DEMO1_SUITABILITY_POOL_REQUIREMENT.repositories
  + DEMO1_REHEARSAL_POOL_REQUIREMENT.repositories
  + DEMO1_PRE_E2_OFFICIAL_FEASIBILITY_FLOOR.repositories;

function match(detail: string): SkillsBenchCheckResult {
  return { status: "match", detail };
}

function mismatch(detail: string): SkillsBenchCheckResult {
  return { status: "mismatch", detail };
}

function unverifiable(detail: string): SkillsBenchCheckResult {
  return { status: "unverifiable", detail };
}

/**
 * Runtime isolation, evaluated from the unit's own declared network mode.
 *
 * `no-network` is admissible outright. `public` is not admissible on its own evidence: the
 * SkillsBench schema has no allowlist, so a `public` unit's agent could reach github.com and fetch
 * the task's own oracle and verifier. DR-2026-08-16 Decision 6 gates that on a reviewed per-unit
 * egress broker which does not exist yet, so the check resolves `unverifiable` — never `match`,
 * and never a silent pass.
 */
function runtimeIsolation(unit: SkillsBenchUnit): SkillsBenchCheckResult {
  if (unit.statement.frontmatter.networkMode === "no-network") {
    return match("task declares no-network; all required execution completes offline");
  }
  return unverifiable(
    "task declares network_mode public and SkillsBench provides no allowlist; admissible only "
    + "through a separately reviewed per-unit egress broker that cannot reach source, oracle, "
    + "verifier, or answer material (DR-2026-08-16 Decision 6, not yet built)",
  );
}

function conflictingInstructionFile(unit: SkillsBenchUnit): SkillsBenchCheckResult {
  // The agent workspace is the environment tree. A curated SKILL.md under environment/skills is
  // the treatment, not a conflict; anything else on the list is a pre-existing instruction path.
  const conflicts = unit.environment.nonSkillFiles
    .map((file) => file.path)
    .filter((path) => SKILLSBENCH_CONFLICTING_INSTRUCTION_PATHS.some(
      (name) => path === `environment/${name}` || path.endsWith(`/${name}`),
    ));
  return conflicts.length === 0
    ? match("no pre-existing conflicting instruction file in the execution workspace")
    : mismatch(`workspace already contains ${conflicts.sort(compareCodeUnitStrings).join(", ")}`);
}

function statementDisclosure(unit: SkillsBenchUnit, statementBody: string): SkillsBenchCheckResult {
  const named = unit.skills
    .filter((skill) => new RegExp(`\\b${skill.name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "iu").test(statementBody))
    .map((skill) => skill.name);
  if (named.length > 0) return mismatch(`statement names bundled skill(s): ${named.sort(compareCodeUnitStrings).join(", ")}`);
  const disclosure = DISCLOSURE_TERMS.exec(statementBody);
  return disclosure === null
    ? match("statement names no bundled skill and discloses no delivery mechanism")
    : mismatch(`statement discloses the treatment mechanism: "${disclosure[0]}"`);
}

export interface SkillsBenchAdmissionInput {
  readonly unit: SkillsBenchUnit;
  readonly statementBody: string;
  readonly cluster: Omit<SkillsBenchClusterInput, "taskId">;
  /** True when a token-level collision was found between statement/skills and oracle/verifier. */
  readonly answerCollision: null | string;
}

export function assessSkillsBenchStaticAdmission(
  inputs: readonly SkillsBenchAdmissionInput[],
): SkillsBenchStaticAdmission {
  const clusterGraph = deriveSkillsBenchClusters(
    inputs.map((input) => ({ taskId: input.unit.task.name, ...input.cluster })),
  );
  const clusterOf = skillsBenchClusterOf(clusterGraph);

  const verdicts: SkillsBenchUnitVerdict[] = inputs.map((input) => {
    const { unit } = input;
    const checks: Record<SkillsBenchAdmissionCheck, SkillsBenchCheckResult> = {
      sourceIdentityAuthenticated: match(`task tree ${unit.task.treeSha} at ${unit.source.commit}`),
      packageSelfContained: match("no submodule, symlink, or special entry in the package"),
      licenseCompatible: unit.license.status === "compatible"
        ? match(`root ${unit.license.rootSpdxId}; no incompatible per-skill license`)
        : mismatch(unit.license.reasons.join(", ")),
      conflictingInstructionFileAbsent: conflictingInstructionFile(unit),
      statementDisclosureAbsent: statementDisclosure(unit, input.statementBody),
      answerCollisionAbsent: input.answerCollision === null
        ? match("no token collision between statement/skills and oracle/verifier")
        : mismatch(input.answerCollision),
      runtimeIsolationSatisfiable: runtimeIsolation(unit),
      immutableRuntimeIdentity: unverifiable(
        "environment/Dockerfile starts from a mutable base tag and the package carries no image "
        + "digest; resolution and build pinning are dynamic-stage work",
      ),
      oracleReachesFullSuccess: unverifiable("not run before the static capacity screen"),
      noOpSubmissionFails: unverifiable("not run before the static capacity screen"),
      treatmentTransformFeasible: unverifiable("arm materialization feasibility is resolved with the treatment manifest"),
    };
    const rejectionReasons = SKILLSBENCH_STATIC_CHECKS
      .filter((name) => checks[name].status !== "match")
      .map((name) => `${name}:${checks[name].status}`)
      .sort(compareCodeUnitStrings);
    return {
      taskId: unit.task.name,
      clusterId: clusterOf.get(unit.task.name)!,
      checks,
      staticallyEligible: rejectionReasons.length === 0,
      rejectionReasons,
    };
  }).sort((left, right) => compareCodeUnitStrings(left.taskId, right.taskId));

  const eligible = verdicts.filter((verdict) => verdict.staticallyEligible);
  const clusters = new Set(eligible.map((verdict) => verdict.clusterId));
  const reasonCounts = new Map<string, number>();
  for (const verdict of verdicts) {
    for (const reason of verdict.rejectionReasons) reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }

  return {
    policy: SKILLSBENCH_ADMISSION_POLICY,
    checks: SKILLSBENCH_ADMISSION_CHECKS,
    staticChecks: SKILLSBENCH_STATIC_CHECKS,
    clusterGraph,
    verdicts,
    capacity: {
      units: eligible.length,
      clusters: clusters.size,
      requiredUnits: SKILLSBENCH_REQUIRED_UNITS,
      requiredClusters: SKILLSBENCH_REQUIRED_CLUSTERS,
      sufficient: eligible.length >= SKILLSBENCH_REQUIRED_UNITS && clusters.size >= SKILLSBENCH_REQUIRED_CLUSTERS,
    },
    rejectionSummary: [...reasonCounts]
      .map(([reason, units]) => ({ reason, units }))
      .sort((left, right) => right.units - left.units || compareCodeUnitStrings(left.reason, right.reason)),
    execution: { modelArms: 0, previews: 0, dockerControls: 0 },
  };
}
