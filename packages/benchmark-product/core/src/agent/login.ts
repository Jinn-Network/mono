import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { AgentProfile } from "./profile.js";
import { scopedTempEnv } from "../runtime/child-temp-env.js";
import { readRegularFileNoFollow } from "./safe-file.js";
import { observeAgentVersion } from "./version.js";
import {
  requireQualifiedHarnessLogin,
  storeQualifiedLoginArtifact,
  type CredentialGrant,
} from "./store.js";

export interface SubscriptionLoginInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly captureStdout: boolean;
}

export interface SubscriptionLoginResult {
  readonly status: number;
  readonly stdout: string;
}

export type SubscriptionLoginRunner = (invocation: SubscriptionLoginInvocation) => SubscriptionLoginResult;

const defaultRunner: SubscriptionLoginRunner = (invocation) => {
  const result = spawnSync(invocation.executable, [...invocation.args], {
    // temp-env: delegated to the caller. This runner builds no allowlist — it spawns exactly the
    // invocation it was handed, and `loginEnvironment` is where the temp names are pinned.
    env: invocation.env,
    encoding: "utf8",
    timeout: 10 * 60_000,
    maxBuffer: 1024 * 1024,
    stdio: invocation.captureStdout ? ["inherit", "pipe", "inherit"] : "inherit",
  });
  if (result.error !== undefined) throw new Error("subscription login could not start");
  if (result.signal !== null && result.signal !== undefined) throw new Error("subscription login was interrupted");
  return { status: result.status ?? 1, stdout: typeof result.stdout === "string" ? result.stdout : "" };
};

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("subscription login root must be a private directory");
}

function loginEnvironment(root: string): Record<string, string> {
  const home = join(root, "home");
  privateDirectory(home);
  return {
    // All three temp names, not the POSIX one alone: the children spawned with this allowlist are
    // Node CLIs today, but a child that consults the Windows names instead would fall back to the
    // platform default and write outside the root this function owns and its caller removes.
    ...scopedTempEnv(root),
    HOME: home,
    LANG: "C",
    LC_ALL: "C",
    PATH: process.env.PATH ?? "",
  };
}

function claudeToken(output: string): string {
  const matches = output.match(/sk-ant-[A-Za-z0-9_-]{20,}/gu) ?? [];
  if (matches.length !== 1) throw new Error("Claude setup-token did not return exactly one subscription token");
  return matches[0]!;
}

function validateCodexRuntimeDirectory(home: string, executable: string): void {
  const temporaryDirectory = join(home, "tmp");
  const temporaryStat = lstatSync(temporaryDirectory);
  if (!temporaryStat.isDirectory() || temporaryStat.isSymbolicLink()) {
    throw new Error("Codex device login temporary path is not a regular directory");
  }
  const temporaryEntries = readdirSync(temporaryDirectory).sort();
  if (temporaryEntries.length !== 1 || temporaryEntries[0] !== "arg0") {
    throw new Error("Codex device login wrote an unqualified temporary artifact");
  }
  const arg0Directory = join(temporaryDirectory, "arg0");
  const arg0Stat = lstatSync(arg0Directory);
  if (!arg0Stat.isDirectory() || arg0Stat.isSymbolicLink() || (arg0Stat.mode & 0o077) !== 0) {
    throw new Error("Codex device login arg0 path is not a private regular directory");
  }
  const sessions = readdirSync(arg0Directory).sort();
  if (sessions.length !== 1 || !/^codex-arg0[A-Za-z0-9_-]+$/u.test(sessions[0]!)) {
    throw new Error("Codex device login wrote an unqualified arg0 session");
  }
  const sessionDirectory = join(arg0Directory, sessions[0]!);
  const sessionStat = lstatSync(sessionDirectory);
  if (!sessionStat.isDirectory() || sessionStat.isSymbolicLink()) {
    throw new Error("Codex device login arg0 session is not a regular directory");
  }
  const expectedHelpers = [
    ".lock",
    "apply_patch",
    "applypatch",
    "codex-execve-wrapper",
    ...(process.platform === "linux" ? ["codex-linux-sandbox"] : []),
  ].sort();
  const helpers = readdirSync(sessionDirectory).sort();
  if (helpers.length !== expectedHelpers.length
    || helpers.some((entry, index) => entry !== expectedHelpers[index])) {
    throw new Error("Codex device login wrote an unqualified arg0 helper");
  }
  const lockStat = lstatSync(join(sessionDirectory, ".lock"));
  if (!lockStat.isFile() || lockStat.isSymbolicLink() || lockStat.size > 4_096) {
    throw new Error("Codex device login arg0 lock is not a bounded regular file");
  }
  const expectedExecutable = realpathSync(executable);
  for (const helper of expectedHelpers.filter((entry) => entry !== ".lock")) {
    const helperPath = join(sessionDirectory, helper);
    if (!lstatSync(helperPath).isSymbolicLink() || realpathSync(helperPath) !== expectedExecutable) {
      throw new Error("Codex device login arg0 helper does not resolve to the qualified executable");
    }
  }
}

function codexArtifact(home: string, executable: string): string {
  const entries = readdirSync(home).sort();
  if (entries.some((entry) => entry !== "auth.json" && entry !== "log" && entry !== "tmp")
    || !entries.includes("auth.json")) {
    throw new Error("Codex device login wrote an unqualified filesystem artifact");
  }
  if (entries.includes("log")) {
    const logDirectory = join(home, "log");
    const directoryStat = lstatSync(logDirectory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error("Codex device login log path is not a regular private directory");
    }
    const logEntries = readdirSync(logDirectory).sort();
    if (logEntries.length !== 1 || logEntries[0] !== "codex-login.log") {
      throw new Error("Codex device login wrote an unqualified log artifact");
    }
    const logStat = lstatSync(join(logDirectory, "codex-login.log"));
    if (!logStat.isFile() || logStat.isSymbolicLink() || logStat.size > 1_048_576) {
      throw new Error("Codex device login log is not a bounded regular file");
    }
  }
  if (entries.includes("tmp")) validateCodexRuntimeDirectory(home, executable);
  const artifact = join(home, "auth.json");
  const stat = lstatSync(artifact);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 2 || stat.size > 1_048_576) {
    throw new Error("Codex device login did not produce a bounded regular auth.json artifact");
  }
  try {
    const parsed = JSON.parse(readFileSync(artifact, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
  } catch {
    throw new Error("Codex device login produced invalid auth.json");
  }
  return artifact;
}

/** Interactive, subscription-only capture. It never inspects either harness's normal home. */
export function captureQualifiedSubscriptionLogin(
  dataDir: string,
  profile: AgentProfile,
  options: {
    readonly runner?: SubscriptionLoginRunner;
    readonly temporaryBase?: string;
    readonly validateExecutable?: (profile: AgentProfile) => void;
  } = {},
): CredentialGrant {
  const qualification = requireQualifiedHarnessLogin(profile);
  (options.validateExecutable ?? ((candidate) => {
    const digest = createHash("sha256").update(readRegularFileNoFollow(candidate.executable.path)).digest("hex");
    if (digest !== candidate.executable.sha256) throw new Error("subscription login executable digest differs from its qualified profile");
    if (observeAgentVersion(candidate) !== candidate.executable.version) throw new Error("subscription login executable version differs from its qualified profile");
  }))(profile);
  const root = mkdtempSync(join(options.temporaryBase ?? tmpdir(), "colophon-subscription-login-"));
  chmodSync(root, 0o700);
  const runner = options.runner ?? defaultRunner;
  try {
    const env = loginEnvironment(root);
    if (qualification.capture === "claude-setup-token") {
      const claudeHome = join(root, "claude-config");
      privateDirectory(claudeHome);
      const outcome = runner({
        executable: profile.executable.path,
        args: ["setup-token"],
        env: { ...env, CLAUDE_CONFIG_DIR: claudeHome },
        captureStdout: true,
      });
      if (outcome.status !== 0) throw new Error("Claude subscription login was not completed");
      const source = join(root, "claude-subscription-token");
      writeFileSync(source, claudeToken(outcome.stdout), { mode: 0o600, flag: "wx" });
      return storeQualifiedLoginArtifact(dataDir, profile, source);
    }

    const codexHome = join(root, "codex-home");
    privateDirectory(codexHome);
    const outcome = runner({
      executable: profile.executable.path,
      args: ["login", "--device-auth"],
      env: { ...env, CODEX_HOME: codexHome },
      captureStdout: false,
    });
    if (outcome.status !== 0) throw new Error("Codex subscription login was not completed");
    if (!existsSync(codexHome)) throw new Error("Codex subscription login did not create its isolated home");
    return storeQualifiedLoginArtifact(dataDir, profile, codexArtifact(codexHome, profile.executable.path));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
