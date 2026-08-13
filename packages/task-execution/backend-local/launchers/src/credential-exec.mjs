// SPDX-License-Identifier: Apache-2.0

/**
 * Exec-time credential bridge shared by the real CLI launchers.
 *
 * The launch plan only contains `secrets/<basename>` references. This process resolves those
 * references immediately before spawning the harness, removes its control variables, and never
 * writes or logs credential bytes. Codex's login artifact goes under TMPDIR, which the workspace
 * removes at attempt completion.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const SECRET_REFERENCE = /^secrets\/([A-Za-z0-9._-]+)$/u;
const CONTROL_KEYS = ["JINN_CODEX_AUTH_JSON", "JINN_ATTEMPT_SECRETS"];
const FORWARDED_ENV = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];

function readSecretBytes(reference, secretsRoot) {
  const matched = SECRET_REFERENCE.exec(reference);
  const root = realpathSync(secretsRoot);
  const path = matched === null
    ? (isAbsolute(reference) ? resolve(reference) : "")
    : resolve(root, matched[1]);
  const name = basename(path);
  if (
    path.length === 0
    || name === "."
    || name === ".."
    || !/^[A-Za-z0-9._-]+$/u.test(name)
    || dirname(path) !== root
  ) throw new Error("secret reference escapes secrets root");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > 1_048_576) throw new Error("invalid secret file");
    return Buffer.from(readFileSync(fd));
  } finally {
    closeSync(fd);
  }
}

function secretText(reference, secretsRoot) {
  // Forward text secrets as a value; strip exactly one file line ending, never interior space.
  const bytes = readSecretBytes(reference, secretsRoot);
  try {
    const text = bytes.toString("utf8").replace(/\r?\n$/u, "");
    if (text.length === 0) throw new Error("credential file is empty");
    return text;
  } finally {
    bytes.fill(0);
  }
}

function verifyExecutable(path, expectedDigest) {
  if (expectedDigest === undefined) return;
  if (!/^[a-f0-9]{64}$/u.test(expectedDigest) || !isAbsolute(path)) throw new Error("invalid executable identity");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("invalid executable identity");
    const actual = createHash("sha256").update(readFileSync(fd)).digest("hex");
    if (actual !== expectedDigest) throw new Error("executable identity changed before spawn");
  } finally {
    closeSync(fd);
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function childArgs() {
  const marker = process.argv.indexOf("--");
  const args = marker < 0 ? [] : process.argv.slice(marker + 1);
  if (args.length === 0) throw new Error("child command is required");
  return args;
}

function main() {
  const args = childArgs();
  const secretsRoot = requiredEnv("JINN_ATTEMPT_SECRETS");
  const env = { ...process.env };
  for (const key of FORWARDED_ENV) {
    const value = env[key];
    if (value !== undefined) env[key] = secretText(value, secretsRoot);
  }

  let codexState;
  const codexArtifact = env.JINN_CODEX_AUTH_JSON;
  if (codexArtifact !== undefined) {
    const tmp = requiredEnv("TMPDIR");
    codexState = join(tmp, "jinn-codex-local-login");
    // Fresh per-attempt state; never copy the normal host CODEX_HOME.
    rmSync(codexState, { recursive: true, force: true });
    mkdirSync(codexState, { recursive: true, mode: 0o700 });
    chmodSync(codexState, 0o700);
    const artifact = readSecretBytes(codexArtifact, secretsRoot);
    try {
      writeFileSync(join(codexState, "auth.json"), artifact, { mode: 0o600 });
    } finally {
      artifact.fill(0);
    }
    chmodSync(join(codexState, "auth.json"), 0o600);
    env.CODEX_HOME = codexState;
  }
  for (const key of CONTROL_KEYS) delete env[key];

  // This is the last portable check before spawn. Atomic path-to-exec binding would require a
  // platform-specific fd-exec primitive; the local backend therefore still treats a concurrent
  // replacement in the final read/spawn interval as a residual host-filesystem race.
  verifyExecutable(args[0], env.JINN_HARNESS_PIN_DIGEST);
  const child = spawn(args[0], args.slice(1), { cwd: process.cwd(), env, stdio: "inherit" });
  let forwardedSignal;
  const forward = (signal) => {
    if (forwardedSignal === undefined) {
      forwardedSignal = signal;
      child.kill(signal);
    }
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]) process.on(signal, () => forward(signal));
  child.once("error", () => finish(1));
  child.once("exit", (code, signal) => finish(code ?? 1, signal ?? forwardedSignal));

  function finish(code, signal) {
    if (codexState !== undefined) rmSync(codexState, { recursive: true, force: true });
    if (signal !== undefined) {
      for (const value of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]) process.removeAllListeners(value);
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code);
  }
}

try {
  main();
} catch {
  // Generic by design: filesystem errors can contain host paths; credentials must never be logged.
  process.stderr.write("credential-exec: credential setup failed\n");
  process.exit(126);
}
