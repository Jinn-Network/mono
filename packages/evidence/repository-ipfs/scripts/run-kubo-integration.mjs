// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

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
  let activeChild;
  let interruptedBy;
  let forceKillTimer;

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
      activeChild = child;
      if (captureOutput) {
        child.stdout.on("data", (chunk) => stdout.push(chunk));
        child.stderr.on("data", (chunk) => stderr.push(chunk));
      }
      let settled = false;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        if (activeChild === child) activeChild = undefined;
        if (forceKillTimer !== undefined) {
          clearTimeout(forceKillTimer);
          forceKillTimer = undefined;
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
      if (interruptedBy !== undefined) return;
      interruptedBy = signal;
      const child = activeChild;
      if (child === undefined) return;
      forceKillTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 1_000);
      forceKillTimer.unref();
      child.kill(signal);
    },
    output: (command, args) =>
      execute(command, args, { captureOutput: true }),
    run: (command, args, options) =>
      execute(command, args, options),
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
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
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
        const response = await fetch(`${endpoint}/api/v0/version`, {
          method: "POST",
          signal: AbortSignal.timeout(1_000),
        });
        if (response.ok) return endpoint;
      } catch {
        // Kubo has not opened the loopback-published API yet.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Kubo container ${name} did not become ready.`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
