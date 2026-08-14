import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { AgentProfile } from "./profile.js";
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
    HOME: home,
    LANG: "C",
    LC_ALL: "C",
    PATH: process.env.PATH ?? "",
    TMPDIR: root,
  };
}

function claudeToken(output: string): string {
  const matches = output.match(/sk-ant-[A-Za-z0-9_-]{20,}/gu) ?? [];
  if (matches.length !== 1) throw new Error("Claude setup-token did not return exactly one subscription token");
  return matches[0]!;
}

function codexArtifact(home: string): string {
  const entries = readdirSync(home).sort();
  if (entries.length !== 1 || entries[0] !== "auth.json") {
    throw new Error("Codex device login wrote files other than the qualified auth.json artifact");
  }
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
    return storeQualifiedLoginArtifact(dataDir, profile, codexArtifact(codexHome));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
