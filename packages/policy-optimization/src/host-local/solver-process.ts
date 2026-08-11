#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { secureAtomicWrite } from "./state.js";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0 || value.includes("\u0000")) {
    throw new Error(`solver wrapper requires ${name}`);
  }
  return value;
}

async function exactSecret(source: string, target: string): Promise<void> {
  const input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes: Buffer | undefined;
  try {
    const stat = await input.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("solver auth forward is not a private regular file");
    bytes = await input.readFile();
  } finally {
    await input.close();
  }
  const output = await open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try { await output.writeFile(bytes); }
  finally {
    bytes.fill(0);
    await output.close();
  }
}

async function run(command: string, args: readonly string[], input: {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}): Promise<number> {
  const child = spawn(command, [...args], {
    cwd: input.cwd,
    env: { ...input.env },
    stdio: "inherit",
  });
  return new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(signal === null ? code ?? 70 : 70));
  });
}

async function output(command: string, args: readonly string[], cwd: string, path: string): Promise<Uint8Array> {
  const child = spawn(command, [...args], {
    cwd,
    env: { PATH: path, LC_ALL: "C", LANG: "C" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (value) => resolve(value ?? 70));
  });
  if (code !== 0) throw new Error(`solver wrapper helper exited ${code}`);
  return new Uint8Array(Buffer.concat(chunks));
}

async function main(): Promise<number> {
  const harness = required("JINN_SOLVER_HARNESS");
  if (harness !== "codex") throw new Error("unsupported solver harness");
  const executable = required("JINN_SOLVER_EXECUTABLE");
  const model = required("JINN_SOLVER_MODEL");
  const loadout = required("JINN_SOLVER_LOADOUT");
  const loadoutDigest = required("JINN_SOLVER_LOADOUT_DIGEST");
  const inputRoot = required("JINN_ATTEMPT_INPUT");
  const work = required("JINN_ATTEMPT_WORK");
  const out = required("JINN_ATTEMPT_OUT");
  const harnessState = required("JINN_ATTEMPT_HARNESS_STATE");
  const authSource = required("JINN_SOLVER_AUTH_FILE");
  const path = required("JINN_SOLVER_PATH");
  const authTarget = join(harnessState, "auth.json");
  await mkdir(harnessState, { recursive: true, mode: 0o700 });
  await exactSecret(authSource, authTarget);
  try {
    const taskValue = JSON.parse(await readFile(join(inputRoot, "task.sealed"), "utf8")) as {
      readonly instructions?: unknown;
    };
    if (typeof taskValue.instructions !== "string" || taskValue.instructions.length === 0) {
      throw new Error("prepared Task has no solver instructions");
    }
    const prompt = [
      "Solve the exact repository task supplied by the host.",
      `Before editing, read the public policy loadout at ${loadout}.`,
      `That directory is the exact loadout ${loadoutDigest}; follow its relevant skills, notes, and policy.json.`,
      "Work only in the current repository. Make the smallest correct code change and run focused checks.",
      "Do not read credentials or paths outside the current repository, the supplied loadout, and ordinary toolchain files.",
      "The host will capture the git diff; do not commit, push, or contact external services except those required by the coding harness.",
      "",
      "Task:",
      taskValue.instructions,
    ].join("\n");
    const code = await run(executable, [
      "exec", "--json", "--ignore-user-config", "--disable", "plugins",
      "--sandbox", "danger-full-access", "--dangerously-bypass-approvals-and-sandbox",
      "-C", work, "-m", model, prompt,
    ], {
      cwd: work,
      env: {
        CODEX_HOME: harnessState,
        HOME: harnessState,
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        PATH: path,
        TMPDIR: required("TMPDIR"),
      },
    });
    if (code !== 0) return code;
    await output("git", ["add", "-N", "--", "."], work, path);
    const patch = await output("git", [
      "diff", "--binary", "--full-index", "--no-ext-diff", "HEAD", "--",
    ], work, path);
    secureAtomicWrite(join(out, "patch"), patch, true);
    return 0;
  } finally {
    await rm(authTarget, { force: true });
  }
}

try {
  process.exitCode = await main();
} catch {
  process.exitCode = 70;
}
