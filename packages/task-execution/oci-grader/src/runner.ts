// SPDX-License-Identifier: Apache-2.0

import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, accessSync, realpathSync } from "node:fs";
import { deadlineExceeded, refuse, unavailable } from "./errors.js";
import {
  buildPinnedOciInvocation,
  PINNED_IMAGE,
  type HostNumericIdentity,
  type PinnedOciGraderInput,
} from "./invocation.js";
import { secureRead } from "./private-fs.js";

/** The minimal live-child surface this runner drives; `ChildProcess` satisfies it structurally. */
export interface GraderChildProcess {
  readonly pid?: number;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal: NodeJS.Signals): boolean;
}

/** Injected process launcher. Default spawns the real runtime CLI, shell-free. */
export type GraderProcessSpawner = (
  command: string,
  args: readonly string[],
) => GraderChildProcess;

export interface PinnedOciRunnerOptions {
  readonly spawn?: GraderProcessSpawner;
  /** Absolute path to the runtime CLI when it is not on the daemon's inherited PATH. */
  readonly dockerPath?: string;
}

const RUNTIME_CANDIDATES: Readonly<Record<"docker" | "podman", readonly string[]>> = {
  docker: [
    "/usr/local/bin/docker",
    "/opt/homebrew/bin/docker",
    "/usr/bin/docker",
    "/Applications/Docker.app/Contents/Resources/bin/docker",
  ],
  podman: ["/usr/local/bin/podman", "/opt/homebrew/bin/podman", "/usr/bin/podman"],
};

function runtimeExecutable(runtime: "docker" | "podman", override?: string): string {
  if (override !== undefined) return override;
  for (const candidate of RUNTIME_CANDIDATES[runtime]) {
    try {
      const exact = realpathSync(candidate);
      accessSync(exact, constants.X_OK);
      return exact;
    } catch {
      // Try the next host-owned installation root; never consult task material.
    }
  }
  return runtime;
}

function defaultSpawn(command: string, args: readonly string[]): GraderChildProcess {
  return nodeSpawn(command, [...args], {
    stdio: "ignore",
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
  }) as GraderChildProcess;
}

function currentHostIdentity(): HostNumericIdentity {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    unavailable("numeric host identity is unavailable for ownership-safe grading");
  }
  return { uid: process.getuid(), gid: process.getgid() };
}

async function boundedExit(input: {
  readonly runtime: "docker" | "podman";
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly options: PinnedOciRunnerOptions;
}): Promise<{ readonly code: number | null; readonly timedOut: boolean }> {
  const spawn = input.options.spawn ?? defaultSpawn;
  const executable = input.options.spawn === undefined
    ? runtimeExecutable(input.runtime, input.options.dockerPath)
    : input.runtime;
  let child: GraderChildProcess;
  try {
    child = spawn(executable, input.args);
  } catch (cause) {
    unavailable("grader runtime is unavailable", cause);
  }
  return new Promise<{ code: number | null; timedOut: boolean }>((resolveExit, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, input.timeoutMs);
    timer.unref?.();
    child.on("error", (cause) => { clearTimeout(timer); reject(cause); });
    child.on("exit", (code) => { clearTimeout(timer); resolveExit({ code, timedOut }); });
  }).catch((cause: unknown) => unavailable("grader runtime is unavailable", cause));
}

/** Fetches only an exact digest and positively re-inspects it before any grading may begin. */
export async function ensurePinnedOciImage(
  input: {
    readonly runtime: "docker" | "podman";
    readonly image: string;
    readonly platform: "linux/amd64" | "linux/arm64";
    readonly timeoutMs: number;
  },
  options: PinnedOciRunnerOptions = {},
): Promise<void> {
  if (!PINNED_IMAGE.test(input.image)) refuse("grader image must be pinned by sha256 digest");
  const timeoutMs = Math.min(3_600_000, Math.max(60_000, input.timeoutMs));
  const inspect = () => boundedExit({
    runtime: input.runtime,
    args: ["image", "inspect", input.image],
    timeoutMs: Math.min(30_000, timeoutMs),
    options,
  });
  const existing = await inspect();
  if (!existing.timedOut && existing.code === 0) return;
  const pulled = await boundedExit({
    runtime: input.runtime,
    args: ["pull", "--platform", input.platform, input.image],
    timeoutMs,
    options,
  });
  if (pulled.timedOut || pulled.code !== 0) unavailable("pinned grader image is unavailable");
  const verified = await inspect();
  if (verified.timedOut || verified.code !== 0) {
    unavailable("pinned grader image could not be verified locally");
  }
}

/** Runs one bounded grader and returns only the exact bytes it left on the output mount. */
export async function runPinnedOciGrader(
  input: PinnedOciGraderInput,
  options: PinnedOciRunnerOptions = {},
): Promise<Uint8Array> {
  await ensurePinnedOciImage(input, options);
  let ownedNetwork: string | undefined;
  if (input.profileRequiresNetwork && input.allowedNetwork === undefined) {
    ownedNetwork = `jinn-oci-grader-network-${randomUUID()}`;
    const created = await boundedExit({
      runtime: input.runtime,
      args: ["network", "create", "--driver", "bridge", ownedNetwork],
      timeoutMs: Math.min(30_000, input.timeoutMs),
      options,
    });
    if (created.timedOut || created.code !== 0) {
      unavailable("isolated grader network could not be created");
    }
  }
  // Captured rather than returned/thrown directly, so that cleanup below always runs and never
  // discards this outcome: a `finally` block that throws (the previous shape here) replaces
  // whatever the try produced, silently turning a completed grade — or a more specific failure
  // such as the deadline below — into a generic "network could not be removed".
  let result: Uint8Array | undefined;
  let failure: unknown;
  try {
    const invocation = buildPinnedOciInvocation(
      {
        ...input,
        ...(ownedNetwork === undefined ? {} : { allowedNetwork: ownedNetwork }),
      },
      input.runtime === "docker" ? currentHostIdentity() : undefined,
    );
    const exit = await boundedExit({
      runtime: invocation.command,
      args: invocation.args,
      timeoutMs: input.timeoutMs,
      options,
    });
    if (exit.timedOut) {
      await boundedExit({
        runtime: input.runtime,
        args: ["rm", "-f", invocation.containerName],
        timeoutMs: Math.min(30_000, input.timeoutMs),
        options,
      });
      deadlineExceeded("grader exceeded its bounded time");
    }
    if (exit.code !== 0) unavailable("grader failed");
    result = secureRead(invocation.statementPath);
  } catch (error) {
    failure = error;
  }

  let cleanupFailure: unknown;
  if (ownedNetwork !== undefined) {
    try {
      const removed = await boundedExit({
        runtime: input.runtime,
        args: ["network", "rm", ownedNetwork],
        timeoutMs: Math.min(30_000, input.timeoutMs),
        options,
      });
      if (removed.timedOut || removed.code !== 0) {
        unavailable("isolated grader network could not be removed");
      }
    } catch (error) {
      cleanupFailure = error;
    }
  }

  // A completed grade, or a more specific failure the try block already classified (e.g. the
  // deadline above), always wins over a problem cleaning up the now-unused isolated network.
  if (result !== undefined) return result;
  if (failure !== undefined) throw failure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
  throw new Error("unreachable: runPinnedOciGrader produced neither a result nor an error");
}
