import { createHash } from "node:crypto";
import {
  compareCodeUnitStrings,
  serializeCanonicalJson,
  type JsonValue,
} from "@jinn-network/benchmarking-records";
import type { SkillsBenchSkill, SkillsBenchUnit } from "./skillsbench-unit.js";

/**
 * Deterministic A/B/C materialization from one authenticated task-bundle unit.
 *
 * Arm A is the bundle verbatim. Arm B carries the same authenticated instruction bodies in a root
 * `CLAUDE.md` with no native-discoverable `SKILL.md`. Arm C carries no instruction bodies at all.
 * All three carry byte-identical non-instruction resources and the same base environment, so the
 * only thing that varies is how the top-level instruction text is delivered.
 *
 * BenchFlow's own `--skill-mode` flags do not supply this. `with-skill` is close to arm A, there is
 * no flatten mode for arm B, and native `no-skill` strips the whole `environment/skills` tree —
 * resources included — which would confound delivery with resource availability. Jinn therefore
 * owns all three arms.
 */
export const SKILLSBENCH_TREATMENT_SCHEMA = "jinn.demo1.treatment-manifest.v1" as const;

/**
 * The Arm B transform. Versioned and content-neutral: a marker carrying the source identity and
 * the body digest, and nothing else. No trigger wording, no summary, no rewriting.
 *
 * Ordering is lexical by upstream skill folder path. That is the only ordering the source itself
 * provides — neither `registry.json` nor the release manifest imposes one, and `task.md` does not
 * enumerate skills — so any other rule would be experiment-authored.
 */
export const SKILLSBENCH_CLAUDE_MD_TRANSFORM = "jinn.demo1.claude-md-flatten@1" as const;

export type SkillsBenchArm = "A-native-skill" | "B-flat-claude-md" | "C-no-instructions";
export const SKILLSBENCH_ARMS: readonly SkillsBenchArm[] = [
  "A-native-skill",
  "B-flat-claude-md",
  "C-no-instructions",
];

/**
 * A body that reaches for a sibling resource by relative path cannot be moved to the repository
 * root without changing what the path resolves to. Such a unit is `unverifiable`; it is never
 * hand-repaired, because repairing it would edit the instruction bytes the experiment holds fixed.
 */
const RELATIVE_RESOURCE_REFERENCE =
  /(?:^|[\s"'`(\[])(?:\.\/)?(?:scripts|references|assets|rules|templates|resources|ooxml)\/[A-Za-z0-9._-]+/u;

export interface SkillsBenchArmFile {
  readonly path: string;
  readonly mode: string;
  readonly sha256?: string;
  readonly gitBlob?: string;
  readonly role: "instruction-body" | "flattened-instruction" | "bundle-resource" | "environment";
}

export interface SkillsBenchArmPlan {
  readonly arm: SkillsBenchArm;
  readonly files: readonly SkillsBenchArmFile[];
  readonly nativeSkillDiscovery: boolean;
  readonly claudeMdSha256: string | null;
}

export interface SkillsBenchTreatment {
  readonly schema: typeof SKILLSBENCH_TREATMENT_SCHEMA;
  readonly transform: typeof SKILLSBENCH_CLAUDE_MD_TRANSFORM;
  readonly taskId: string;
  readonly feasible: boolean;
  readonly unverifiableReasons: readonly string[];
  readonly skillOrder: readonly string[];
  readonly bodies: readonly { readonly folder: string; readonly bodySha256: string; readonly bodyBytes: number }[];
  readonly arms: readonly SkillsBenchArmPlan[];
  /** Digest of the resource set every arm receives identically. Equal across A, B, and C or the unit fails. */
  readonly sharedResourceDigest: string;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalBytes(value: unknown): Uint8Array {
  return serializeCanonicalJson(value as JsonValue);
}

/** One wrapped span. Content-neutral by construction: identity and digest only. */
export function skillsBenchFlattenSpan(skill: Pick<SkillsBenchSkill, "skillMdPath" | "bodySha256">, body: string): string {
  const open = `<!-- ${SKILLSBENCH_CLAUDE_MD_TRANSFORM} begin source=${skill.skillMdPath} sha256=${skill.bodySha256} -->`;
  const close = `<!-- ${SKILLSBENCH_CLAUDE_MD_TRANSFORM} end source=${skill.skillMdPath} -->`;
  return `${open}\n${body}${body.endsWith("\n") ? "" : "\n"}${close}`;
}

/** Builds arm B's root `CLAUDE.md` from the authenticated bodies, in canonical order. */
export function buildSkillsBenchClaudeMd(
  unit: SkillsBenchUnit,
  bodies: readonly { readonly folder: string; readonly body: string }[],
): string {
  const byFolder = new Map(bodies.map((entry) => [entry.folder, entry.body]));
  const ordered = [...unit.skills].sort((left, right) => compareCodeUnitStrings(left.skillMdPath, right.skillMdPath));
  return ordered.map((skill) => {
    const body = byFolder.get(skill.folder);
    if (body === undefined) throw new TypeError(`${skill.folder} has no supplied instruction body`);
    if (sha256(body) !== skill.bodySha256) {
      throw new TypeError(`${skill.folder} supplied body does not match its authenticated digest`);
    }
    return skillsBenchFlattenSpan(skill, body);
  }).join("\n");
}

/**
 * Extracts every wrapped span from a generated `CLAUDE.md` and proves each is byte-identical to its
 * authenticated upstream body. This is what makes acceptance criterion 7 checkable from the emitted
 * file alone, without trusting the generator.
 */
export function verifySkillsBenchClaudeMdBodies(claudeMd: string, unit: SkillsBenchUnit): void {
  const ordered = [...unit.skills].sort((left, right) => compareCodeUnitStrings(left.skillMdPath, right.skillMdPath));
  const pattern = new RegExp(
    `<!-- ${SKILLSBENCH_CLAUDE_MD_TRANSFORM} begin source=(\\S+) sha256=([0-9a-f]{64}) -->\\n([\\s\\S]*?)<!-- ${SKILLSBENCH_CLAUDE_MD_TRANSFORM} end source=\\1 -->`,
    "gu",
  );
  const spans = [...claudeMd.matchAll(pattern)];
  if (spans.length !== ordered.length) {
    throw new TypeError(`CLAUDE.md carries ${spans.length} wrapped bodies; the unit has ${ordered.length}`);
  }
  spans.forEach((span, index) => {
    const skill = ordered[index]!;
    if (span[1] !== skill.skillMdPath) {
      throw new TypeError(`CLAUDE.md span ${index} names ${span[1]}; canonical order expects ${skill.skillMdPath}`);
    }
    if (sha256(span[3]!) !== skill.bodySha256 || span[2] !== skill.bodySha256) {
      throw new TypeError(`CLAUDE.md body for ${skill.skillMdPath} is not byte-identical to its authenticated upstream body`);
    }
  });
  if (/^---\s*$/mu.test(claudeMd.replace(pattern, ""))) {
    throw new TypeError("CLAUDE.md carries frontmatter outside the wrapped bodies");
  }
}

export interface SkillsBenchTreatmentInput {
  readonly unit: SkillsBenchUnit;
  readonly bodies: readonly { readonly folder: string; readonly body: string }[];
}

export function buildSkillsBenchTreatment(input: SkillsBenchTreatmentInput): SkillsBenchTreatment {
  const { unit } = input;
  const ordered = [...unit.skills].sort((left, right) => compareCodeUnitStrings(left.skillMdPath, right.skillMdPath));
  const byFolder = new Map(input.bodies.map((entry) => [entry.folder, entry.body]));

  const unverifiableReasons: string[] = [];
  for (const skill of ordered) {
    const body = byFolder.get(skill.folder);
    if (body === undefined) {
      unverifiableReasons.push(`${skill.folder}:body-not-supplied`);
      continue;
    }
    if (sha256(body) !== skill.bodySha256) {
      unverifiableReasons.push(`${skill.folder}:body-digest-mismatch`);
      continue;
    }
    const reference = RELATIVE_RESOURCE_REFERENCE.exec(body);
    if (reference !== null) {
      // Moving this body to the repository root changes what its relative paths resolve to, so
      // arms A and B would not be receiving the same instructions in practice.
      unverifiableReasons.push(`${skill.folder}:relative-resource-reference:${reference[0].trim()}`);
    }
  }

  // Every arm receives the same non-instruction resources and the same environment. Arm A adds
  // SKILL.md files; arm B adds root CLAUDE.md; arm C adds nothing.
  const resources: SkillsBenchArmFile[] = [
    ...ordered.flatMap((skill) => skill.resources.map((resource) => ({
      path: `${skill.skillMdPath.slice(0, skill.skillMdPath.lastIndexOf("/"))}/${resource.path}`,
      mode: resource.mode,
      gitBlob: resource.gitBlob,
      role: "bundle-resource" as const,
    }))),
    ...unit.environment.nonSkillFiles.map((file) => ({
      path: file.path,
      mode: file.mode,
      gitBlob: file.gitBlob,
      role: "environment" as const,
    })),
    {
      path: unit.environment.dockerfile.path,
      mode: unit.environment.dockerfile.mode,
      gitBlob: unit.environment.dockerfile.gitBlob,
      role: "environment" as const,
    },
  ].sort((left, right) => compareCodeUnitStrings(left.path, right.path));

  const feasible = unverifiableReasons.length === 0;
  const claudeMd = feasible ? buildSkillsBenchClaudeMd(unit, input.bodies) : null;

  const arms: SkillsBenchArmPlan[] = [
    {
      arm: "A-native-skill",
      files: [
        ...ordered.map((skill) => ({
          path: skill.skillMdPath,
          mode: "100644",
          sha256: skill.skillMdSha256,
          role: "instruction-body" as const,
        })),
        ...resources,
      ].sort((left, right) => compareCodeUnitStrings(left.path, right.path)),
      nativeSkillDiscovery: true,
      claudeMdSha256: null,
    },
    {
      arm: "B-flat-claude-md",
      files: [
        ...(claudeMd === null ? [] : [{
          path: "CLAUDE.md",
          mode: "100644",
          sha256: sha256(claudeMd),
          role: "flattened-instruction" as const,
        }]),
        ...resources,
      ].sort((left, right) => compareCodeUnitStrings(left.path, right.path)),
      nativeSkillDiscovery: false,
      claudeMdSha256: claudeMd === null ? null : sha256(claudeMd),
    },
    {
      arm: "C-no-instructions",
      files: [...resources],
      nativeSkillDiscovery: false,
      claudeMdSha256: null,
    },
  ];

  return {
    schema: SKILLSBENCH_TREATMENT_SCHEMA,
    transform: SKILLSBENCH_CLAUDE_MD_TRANSFORM,
    taskId: unit.task.name,
    feasible,
    unverifiableReasons: [...unverifiableReasons].sort(compareCodeUnitStrings),
    skillOrder: ordered.map((skill) => skill.folder),
    bodies: ordered.map((skill) => ({ folder: skill.folder, bodySha256: skill.bodySha256, bodyBytes: skill.bodyBytes })),
    arms,
    sharedResourceDigest: sha256(canonicalBytes(resources)),
  };
}

/** Independently checkable parity properties across the three arms. */
export function verifySkillsBenchTreatment(treatment: SkillsBenchTreatment): void {
  if (treatment.schema !== SKILLSBENCH_TREATMENT_SCHEMA) throw new TypeError("treatment manifest schema mismatch");
  const arms = new Map(treatment.arms.map((arm) => [arm.arm, arm]));
  for (const name of SKILLSBENCH_ARMS) {
    if (!arms.has(name)) throw new TypeError(`treatment manifest is missing arm ${name}`);
  }

  const resourcesOf = (arm: SkillsBenchArmPlan) => arm.files
    .filter((file) => file.role === "bundle-resource" || file.role === "environment")
    .sort((left, right) => compareCodeUnitStrings(left.path, right.path));
  const reference = sha256(canonicalBytes(resourcesOf(arms.get("A-native-skill")!)));
  for (const name of SKILLSBENCH_ARMS) {
    if (sha256(canonicalBytes(resourcesOf(arms.get(name)!))) !== reference) {
      throw new TypeError(`arm ${name} does not receive byte-identical non-instruction resources`);
    }
  }
  if (reference !== treatment.sharedResourceDigest) {
    throw new TypeError("shared resource digest does not recompute from the arm plans");
  }

  const b = arms.get("B-flat-claude-md")!;
  const c = arms.get("C-no-instructions")!;
  if (b.nativeSkillDiscovery || c.nativeSkillDiscovery) {
    throw new TypeError("arms B and C must not expose native skill discovery");
  }
  if (b.files.some((file) => file.path.endsWith("SKILL.md")) || c.files.some((file) => file.path.endsWith("SKILL.md"))) {
    throw new TypeError("arms B and C must expose no native-discoverable SKILL.md");
  }
  if (c.files.some((file) => file.role === "instruction-body" || file.role === "flattened-instruction")) {
    throw new TypeError("arm C must carry no instruction body and no experiment-created instruction path");
  }
  if (c.claudeMdSha256 !== null) throw new TypeError("arm C must not materialize CLAUDE.md");
  if (treatment.feasible && b.claudeMdSha256 === null) {
    throw new TypeError("a feasible unit must materialize arm B's CLAUDE.md");
  }
  if (!treatment.feasible && treatment.unverifiableReasons.length === 0) {
    throw new TypeError("an infeasible treatment must name its reasons");
  }
}

export function canonicalSkillsBenchTreatmentBytes(treatment: SkillsBenchTreatment): Uint8Array {
  verifySkillsBenchTreatment(treatment);
  return canonicalBytes(treatment);
}
