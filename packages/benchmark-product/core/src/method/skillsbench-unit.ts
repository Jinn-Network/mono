import { createHash } from "node:crypto";
import {
  compareCodeUnitStrings,
  serializeCanonicalJson,
  type JsonValue,
} from "@jinn-network/benchmarking-records";
import { parseDemo1UpstreamSkill } from "./demo1-prerun.js";
import { SKILLSBENCH_V1_1_SOURCE } from "./skillsbench-source.js";

/**
 * The Demo-1 experimental unit after DR-2026-08-16: one exact upstream SkillsBench task package
 * together with its complete curated Skill bundle.
 *
 * Multi-Skill bundles are the common case — 66 of the 87 active tasks carry more than one Skill —
 * so this schema has no notion of a winning candidate. It describes bytes that stay upstream
 * identical; every field is a path, a mode, a blob, or a digest.
 */
export const SKILLSBENCH_TASK_BUNDLE_UNIT_SCHEMA = "jinn.demo1.task-bundle-unit.v1" as const;

/**
 * Resource classes. `instruction-bearing` exists because the roster ships 110 `references/` and 96
 * `rules/` directories full of procedural prose, plus markdown at skill roots. Calling all of that
 * "non-instruction resources" would quietly understate what arms B and C still receive, so the
 * class is named and the eventual report carries it as a stated limitation.
 */
export const SKILLSBENCH_RESOURCE_CLASSES = [
  "instruction-bearing",
  "executable-resource",
  "data-resource",
  "license-notice",
] as const;
export type SkillsBenchResourceClass = typeof SKILLSBENCH_RESOURCE_CLASSES[number];

export const SKILLSBENCH_NETWORK_MODES = ["no-network", "public"] as const;
export type SkillsBenchNetworkMode = typeof SKILLSBENCH_NETWORK_MODES[number];

/** Git file modes a task package may contain. Anything else is refused before classification. */
const REGULAR_MODE = "100644";
const EXECUTABLE_MODE = "100755";
const SUBMODULE_MODE = "160000";

const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_BLOB = /^[0-9a-f]{40}$/u;
const LICENSE_NAME = /(?:^|\.)(?:LICENSE|LICENCE|NOTICE|COPYING)(?:\.[A-Za-z0-9]+)?$/u;
const MARKDOWN = /\.md$/iu;
const SCRIPT_EXTENSION = /\.(?:py|sh|js|mjs|cjs|ts|rb|pl)$/iu;

export interface SkillsBenchEntry {
  readonly path: string;
  readonly mode: string;
  readonly gitBlob: string;
  readonly bytes: number;
}

export interface SkillsBenchUnitBuildInput {
  readonly task: { readonly name: string; readonly treeSha: string; readonly packageDigest: string };
  readonly statement: {
    readonly path: string;
    readonly gitBlob: string;
    readonly bytes: number;
    readonly frontmatter: {
      readonly networkMode: string;
      readonly verifierType: string;
      readonly agentTimeoutSec: number;
      readonly verifierTimeoutSec: number;
    };
    readonly body: string;
  };
  readonly entries: readonly SkillsBenchEntry[];
  readonly skills: readonly { readonly folder: string; readonly skillMd: string }[];
  readonly rootLicenseSpdxId: string;
}

export interface SkillsBenchResource {
  readonly path: string;
  readonly mode: string;
  readonly gitBlob: string;
  readonly bytes: number;
  readonly classification: SkillsBenchResourceClass;
}

export interface SkillsBenchSkill {
  readonly folder: string;
  readonly name: string;
  readonly description: string;
  readonly skillMdPath: string;
  readonly skillMdSha256: string;
  readonly frontmatterSha256: string;
  readonly bodySha256: string;
  readonly bodyBytes: number;
  readonly license: null | {
    readonly path: string;
    readonly gitBlob: string;
    readonly spdxId: string;
    readonly status: "compatible" | "incompatible";
  };
  readonly resources: readonly SkillsBenchResource[];
}

export interface SkillsBenchUnit {
  readonly schema: typeof SKILLSBENCH_TASK_BUNDLE_UNIT_SCHEMA;
  readonly source: {
    readonly repositoryUrl: typeof SKILLSBENCH_V1_1_SOURCE.repositoryUrl;
    readonly releaseTag: typeof SKILLSBENCH_V1_1_SOURCE.releaseTag;
    readonly commit: typeof SKILLSBENCH_V1_1_SOURCE.commit;
  };
  readonly task: SkillsBenchUnitBuildInput["task"];
  readonly statement: {
    readonly path: string;
    readonly gitBlob: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly frontmatter: {
      readonly networkMode: SkillsBenchNetworkMode;
      readonly verifierType: string;
      readonly agentTimeoutSec: number;
      readonly verifierTimeoutSec: number;
    };
  };
  readonly environment: {
    readonly dockerfile: SkillsBenchEntry;
    readonly nonSkillFiles: readonly SkillsBenchEntry[];
  };
  readonly skills: readonly SkillsBenchSkill[];
  readonly oracle: readonly SkillsBenchEntry[];
  readonly verifier: readonly SkillsBenchEntry[];
  readonly license: {
    readonly rootSpdxId: string;
    readonly status: "compatible" | "incompatible";
    readonly reasons: readonly string[];
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalBytes(value: unknown): Uint8Array {
  return serializeCanonicalJson(value as JsonValue);
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return Buffer.from(canonicalBytes(left)).equals(Buffer.from(canonicalBytes(right)));
}

function byPath<T extends { readonly path: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((left, right) => compareCodeUnitStrings(left.path, right.path));
}

/**
 * Classification is by path shape and mode only — never by reading content, so it stays
 * deterministic and outcome-blind. License notices are checked first because `obspy.LICENSE` would
 * otherwise fall through to data, and markdown before scripts because a `.md` in `scripts/` is
 * still prose.
 */
export function classifySkillsBenchResource(path: string, mode: string): SkillsBenchResourceClass {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (LICENSE_NAME.test(name)) return "license-notice";
  if (MARKDOWN.test(name)) return "instruction-bearing";
  if (mode === EXECUTABLE_MODE || SCRIPT_EXTENSION.test(name)) return "executable-resource";
  return "data-resource";
}

function assertMaterializable(entries: readonly SkillsBenchEntry[], task: string): void {
  for (const entry of entries) {
    if (entry.mode === SUBMODULE_MODE) {
      // simpo-code-reproduction/environment/SimPO/alignment-handbook is a real gitlink in this
      // roster. A tree SHA pins the pointer, not the pointed-at bytes, so the package is not
      // self-contained and its third-party licence is not established here.
      throw new TypeError(`${task} contains a git submodule at "${entry.path}"; the package is not self-contained`);
    }
    if (entry.mode !== REGULAR_MODE && entry.mode !== EXECUTABLE_MODE) {
      throw new TypeError(`${task} has an unsupported file mode "${entry.mode}" at "${entry.path}"`);
    }
    if (!GIT_BLOB.test(entry.gitBlob)) throw new TypeError(`${task} has a malformed blob id at "${entry.path}"`);
  }
}

function skillLicense(
  entries: readonly SkillsBenchEntry[],
  folder: string,
): SkillsBenchSkill["license"] {
  const prefix = `environment/skills/${folder}/`;
  const license = entries.find(
    (entry) => entry.path.startsWith(prefix)
      && LICENSE_NAME.test(entry.path.slice(prefix.length))
      && !entry.path.slice(prefix.length).includes("/"),
  );
  if (license === undefined) return null;
  const sourceAvailable = license.gitBlob === SKILLSBENCH_V1_1_SOURCE.sourceAvailableLicenseBlob;
  return {
    path: license.path.slice(prefix.length),
    gitBlob: license.gitBlob,
    spdxId: sourceAvailable ? "LicenseRef-Anthropic-Source-Available" : "LicenseRef-Unclassified",
    status: "incompatible",
  };
}

/** Splits `SKILL.md` into its frontmatter block and its instruction body, digesting each. */
function parseSkill(folder: string, skillMd: string): {
  readonly name: string;
  readonly description: string;
  readonly frontmatterSha256: string;
  readonly bodySha256: string;
  readonly bodyBytes: number;
  readonly skillMdSha256: string;
} {
  const bytes = new TextEncoder().encode(skillMd);
  const parsed = parseDemo1UpstreamSkill(bytes);
  if (parsed.name !== folder) {
    throw new TypeError(`skill "${folder}" frontmatter name is "${parsed.name}"; it must match its folder`);
  }
  const frontmatter = bytes.slice(0, bytes.length - parsed.sourceMd.length);
  return {
    name: parsed.name,
    description: parsed.description,
    frontmatterSha256: sha256(frontmatter),
    bodySha256: sha256(parsed.sourceMd),
    bodyBytes: parsed.sourceMd.length,
    skillMdSha256: sha256(bytes),
  };
}

export function buildSkillsBenchUnit(input: SkillsBenchUnitBuildInput): SkillsBenchUnit {
  const task = input.task.name;
  assertMaterializable(input.entries, task);

  const networkMode = input.statement.frontmatter.networkMode;
  if (!(SKILLSBENCH_NETWORK_MODES as readonly string[]).includes(networkMode)) {
    throw new TypeError(`${task} declares an unknown network mode "${networkMode}"`);
  }

  const skillFolders = [...new Set(
    input.entries
      .filter((entry) => entry.path.startsWith("environment/skills/"))
      .map((entry) => entry.path.split("/")[2])
      .filter((folder): folder is string => folder !== undefined),
  )].sort(compareCodeUnitStrings);

  const declared = new Map(input.skills.map((skill) => [skill.folder, skill.skillMd]));
  for (const folder of skillFolders) {
    const hasSkillMd = input.entries.some(
      (entry) => entry.path === `environment/skills/${folder}/SKILL.md`,
    );
    if (!hasSkillMd) throw new TypeError(`${task} skill folder "${folder}" has no SKILL.md`);
    if (!declared.has(folder)) throw new TypeError(`${task} skill folder "${folder}" has no supplied SKILL.md bytes`);
  }
  if (skillFolders.length === 0) throw new TypeError(`${task} carries no curated skill bundle`);

  const skills: SkillsBenchSkill[] = skillFolders.map((folder) => {
    const prefix = `environment/skills/${folder}/`;
    const parsed = parseSkill(folder, declared.get(folder)!);
    const resources = byPath(
      input.entries
        .filter((entry) => entry.path.startsWith(prefix) && entry.path !== `${prefix}SKILL.md`)
        .map((entry) => ({
          path: entry.path.slice(prefix.length),
          mode: entry.mode,
          gitBlob: entry.gitBlob,
          bytes: entry.bytes,
          classification: classifySkillsBenchResource(entry.path.slice(prefix.length), entry.mode),
        })),
    );
    return {
      folder,
      name: parsed.name,
      description: parsed.description,
      skillMdPath: `${prefix}SKILL.md`,
      skillMdSha256: parsed.skillMdSha256,
      frontmatterSha256: parsed.frontmatterSha256,
      bodySha256: parsed.bodySha256,
      bodyBytes: parsed.bodyBytes,
      license: skillLicense(input.entries, folder),
      resources,
    };
  });

  const dockerfile = input.entries.find((entry) => entry.path === "environment/Dockerfile");
  if (dockerfile === undefined) throw new TypeError(`${task} has no environment/Dockerfile`);

  const reasons = skills
    .filter((skill) => skill.license?.status === "incompatible")
    .map((skill) => `skill-${skill.folder}-${skill.license!.spdxId === "LicenseRef-Anthropic-Source-Available" ? "source-available" : "unclassified"}`)
    .sort(compareCodeUnitStrings);

  return {
    schema: SKILLSBENCH_TASK_BUNDLE_UNIT_SCHEMA,
    source: {
      repositoryUrl: SKILLSBENCH_V1_1_SOURCE.repositoryUrl,
      releaseTag: SKILLSBENCH_V1_1_SOURCE.releaseTag,
      commit: SKILLSBENCH_V1_1_SOURCE.commit,
    },
    task: { ...input.task },
    statement: {
      path: input.statement.path,
      gitBlob: input.statement.gitBlob,
      bytes: input.statement.bytes,
      sha256: sha256(input.statement.body),
      frontmatter: {
        networkMode: networkMode as SkillsBenchNetworkMode,
        verifierType: input.statement.frontmatter.verifierType,
        agentTimeoutSec: input.statement.frontmatter.agentTimeoutSec,
        verifierTimeoutSec: input.statement.frontmatter.verifierTimeoutSec,
      },
    },
    environment: {
      dockerfile: { ...dockerfile },
      nonSkillFiles: byPath(
        input.entries.filter(
          (entry) => entry.path.startsWith("environment/")
            && entry.path !== "environment/Dockerfile"
            && !entry.path.startsWith("environment/skills/"),
        ).map((entry) => ({ ...entry })),
      ),
    },
    skills,
    oracle: byPath(input.entries.filter((entry) => entry.path.startsWith("oracle/")).map((entry) => ({ ...entry }))),
    verifier: byPath(input.entries.filter((entry) => entry.path.startsWith("verifier/")).map((entry) => ({ ...entry }))),
    license: {
      rootSpdxId: input.rootLicenseSpdxId,
      status: reasons.length === 0 ? "compatible" : "incompatible",
      reasons,
    },
  };
}

/**
 * Rebuilds every derived field from the unit's own identity fields. A unit carries enough to
 * recompute itself: the skill bodies are recoverable only by digest, so verification compares
 * structure and digests rather than re-parsing bytes it does not hold.
 */
export function verifySkillsBenchUnit(unit: SkillsBenchUnit): void {
  if (unit.schema !== SKILLSBENCH_TASK_BUNDLE_UNIT_SCHEMA) throw new TypeError("task-bundle unit schema mismatch");
  if (!SHA256.test(unit.task.packageDigest)) throw new TypeError("task package digest is malformed");
  const expected = {
    skills: unit.skills.map((skill) => ({ folder: skill.folder, resources: byPath(skill.resources) })),
    oracle: byPath(unit.oracle),
    verifier: byPath(unit.verifier),
    nonSkillFiles: byPath(unit.environment.nonSkillFiles),
    folders: [...unit.skills.map((skill) => skill.folder)].sort(compareCodeUnitStrings),
    license: {
      status: unit.skills.some((skill) => skill.license?.status === "incompatible") ? "incompatible" : "compatible",
      reasons: unit.skills
        .filter((skill) => skill.license?.status === "incompatible")
        .map((skill) => `skill-${skill.folder}-${skill.license!.spdxId === "LicenseRef-Anthropic-Source-Available" ? "source-available" : "unclassified"}`)
        .sort(compareCodeUnitStrings),
    },
  };
  const actual = {
    skills: unit.skills.map((skill) => ({ folder: skill.folder, resources: skill.resources })),
    oracle: unit.oracle,
    verifier: unit.verifier,
    nonSkillFiles: unit.environment.nonSkillFiles,
    folders: unit.skills.map((skill) => skill.folder),
    license: { status: unit.license.status, reasons: unit.license.reasons },
  };
  if (!canonicalEqual(expected, actual)) throw new TypeError("task-bundle unit fields do not recompute from canonical inputs");
  for (const skill of unit.skills) {
    for (const digest of [skill.skillMdSha256, skill.frontmatterSha256, skill.bodySha256]) {
      if (!SHA256.test(digest)) throw new TypeError(`${skill.folder} carries a malformed digest`);
    }
    if (skill.bodySha256 === skill.skillMdSha256) {
      throw new TypeError(`${skill.folder} body and SKILL.md digests are identical; frontmatter was not separated`);
    }
    for (const resource of skill.resources) {
      if (classifySkillsBenchResource(resource.path, resource.mode) !== resource.classification) {
        throw new TypeError(`${skill.folder}/${resource.path} classification does not recompute`);
      }
    }
  }
}

/**
 * Byte-level re-derivation against re-supplied source bytes.
 *
 * `verifySkillsBenchUnit` can only prove self-consistency: a manifest that carries digests but not
 * bytes cannot detect a substituted digest, because there is nothing to recompute it from. That is
 * inherent, so the byte check is a separate, explicitly-fed function rather than a promise the
 * self-verifier cannot keep. This is the function the inventory freeze and the arm-B body-identity
 * proof call, and it is what makes "byte-identical to its authenticated upstream body"
 * independently checkable rather than asserted.
 */
export function verifySkillsBenchUnitBodies(
  unit: SkillsBenchUnit,
  supplied: readonly { readonly folder: string; readonly skillMd: string }[],
): void {
  const bySkill = new Map(supplied.map((skill) => [skill.folder, skill.skillMd]));
  for (const skill of unit.skills) {
    const skillMd = bySkill.get(skill.folder);
    if (skillMd === undefined) throw new TypeError(`${skill.folder} has no supplied SKILL.md bytes to verify against`);
    const parsed = parseSkill(skill.folder, skillMd);
    if (parsed.skillMdSha256 !== skill.skillMdSha256
      || parsed.frontmatterSha256 !== skill.frontmatterSha256
      || parsed.bodySha256 !== skill.bodySha256
      || parsed.bodyBytes !== skill.bodyBytes
      || parsed.name !== skill.name
      || parsed.description !== skill.description) {
      throw new TypeError(`${skill.folder} digests do not recompute from the supplied SKILL.md bytes`);
    }
  }
  const declared = new Set(unit.skills.map((skill) => skill.folder));
  for (const skill of supplied) {
    if (!declared.has(skill.folder)) throw new TypeError(`supplied skill "${skill.folder}" is not in the unit`);
  }
}

export function canonicalSkillsBenchUnitBytes(unit: SkillsBenchUnit): Uint8Array {
  verifySkillsBenchUnit(unit);
  return canonicalBytes(unit);
}

export function skillsBenchUnitDigest(unit: SkillsBenchUnit): string {
  return `sha256:${sha256(canonicalSkillsBenchUnitBytes(unit))}`;
}
