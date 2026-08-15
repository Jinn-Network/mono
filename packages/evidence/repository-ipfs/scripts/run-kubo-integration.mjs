// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const CHILD_FORCE_KILL_DELAY_MS = 1_000;
const CLEANUP_TERM_DELAY_MS = 1_000;
const CLEANUP_KILL_DELAY_MS = 2_000;
const CLEANUP_GIVE_UP_DELAY_MS = 3_000;

const DEFAULT_MATRICES = [
  {
    image:
      "ipfs/kubo@sha256:7cc0e0de8f845d6c9fa1dce414c069974c34ed3cd3742e0d4f5bccda4adc376d",
    tests: ["test/kubo-reader.integration.test.ts"],
    version: "0.32.1",
  },
  {
    image:
      "ipfs/kubo@sha256:e08c602bf97f138a0ec5b42155b4fd4532852919250b11b4aadbea2bf42c0e10",
    tests: [
      "test/kubo.integration.test.ts",
      "test/contract.integration.test.ts",
    ],
    version: "0.40.0",
  },
  {
    image:
      "ipfs/kubo@sha256:8907cb0cc1ad5798f6bb1bb1341a800990c268e021cedfa317e8aa1a33864214",
    tests: [
      "test/kubo.integration.test.ts",
      "test/contract.integration.test.ts",
    ],
    version: "0.42.0",
  },
];

export async function runKuboIntegration(options = {}) {
  const matrices = options.matrices ?? DEFAULT_MATRICES;
  const supervisor = options.supervisor ?? createCommandSupervisor();
  const randomSuffix =
    options.randomSuffix ?? (() => randomBytes(6).toString("hex"));
  const resolveEndpoint = options.waitForEndpoint ?? waitForEndpoint;

  for (const matrix of matrices) {
    const name =
      `jinn-evidence-ipfs-${matrix.version.replaceAll(".", "-")}-` +
      randomSuffix();
    try {
      await supervisor.run("docker", [
        "run",
        "--detach",
        "--name",
        name,
        "--publish",
        "127.0.0.1::5001",
        "--rm",
        matrix.image,
        "daemon",
        "--offline",
      ]);
      const endpoint = await resolveEndpoint(name, supervisor);
      for (const testFile of matrix.tests) {
        await supervisor.run(
          process.execPath,
          [
            "node_modules/vitest/vitest.mjs",
            "run",
            testFile,
          ],
          {
            env: {
              ...process.env,
              JINN_KUBO_API_URL: endpoint,
              JINN_KUBO_EXPECTED_VERSION: matrix.version,
            },
          },
        );
      }
    } finally {
      await supervisor.cleanup("docker", ["rm", "-f", name]);
    }
  }
}

export function createCommandSupervisor(spawnCapability = spawn) {
  let activeCommandChild;
  let activeCleanupChild;
  let interruptedBy;
  let interruptForceKillTimer;
  let interruptForceKillChild;
  const interruption = new AbortController();

  const execute = (command, args, options = {}, cleanup = false) => {
    if (interruptedBy !== undefined && !cleanup) {
      return Promise.reject(new CommandInterrupted(interruptedBy));
    }
    return new Promise((resolve, reject) => {
      const {
        captureOutput = false,
        ...spawnOptions
      } = options;
      const stdout = [];
      const stderr = [];
      const child = spawnCapability(command, args, {
        stdio: captureOutput ? ["ignore", "pipe", "pipe"] : "inherit",
        ...spawnOptions,
      });
      if (cleanup) {
        activeCleanupChild = child;
      } else {
        activeCommandChild = child;
      }
      if (captureOutput) {
        child.stdout.on("data", (chunk) => stdout.push(chunk));
        child.stderr.on("data", (chunk) => stderr.push(chunk));
      }
      let settled = false;
      const cleanupTimers = [];
      const settle = (result) => {
        if (settled) return;
        settled = true;
        if (activeCommandChild === child) activeCommandChild = undefined;
        if (activeCleanupChild === child) activeCleanupChild = undefined;
        for (const timer of cleanupTimers) clearTimeout(timer);
        if (interruptForceKillChild === child) {
          if (interruptForceKillTimer !== undefined) {
            clearTimeout(interruptForceKillTimer);
          }
          interruptForceKillTimer = undefined;
          interruptForceKillChild = undefined;
        }
        result();
      };
      child.once("error", (error) => {
        settle(() => reject(error));
      });
      child.once("exit", (code) => {
        settle(() => {
          if (interruptedBy !== undefined && !cleanup) {
            reject(new CommandInterrupted(interruptedBy));
          } else if (code === 0) {
            resolve(
              captureOutput
                ? Buffer.concat(stdout).toString("utf8").trim()
                : undefined,
            );
          } else {
            const detail = captureOutput
              ? `: ${Buffer.concat(stderr).toString("utf8")}`
              : "";
            reject(new Error(`${command} exited with ${code}${detail}`));
          }
        });
      });
      if (cleanup) {
        cleanupTimers.push(
          setTimeout(() => {
            if (!settled) child.kill("SIGTERM");
          }, CLEANUP_TERM_DELAY_MS),
          setTimeout(() => {
            if (!settled) child.kill("SIGKILL");
          }, CLEANUP_KILL_DELAY_MS),
          setTimeout(() => {
            if (settled) return;
            child.unref?.();
            settle(() =>
              reject(
                new Error(
                  `${command} cleanup did not exit after SIGTERM and SIGKILL`,
                ),
              ),
            );
          }, CLEANUP_GIVE_UP_DELAY_MS),
        );
        for (const timer of cleanupTimers) timer.unref();
      }
    });
  };

  return {
    cleanup: async (command, args) => {
      try {
        await execute(command, args, {}, true);
      } catch {
        // Cleanup is best effort and targets only the generated exact name.
      }
    },
    interrupt(signal) {
      const repeated = interruptedBy !== undefined;
      interruptedBy ??= signal;
      if (!interruption.signal.aborted) {
        interruption.abort(new CommandInterrupted(interruptedBy));
      }
      const child = activeCleanupChild ?? activeCommandChild;
      if (child === undefined) return;
      if (repeated) {
        child.kill("SIGKILL");
        return;
      }
      interruptForceKillChild = child;
      interruptForceKillTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, CHILD_FORCE_KILL_DELAY_MS);
      interruptForceKillTimer.unref();
      child.kill(signal);
    },
    output: (command, args) =>
      execute(command, args, { captureOutput: true }),
    run: (command, args, options) =>
      execute(command, args, options),
    signal: interruption.signal,
  };
}

export async function main() {
  const supervisor = createCommandSupervisor();
  let receivedSignal;
  const receiveSignal = (signal) => {
    receivedSignal ??= signal;
    supervisor.interrupt(signal);
  };
  const onSigint = () => receiveSignal("SIGINT");
  const onSigterm = () => receiveSignal("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  try {
    await runKuboIntegration({ supervisor });
  } catch (error) {
    if (receivedSignal === undefined) throw error;
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
  if (receivedSignal !== undefined) {
    process.exitCode = receivedSignal === "SIGINT" ? 130 : 143;
  }
}

class CommandInterrupted extends Error {
  constructor(signal) {
    super(`Kubo integration was interrupted by ${signal}.`);
    this.name = "CommandInterrupted";
  }
}

function commandOutput(command, args, supervisor) {
  if (supervisor === undefined) {
    throw new Error("A command supervisor is required.");
  }
  return supervisor.output(command, args);
}

async function waitForEndpoint(name, supervisor) {
  let endpoint;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    throwIfSupervisorInterrupted(supervisor);
    if (endpoint === undefined) {
      try {
        const binding = await commandOutput(
          "docker",
          ["port", name, "5001/tcp"],
          supervisor,
        );
        const match = /^127\.0\.0\.1:(\d+)$/u.exec(binding);
        if (match !== null) endpoint = `http://127.0.0.1:${match[1]}`;
      } catch (error) {
        if (error instanceof CommandInterrupted) throw error;
        // The port mapping may not be visible during initial container setup.
      }
    }
    if (endpoint !== undefined) {
      try {
        const timeoutSignal = AbortSignal.timeout(1_000);
        const signal =
          supervisor.signal === undefined
            ? timeoutSignal
            : AbortSignal.any([timeoutSignal, supervisor.signal]);
        const response = await awaitSupervisorInterruptable(
          () =>
            fetch(`${endpoint}/api/v0/version`, {
              method: "POST",
              signal,
            }),
          supervisor,
        );
        throwIfSupervisorInterrupted(supervisor);
        if (response.ok) return endpoint;
      } catch {
        throwIfSupervisorInterrupted(supervisor);
        // Kubo has not opened the loopback-published API yet.
      }
    }
    await waitForReadinessRetry(supervisor, 250);
  }
  throw new Error(`Kubo container ${name} did not become ready.`);
}

async function awaitSupervisorInterruptable(operation, supervisor) {
  throwIfSupervisorInterrupted(supervisor);
  const signal = supervisor.signal;
  if (signal === undefined) return Promise.resolve(operation());

  let rejectInterrupt;
  const interrupted = new Promise((_resolve, reject) => {
    rejectInterrupt = reject;
  });
  const onInterrupt = () => rejectInterrupt(signal.reason);
  signal.addEventListener("abort", onInterrupt, { once: true });
  if (signal.aborted) onInterrupt();
  let pending;
  if (signal.aborted) {
    pending = new Promise(() => {});
  } else {
    try {
      pending = Promise.resolve(operation());
    } catch (error) {
      pending = Promise.reject(error);
    }
  }
  try {
    return await Promise.race([pending, interrupted]);
  } finally {
    signal.removeEventListener("abort", onInterrupt);
  }
}

async function waitForReadinessRetry(supervisor, delayMs) {
  throwIfSupervisorInterrupted(supervisor);
  const signal = supervisor.signal;
  if (signal === undefined) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return;
  }
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onInterrupt);
      result();
    };
    const onInterrupt = () =>
      finish(() => reject(signal.reason));
    const timer = setTimeout(
      () => finish(resolve),
      delayMs,
    );
    signal.addEventListener("abort", onInterrupt, { once: true });
    if (signal.aborted) onInterrupt();
  });
  throwIfSupervisorInterrupted(supervisor);
}

function throwIfSupervisorInterrupted(supervisor) {
  const signal = supervisor.signal;
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof CommandInterrupted) {
    throw signal.reason;
  }
  throw new CommandInterrupted("an external signal");
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
