import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import type {
  LauncherCapabilities,
  LauncherContract,
  LaunchPlan,
  ProbeResult,
} from "@jinn-network/task-execution-launchers";
import { makeClaudeCodeLauncher } from "@jinn-network/task-execution-launchers";
import {
  canonicalLoadoutPin,
  type TaskView,
  type WorkspacePaths,
} from "@jinn-network/task-execution-workspace";
import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
import {
  DEMO1_RUNTIME_CANDIDATES,
  verifyDemo1RuntimeSelection,
  type Demo1RuntimePolicyDecision,
  type Demo1RuntimeSelection,
} from "../method/demo1-runtime-policy.js";

export const DEMO1_CLAUDE_MODEL_ID = "claude-haiku-4-5-20251001";
export const DEMO1_CLAUDE_EFFORT = "high";
export const DEMO1_CLAUDE_HARNESS_ID = "claude-code";
export const DEMO1_SKILL_LOADOUT_NAME = "SKILL.md";
export const DEMO1_CLAUDE_MD_LOADOUT_NAME = "CLAUDE.md";
export const DEMO1_SKILL_PLUGIN_DIRECTORY = ".jinn-demo1-skill-plugin";
export const DEMO1_SKILL_PATH = `${DEMO1_SKILL_PLUGIN_DIRECTORY}/skills/demo1/SKILL.md`;
export const DEMO1_SKILL_PLUGIN_MANIFEST_PATH = `${DEMO1_SKILL_PLUGIN_DIRECTORY}/.claude-plugin/plugin.json`;
export const DEMO1_CLAUDE_MD_PATH = "CLAUDE.md";
export const DEMO1_EXPERIMENT_PATHS = [
  DEMO1_SKILL_PLUGIN_DIRECTORY,
  DEMO1_CLAUDE_MD_PATH,
] as const;

const execFileAsync = promisify(execFile);
const CLAUDE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/u;
const CLAUDE_VERSION_OUTPUT = /^([0-9]+\.[0-9]+\.[0-9]+) \(Claude Code\)$/u;

export interface Demo1SkillFrontmatter {
  readonly name: string;
  readonly description: string;
}

export interface Demo1LoadoutPin {
  readonly kind: "jinn.skill.v1";
  readonly name: string;
  readonly digest: { readonly sha256: string };
  readonly content: string;
}

export interface Demo1InstructionArtifacts {
  readonly sourceMd: Uint8Array;
  readonly skillMd: Uint8Array;
  readonly claudeMd: Uint8Array;
  readonly skillFrontmatter: Uint8Array;
  readonly skill: Demo1LoadoutPin;
  readonly baseline: Demo1LoadoutPin;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function oneLine(value: string, field: string): string {
  if (value.length === 0 || /[\r\n\u0000]/u.test(value)) {
    throw new TypeError(`${field} must be one non-empty line`);
  }
  return value;
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

/**
 * The committed transform for Demo-1. `sourceMd` is the literal frozen source.md byte stream:
 * CLAUDE.md is exactly that stream, while SKILL.md is deterministic frontmatter followed by the
 * same stream without any decoding, newline normalization, or re-encoding of its body.
 */
export function generateDemo1InstructionArtifacts(
  sourceMd: Uint8Array,
  frontmatter: Demo1SkillFrontmatter,
): Demo1InstructionArtifacts {
  const name = oneLine(frontmatter.name, "skill frontmatter name");
  const description = oneLine(frontmatter.description, "skill frontmatter description");
  const frontmatterBytes = new TextEncoder().encode(
    `---\nname: ${yamlScalar(name)}\ndescription: ${yamlScalar(description)}\n---\n\n`,
  );
  const skillMd = new Uint8Array(frontmatterBytes.length + sourceMd.length);
  skillMd.set(frontmatterBytes, 0);
  skillMd.set(sourceMd, frontmatterBytes.length);
  const claudeMd = sourceMd.slice();
  const pin = (name: string, bytes: Uint8Array): Demo1LoadoutPin => ({
    kind: "jinn.skill.v1",
    name,
    digest: { sha256: sha256(bytes) },
    content: Buffer.from(bytes).toString("base64"),
  });
  return {
    sourceMd: sourceMd.slice(),
    skillMd,
    claudeMd,
    skillFrontmatter: frontmatterBytes,
    skill: pin(DEMO1_SKILL_LOADOUT_NAME, skillMd),
    baseline: pin(DEMO1_CLAUDE_MD_LOADOUT_NAME, claudeMd),
  };
}

export interface Demo1ClaudeReadiness {
  readonly ready: boolean;
  readonly detail?: string;
  readonly executable: { readonly path: string; readonly digest: string };
  readonly harnessVersions: readonly string[];
  readonly models: readonly string[];
  readonly loadouts: readonly {
    readonly kind: "jinn.skill.v1";
    readonly name: string;
    readonly digest: string;
  }[];
}

export type Demo1ClaudeCommand = (
  executablePath: string,
  args: readonly string[],
) => Promise<{ readonly stdout: string; readonly stderr?: string }>;

export interface Demo1ClaudeRuntimeOptions {
  readonly executablePath: string;
  readonly harnessVersion: string;
  readonly artifacts: Demo1InstructionArtifacts;
  /** Test seam only. Production uses execFile without a shell. */
  readonly command?: Demo1ClaudeCommand;
}

export interface Demo1ClaudeRuntimeBinding {
  readonly executable: { readonly path: string; readonly digest: string };
  readonly harnessVersion: string;
  readonly modelId: string;
  readonly effort: "low" | "medium" | "high" | "xhigh" | "max";
  readonly artifacts: Demo1InstructionArtifacts;
  probe(): Promise<Demo1ClaudeReadiness>;
}

export interface Demo1ClaudeCandidateRuntimeOptions extends Demo1ClaudeRuntimeOptions {
  readonly candidateIndex: number;
}

export interface Demo1ClaudeSelectedRuntimeOptions extends Demo1ClaudeRuntimeOptions {
  readonly selection: Demo1RuntimeSelection;
  readonly decision: Demo1RuntimePolicyDecision;
}

function defaultCommand(executablePath: string, args: readonly string[]) {
  return execFileAsync(executablePath, [...args], { encoding: "utf8", maxBuffer: 1024 * 1024 });
}

/** Product-owned, binary/auth/version readiness binding. No ambient executable-path discovery. */
function createRuntimeBinding(
  options: Demo1ClaudeRuntimeOptions,
  selected: { readonly model: string; readonly effort: Demo1ClaudeRuntimeBinding["effort"] },
): Demo1ClaudeRuntimeBinding {
  const executable = {
    path: options.executablePath,
    digest: sha256(readFileSync(options.executablePath)),
  };
  const inventory = [options.artifacts.skill, options.artifacts.baseline].map((pin) => {
    const canonical = canonicalLoadoutPin(pin);
    return { kind: canonical.kind as "jinn.skill.v1", name: canonical.name, digest: canonical.digest };
  });
  const command = options.command ?? defaultCommand;
  return {
    executable,
    harnessVersion: options.harnessVersion,
    modelId: selected.model,
    effort: selected.effort,
    artifacts: options.artifacts,
    async probe() {
      let observedVersion: string | undefined;
      const unavailable = (detail: string): Demo1ClaudeReadiness => ({
        ready: false,
        detail,
        executable,
        harnessVersions: observedVersion === undefined ? [] : [observedVersion],
        models: [selected.model],
        loadouts: inventory,
      });
      try {
        if (sha256(readFileSync(executable.path)) !== executable.digest) {
          return unavailable("claude-code executable digest changed after runtime binding");
        }
        const versionOutput = (await command(executable.path, [
          "--model", selected.model,
          "--effort", selected.effort,
          "--version",
        ])).stdout.trim();
        const parsed = CLAUDE_VERSION_OUTPUT.exec(versionOutput);
        if (parsed === null) {
          return unavailable(`claude-code emitted malformed version output: ${versionOutput || "<empty>"}`);
        }
        observedVersion = parsed[1]!;
        if (!CLAUDE_VERSION.test(options.harnessVersion) || observedVersion !== options.harnessVersion) {
          return unavailable(
            `claude-code version mismatch: expected ${options.harnessVersion || "<empty>"}, observed ${observedVersion}`,
          );
        }
        const auth = JSON.parse((await command(executable.path, ["auth", "status"])).stdout) as {
          readonly loggedIn?: unknown;
        };
        if (auth.loggedIn !== true) return unavailable("claude-code authentication is not ready");
        return {
          ready: true,
          executable,
          harnessVersions: [observedVersion],
          models: [selected.model],
          loadouts: inventory,
        };
      } catch (cause) {
        return unavailable(cause instanceof Error ? cause.message : "claude-code readiness probe failed");
      }
    },
  };
}

/** Historical v1 binding. Its accepted Haiku/high pins remain unchanged. */
export function createDemo1ClaudeRuntimeBinding(
  options: Demo1ClaudeRuntimeOptions,
): Demo1ClaudeRuntimeBinding {
  return createRuntimeBinding(options, {
    model: DEMO1_CLAUDE_MODEL_ID,
    effort: DEMO1_CLAUDE_EFFORT,
  });
}

/** Candidate-only v2 binding for the paid suitability phase; it is not an official freeze. */
export function createDemo1ClaudeCandidateRuntimeBinding(
  options: Demo1ClaudeCandidateRuntimeOptions,
): Demo1ClaudeRuntimeBinding {
  if (!Number.isSafeInteger(options.candidateIndex) || options.candidateIndex < 0
    || options.candidateIndex >= DEMO1_RUNTIME_CANDIDATES.length) {
    throw new TypeError("candidateIndex is outside the frozen runtime ladder");
  }
  return createRuntimeBinding(options, DEMO1_RUNTIME_CANDIDATES[options.candidateIndex]!);
}

/** Official v2 binding: the observed executable and selected policy bytes must match exactly. */
export function createDemo1ClaudeSelectedRuntimeBinding(
  options: Demo1ClaudeSelectedRuntimeOptions,
): Demo1ClaudeRuntimeBinding {
  verifyDemo1RuntimeSelection(options.selection, options.decision);
  const observedDigest = sha256(readFileSync(options.executablePath));
  if (options.selection.harness.version !== options.harnessVersion
    || options.selection.harness.executableSha256 !== observedDigest
    || options.selection.skillSha256 !== options.artifacts.skill.digest.sha256) {
    throw new TypeError("selected runtime does not match the observed Claude Code executable and skill identities");
  }
  return createRuntimeBinding(options, options.selection.selected);
}

function exactCapabilities(base: LauncherCapabilities, runtime: Demo1ClaudeRuntimeBinding): LauncherCapabilities {
  return {
    ...base,
    runPinning: {
      keys: base.runPinning.keys.map((support) => {
        if (support.key === "effort") return { ...support, inventory: [runtime.effort] };
        if (support.key === "model") return { ...support, inventory: [runtime.modelId] };
        if (support.key === "loadout") return { ...support, inventory: ["jinn.skill.v1"] };
        return support;
      }),
    },
  };
}

function removePluginArgument(argv: readonly string[]): string[] {
  const output: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--plugin-dir") {
      index += 1;
      continue;
    }
    output.push(argv[index]!);
  }
  return output;
}

/** Product wrapper: native skill plugin for A, native root CLAUDE.md discovery for B, no file C. */
export function makeDemo1ClaudeLauncher(runtime: Demo1ClaudeRuntimeBinding): LauncherContract {
  const platform = makeClaudeCodeLauncher({
    probe: async (): Promise<ProbeResult> => {
      const readiness = await runtime.probe();
      return readiness.ready ? { ready: true } : { ready: false, detail: readiness.detail };
    },
  });
  return {
    id: platform.id,
    capabilities: () => exactCapabilities(platform.capabilities(), runtime),
    probe: platform.probe,
    plan(view: TaskView, paths: WorkspacePaths, attempt: AttemptIdentity): LaunchPlan {
      const planned = platform.plan(view, paths, attempt);
      let argv = removePluginArgument(planned.argv);
      const loadout = (view.effectiveRequirements as Record<string, unknown>).loadout;
      if (loadout !== undefined) {
        const pin = canonicalLoadoutPin(loadout);
        if (pin.name === DEMO1_SKILL_LOADOUT_NAME) {
          argv.push("--plugin-dir", `${paths.work}/${DEMO1_SKILL_PLUGIN_DIRECTORY}`);
        } else if (pin.name !== DEMO1_CLAUDE_MD_LOADOUT_NAME) {
          throw new Error(`demo1 claude-code launcher refuses unknown loadout ${pin.name}`);
        }
      }
      argv = [runtime.executable.path, ...argv.slice(1)];
      return { ...planned, argv };
    },
  };
}

export type Demo1ClaudeArm = "skill" | "claude-md" | "no-file";

export function demo1ClaudeArmRequirements(
  runtime: Demo1ClaudeRuntimeBinding,
  arm: Demo1ClaudeArm,
): Readonly<Record<string, unknown>> {
  return {
    harness: {
      id: DEMO1_CLAUDE_HARNESS_ID,
      version: runtime.harnessVersion,
      digest: runtime.executable.digest,
    },
    model: { id: runtime.modelId },
    effort: runtime.effort,
    isolationPolicy: "unrestricted",
    ...(arm === "no-file"
      ? {}
      : { loadout: arm === "skill" ? runtime.artifacts.skill : runtime.artifacts.baseline }),
  };
}
