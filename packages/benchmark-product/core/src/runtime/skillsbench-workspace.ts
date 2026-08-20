import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { SkillsBenchArm, SkillsBenchTreatment } from "../method/skillsbench-treatment.js";

/**
 * Materializes one arm of one unit into a runnable workspace.
 *
 * The three arms differ in exactly one thing: where the top-level instruction text lives, or
 * whether it exists at all. Everything else — the task's environment files, and every script,
 * reference, asset and template the bundle ships — lands at the same path with the same bytes in
 * all three, because a resource difference would confound delivery with availability.
 *
 * Arm A gets a Claude Code plugin root and is launched with `--plugin-dir`, which is the native
 * progressive-disclosure path. Arm B gets a root `CLAUDE.md` and no plugin root at all, so nothing
 * is natively discoverable. Arm C gets neither.
 */
export const SKILLSBENCH_WORKSPACE_LAYOUT = "skillsbench-arm-workspace@1" as const;

/** Arm A's plugin root. Outside the task's own tree, so it cannot collide with task content. */
export const SKILLSBENCH_PLUGIN_DIR = ".jinn-demo1-skills";

/** Where bundle resources live in EVERY arm. Fixed, so parity is a path equality, not a promise. */
export const SKILLSBENCH_RESOURCE_ROOT = "skills";

export interface SkillsBenchWorkspaceFile {
  readonly path: string;
  readonly sha256: string;
  readonly mode: number;
}

export interface SkillsBenchWorkspace {
  readonly layout: typeof SKILLSBENCH_WORKSPACE_LAYOUT;
  readonly arm: SkillsBenchArm;
  readonly taskId: string;
  readonly root: string;
  readonly files: readonly SkillsBenchWorkspaceFile[];
  /** Extra launcher argv this arm requires. Only arm A has any. */
  readonly argv: readonly string[];
  /** Digest over the non-instruction files. Equal across arms or the materialization is wrong. */
  readonly resourceParityDigest: string;
}

export interface SkillsBenchWorkspaceInput {
  readonly treatment: SkillsBenchTreatment;
  readonly arm: SkillsBenchArm;
  /** The unit's package on disk, as fetched from the pinned release. */
  readonly packageDir: string;
  readonly workspaceDir: string;
  /** Arm B's generated root `CLAUDE.md`, already proven body-byte identical. */
  readonly claudeMd?: string;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function walk(dir: string): string[] {
  const out: string[] = [];
  const descend = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const child = join(current, name);
      if (statSync(child).isDirectory()) descend(child);
      else out.push(child);
    }
  };
  descend(dir);
  return out;
}

function place(root: string, path: string, bytes: Uint8Array, mode: number): SkillsBenchWorkspaceFile {
  const target = join(root, ...path.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes, { mode });
  return { path, sha256: sha256(bytes), mode };
}

/**
 * Builds the workspace on disk and returns exactly what landed.
 *
 * The returned file list is the evidence: a reader compares the resource-parity digest across the
 * three arms and checks that arm B and arm C carry no `SKILL.md` and no plugin root, without
 * trusting this function.
 */
export function materializeSkillsBenchWorkspace(
  input: SkillsBenchWorkspaceInput,
): SkillsBenchWorkspace {
  const { treatment, arm, packageDir, workspaceDir } = input;
  if (!treatment.feasible) {
    throw new TypeError(`${treatment.taskId} is unverifiable and must not be materialized: ${treatment.unverifiableReasons.join(", ")}`);
  }
  mkdirSync(workspaceDir, { recursive: true });
  const files: SkillsBenchWorkspaceFile[] = [];
  const environment = join(packageDir, "environment");

  for (const absolute of walk(environment)) {
    const rel = relative(environment, absolute).split(/[\\/]/u).join("/");
    if (rel === "Dockerfile" || rel === "Dockerfile.pinned") continue;
    const bytes = new Uint8Array(readFileSync(absolute));
    const mode = (statSync(absolute).mode & 0o111) === 0 ? 0o644 : 0o755;

    const skill = /^skills\/([^/]+)\/(.+)$/u.exec(rel);
    if (skill === null) {
      // Ordinary task environment content — identical in every arm.
      files.push(place(workspaceDir, rel, bytes, mode));
      continue;
    }
    const [, folder, member] = skill as unknown as [string, string, string];
    if (member === "SKILL.md") {
      // The one file that varies. Arm A gets it inside a plugin root so native discovery finds it;
      // arms B and C never receive it in any form.
      if (arm === "A-native-skill") {
        files.push(place(workspaceDir, `${SKILLSBENCH_PLUGIN_DIR}/skills/${folder}/SKILL.md`, bytes, 0o644));
      }
      continue;
    }
    // Every other bundle file lands at the same path in all three arms.
    files.push(place(workspaceDir, `${SKILLSBENCH_RESOURCE_ROOT}/${folder}/${member}`, bytes, mode));
  }

  if (arm === "A-native-skill") {
    const manifest = new TextEncoder().encode('{"name":"jinn-demo1-skills","version":"1.0.0"}\n');
    files.push(place(workspaceDir, `${SKILLSBENCH_PLUGIN_DIR}/.claude-plugin/plugin.json`, manifest, 0o644));
  }
  if (arm === "B-flat-claude-md") {
    if (input.claudeMd === undefined) throw new TypeError("arm B requires the generated CLAUDE.md");
    files.push(place(workspaceDir, "CLAUDE.md", new TextEncoder().encode(input.claudeMd), 0o644));
  }

  const sorted = [...files].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const resources = sorted.filter((file) => file.path !== "CLAUDE.md" && !file.path.startsWith(`${SKILLSBENCH_PLUGIN_DIR}/`));
  return {
    layout: SKILLSBENCH_WORKSPACE_LAYOUT,
    arm,
    taskId: treatment.taskId,
    root: workspaceDir,
    files: sorted,
    argv: arm === "A-native-skill" ? ["--plugin-dir", join(workspaceDir, SKILLSBENCH_PLUGIN_DIR)] : [],
    resourceParityDigest: sha256(resources.map((file) => `${file.path}:${file.sha256}:${file.mode}`).join("\n")),
  };
}

/** The properties a reader checks across a materialized A/B/C triple. */
export function verifySkillsBenchWorkspaceTriple(
  workspaces: readonly SkillsBenchWorkspace[],
): void {
  const byArm = new Map(workspaces.map((workspace) => [workspace.arm, workspace]));
  for (const arm of ["A-native-skill", "B-flat-claude-md", "C-no-instructions"] as const) {
    if (!byArm.has(arm)) throw new TypeError(`workspace triple is missing arm ${arm}`);
  }
  const digests = new Set(workspaces.map((workspace) => workspace.resourceParityDigest));
  if (digests.size !== 1) {
    throw new TypeError("arms do not carry byte-identical non-instruction resources");
  }
  for (const arm of ["B-flat-claude-md", "C-no-instructions"] as const) {
    const workspace = byArm.get(arm)!;
    if (workspace.files.some((file) => file.path.endsWith("SKILL.md"))) {
      throw new TypeError(`arm ${arm} exposes a natively discoverable SKILL.md`);
    }
    if (workspace.files.some((file) => file.path.startsWith(`${SKILLSBENCH_PLUGIN_DIR}/`))) {
      throw new TypeError(`arm ${arm} carries a plugin root`);
    }
    if (workspace.argv.length > 0) throw new TypeError(`arm ${arm} must not pass a loader argument`);
  }
  const c = byArm.get("C-no-instructions")!;
  if (c.files.some((file) => file.path === "CLAUDE.md")) {
    throw new TypeError("arm C carries an experiment-created instruction path");
  }
  const b = byArm.get("B-flat-claude-md")!;
  if (!b.files.some((file) => file.path === "CLAUDE.md")) {
    throw new TypeError("arm B is missing its flattened instruction file");
  }
  const a = byArm.get("A-native-skill")!;
  if (!a.files.some((file) => file.path.endsWith("SKILL.md"))) {
    throw new TypeError("arm A is missing its curated SKILL.md files");
  }
}
