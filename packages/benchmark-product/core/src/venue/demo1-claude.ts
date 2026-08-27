import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { inheritedTempEnv } from "../runtime/child-temp-env.js";

export const DEMO1_CLAUDE_MODEL_ID = "claude-haiku-4-5-20251001";
export const DEMO1_CLAUDE_EFFORT = "high";
export const DEMO1_CLAUDE_HARNESS_ID = "claude-code";
export const DEMO1_SKILL_LOADOUT_NAME = "SKILL.md";
export const DEMO1_CLAUDE_MD_LOADOUT_NAME = "CLAUDE.md";
export const DEMO1_SKILL_PLUGIN_DIRECTORY = ".jinn-demo1-skill-plugin";
export const DEMO1_SKILL_PATH = `${DEMO1_SKILL_PLUGIN_DIRECTORY}/skills/demo1/SKILL.md`;
export const DEMO1_SKILL_PLUGIN_MANIFEST_PATH = `${DEMO1_SKILL_PLUGIN_DIRECTORY}/.claude-plugin/plugin.json`;
export const DEMO1_CLAUDE_MD_PATH = "CLAUDE.md";
export const DEMO1_CLAUDE_OAUTH_GRANT_KEY = "demo1-claude-oauth-token";
export const DEMO1_CLAUDE_OAUTH_SECRET_TARGET = "demo1-claude-oauth-token";
export const DEMO1_CLAUDE_OAUTH_FILE_ENV = "JINN_CLAUDE_OAUTH_TOKEN_FILE";
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
  readonly claudeExecutable: { readonly path: string; readonly digest: string };
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
  options?: { readonly env?: Readonly<Record<string, string>> },
) => Promise<{ readonly stdout: string; readonly stderr?: string }>;

export interface Demo1ClaudeOAuthCredentialOptions {
  /** Existing operator-owned `claude setup-token` file. Its bytes are never sealed or logged. */
  readonly tokenFilePath: string;
  /** New run-owned path for the deterministic, digest-pinned credential wrapper. */
  readonly wrapperPath: string;
}

export interface Demo1ClaudeRuntimeOptions {
  readonly executablePath: string;
  readonly harnessVersion: string;
  readonly artifacts: Demo1InstructionArtifacts;
  readonly oauthCredential?: Demo1ClaudeOAuthCredentialOptions;
  /** Test seam only. Production uses execFile without a shell. */
  readonly command?: Demo1ClaudeCommand;
}

export interface Demo1ClaudeRuntimeBinding {
  readonly executable: { readonly path: string; readonly digest: string };
  readonly claudeExecutable: { readonly path: string; readonly digest: string };
  readonly harnessVersion: string;
  readonly modelId: string;
  readonly effort: "low" | "medium" | "high" | "xhigh" | "max";
  readonly artifacts: Demo1InstructionArtifacts;
  readonly credential?: {
    readonly capabilityGrants: Readonly<Record<string, unknown>>;
    readonly secretForward: { readonly grantKey: string; readonly target: string };
    resolve(input: { readonly grantKey: string; readonly descriptor: unknown }): Promise<Uint8Array>;
  };
  probe(): Promise<Demo1ClaudeReadiness>;
}

export interface Demo1ClaudeCandidateRuntimeOptions extends Demo1ClaudeRuntimeOptions {
  readonly candidateIndex: number;
}

export interface Demo1ClaudeSelectedRuntimeOptions extends Demo1ClaudeRuntimeOptions {
  readonly selection: Demo1RuntimeSelection;
  readonly decision: Demo1RuntimePolicyDecision;
}

function defaultCommand(
  executablePath: string,
  args: readonly string[],
  options?: { readonly env?: Readonly<Record<string, string>> },
) {
  return execFileAsync(executablePath, [...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    ...(options?.env === undefined ? {} : { env: { ...options.env } }),
  });
}

function assertSecureTokenFile(path: string): void {
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error("Claude OAuth token source must be a regular non-symlink file");
  }
  if ((entry.mode & 0o777) !== 0o600) {
    throw new Error("Claude OAuth token source must have mode 0600");
  }
  if (typeof process.getuid === "function" && entry.uid !== process.getuid()) {
    throw new Error("Claude OAuth token source must be owned by the current operator");
  }
  const bytes = readFileSync(path);
  const usable = bytes.length > 0 && bytes.some((byte) => byte > 0x20);
  bytes.fill(0);
  if (!usable) {
    throw new Error("Claude OAuth token source is empty");
  }
}

function credentialWrapperSource(claudeExecutable: { readonly path: string; readonly digest: string }): string {
  return `#!${process.execPath}
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";

const CLAUDE = ${JSON.stringify(claudeExecutable.path)};
const EXPECTED = ${JSON.stringify(claudeExecutable.digest)};
const TOKEN_FILE_ENV = ${JSON.stringify(DEMO1_CLAUDE_OAUTH_FILE_ENV)};
const actual = createHash("sha256").update(readFileSync(CLAUDE)).digest("hex");
if (actual !== EXPECTED) throw new Error("bound Claude executable digest changed");
const tokenPath = process.env[TOKEN_FILE_ENV];
if (tokenPath === undefined || tokenPath.length === 0) throw new Error("Claude OAuth token file is absent");
const entry = lstatSync(tokenPath);
if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o777) !== 0o600) {
  throw new Error("Claude OAuth token file is not a non-symlink 0600 file");
}
const tokenBytes = readFileSync(tokenPath);
let token;
try {
  token = new TextDecoder("utf-8", { fatal: true }).decode(tokenBytes).trim();
} finally {
  tokenBytes.fill(0);
}
if (token.length === 0 || /\\s/u.test(token)) throw new Error("Claude OAuth token is malformed");
const env = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token, CLAUDE_FORCE_OAUTH: "1" };
delete env[TOKEN_FILE_ENV];
delete env.ANTHROPIC_API_KEY;
delete env.ANTHROPIC_AUTH_TOKEN;
delete env.ANTHROPIC_BASE_URL;
delete env.ANTHROPIC_MODEL;
const result = spawnSync(CLAUDE, process.argv.slice(2), { env, stdio: "inherit" });
env.CLAUDE_CODE_OAUTH_TOKEN = "";
token = "";
if (result.error !== undefined) throw result.error;
if (result.signal !== null) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
`;
}

function selectedRuntimeExecutableDigest(options: Demo1ClaudeRuntimeOptions): string {
  const claudeExecutable = {
    path: options.executablePath,
    digest: sha256(readFileSync(options.executablePath)),
  };
  return options.oauthCredential === undefined
    ? claudeExecutable.digest
    : sha256(Buffer.from(credentialWrapperSource(claudeExecutable), "utf8"));
}

function materializeCredentialWrapper(
  path: string,
  claudeExecutable: { readonly path: string; readonly digest: string },
): { readonly path: string; readonly digest: string } {
  const source = credentialWrapperSource(claudeExecutable);
  const expected = Buffer.from(source, "utf8");
  const verifyExisting = (): { readonly path: string; readonly digest: string } => {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error("existing Claude OAuth wrapper must be a regular non-symlink file");
    }
    if ((entry.mode & 0o777) !== 0o700) {
      throw new Error("existing Claude OAuth wrapper must have mode 0700");
    }
    if (typeof process.getuid === "function" && entry.uid !== process.getuid()) {
      throw new Error("existing Claude OAuth wrapper must be owned by the current operator");
    }
    const actual = readFileSync(path);
    if (!actual.equals(expected)) {
      throw new Error("existing Claude OAuth wrapper bytes do not match the bound runtime");
    }
    return { path, digest: sha256(actual) };
  };
  try {
    writeFileSync(path, expected, { mode: 0o700, flag: "wx" });
    chmodSync(path, 0o700);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    return verifyExisting();
  }
  return verifyExisting();
}

function readinessEnvironment(tokenFilePath: string, configDir: string): Record<string, string> {
  const environment: Record<string, string> = {
    [DEMO1_CLAUDE_OAUTH_FILE_ENV]: tokenFilePath,
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_FORCE_OAUTH: "1",
  };
  for (const key of ["HOME", "PATH", "LANG", "LC_ALL", "SHELL"] as const) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  // All three temp names rather than `TMPDIR` alone: the readiness probe runs the agent binary,
  // which is free to consult whichever its own runtime reads.
  return { ...environment, ...inheritedTempEnv() };
}

/** Product-owned, binary/auth/version readiness binding. No ambient executable-path discovery. */
function createRuntimeBinding(
  options: Demo1ClaudeRuntimeOptions,
  selected: { readonly model: string; readonly effort: Demo1ClaudeRuntimeBinding["effort"] },
): Demo1ClaudeRuntimeBinding {
  const claudeExecutable = {
    path: options.executablePath,
    digest: sha256(readFileSync(options.executablePath)),
  };
  const executable = options.oauthCredential === undefined
    ? claudeExecutable
    : materializeCredentialWrapper(options.oauthCredential.wrapperPath, claudeExecutable);
  if (options.oauthCredential !== undefined) assertSecureTokenFile(options.oauthCredential.tokenFilePath);
  const credentialDescriptor = Object.freeze({
    kind: "jinn.benchmark-product.demo1-claude-oauth/1",
  });
  const credential = options.oauthCredential === undefined
    ? undefined
    : {
      capabilityGrants: Object.freeze({
        [DEMO1_CLAUDE_OAUTH_GRANT_KEY]: credentialDescriptor,
      }) as Readonly<Record<string, unknown>>,
      secretForward: Object.freeze({
        grantKey: DEMO1_CLAUDE_OAUTH_GRANT_KEY,
        target: DEMO1_CLAUDE_OAUTH_SECRET_TARGET,
      }),
      async resolve(input: { readonly grantKey: string; readonly descriptor: unknown }) {
        if (input.grantKey !== DEMO1_CLAUDE_OAUTH_GRANT_KEY
          || JSON.stringify(input.descriptor) !== JSON.stringify(credentialDescriptor)) {
          throw new Error("Claude OAuth capability grant does not match the bound descriptor");
        }
        assertSecureTokenFile(options.oauthCredential!.tokenFilePath);
        return new Uint8Array(readFileSync(options.oauthCredential!.tokenFilePath));
      },
    };
  const inventory = [options.artifacts.skill, options.artifacts.baseline].map((pin) => {
    const canonical = canonicalLoadoutPin(pin);
    return { kind: canonical.kind as "jinn.skill.v1", name: canonical.name, digest: canonical.digest };
  });
  const command = options.command ?? defaultCommand;
  return {
    executable,
    claudeExecutable,
    harnessVersion: options.harnessVersion,
    modelId: selected.model,
    effort: selected.effort,
    artifacts: options.artifacts,
    ...(credential === undefined ? {} : { credential }),
    async probe() {
      let observedVersion: string | undefined;
      const unavailable = (detail: string): Demo1ClaudeReadiness => ({
        ready: false,
        detail,
        executable,
        claudeExecutable,
        harnessVersions: observedVersion === undefined ? [] : [observedVersion],
        models: [selected.model],
        loadouts: inventory,
      });
      const configDir = options.oauthCredential === undefined
        ? undefined
        : mkdtempSync(join(tmpdir(), "demo1-claude-readiness-"));
      const commandOptions = options.oauthCredential === undefined
        ? undefined
        : { env: readinessEnvironment(options.oauthCredential.tokenFilePath, configDir!) };
      try {
        if (sha256(readFileSync(executable.path)) !== executable.digest) {
          return unavailable("claude-code executable digest changed after runtime binding");
        }
        if (sha256(readFileSync(claudeExecutable.path)) !== claudeExecutable.digest) {
          return unavailable("underlying claude-code executable digest changed after runtime binding");
        }
        const versionOutput = (await command(executable.path, [
          "--model", selected.model,
          "--effort", selected.effort,
          "--version",
        ], commandOptions)).stdout.trim();
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
        const auth = JSON.parse((await command(executable.path, ["auth", "status"], commandOptions)).stdout) as {
          readonly loggedIn?: unknown;
        };
        if (auth.loggedIn !== true) return unavailable("claude-code authentication is not ready");
        return {
          ready: true,
          executable,
          claudeExecutable,
          harnessVersions: [observedVersion],
          models: [selected.model],
          loadouts: inventory,
        };
      } catch (cause) {
        return unavailable(cause instanceof Error ? cause.message : "claude-code readiness probe failed");
      } finally {
        if (configDir !== undefined) rmSync(configDir, { recursive: true, force: true });
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
  const observedDigest = selectedRuntimeExecutableDigest(options);
  if (options.selection.harness.version !== options.harnessVersion
    || options.selection.harness.executableSha256 !== observedDigest
    || options.selection.skillSha256 !== options.artifacts.skill.digest.sha256) {
    throw new TypeError("selected runtime does not match the launched Claude Code runtime and skill identities");
  }
  const binding = createRuntimeBinding(options, options.selection.selected);
  if (binding.executable.digest !== observedDigest) {
    throw new TypeError("selected Claude Code runtime changed while it was being bound");
  }
  return binding;
}

function exactCapabilities(
  base: LauncherCapabilities,
  runtime: Demo1ClaudeRuntimeBinding,
): LauncherCapabilities {
  return {
    ...base,
    secretForwards: runtime.credential === undefined ? [] : [runtime.credential.secretForward],
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
      if (runtime.credential === undefined) return { ...planned, argv };
      return {
        ...planned,
        argv,
        env: {
          ...planned.env,
          [DEMO1_CLAUDE_OAUTH_FILE_ENV]: `secrets/${runtime.credential.secretForward.target}`,
        },
        secretForwards: [runtime.credential.secretForward],
      };
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
