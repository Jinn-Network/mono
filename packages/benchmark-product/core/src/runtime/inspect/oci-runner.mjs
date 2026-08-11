#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";

const [dockerPath, ...dockerArgs] = process.argv.slice(2);
if (dockerPath === undefined || dockerArgs[0] !== "run") {
  process.stderr.write("usage: oci-runner.mjs <docker> run <args...>\n");
  process.exitCode = 2;
} else {
  const nameArg = dockerArgs.find((argument) => argument.startsWith("--name="));
  const containerName = nameArg?.slice("--name=".length);
  if (containerName === undefined || !/^[a-z0-9][a-z0-9_.-]{0,127}$/u.test(containerName)) {
    process.stderr.write("OCI runner requires one safe, exact container name\n");
    process.exitCode = 2;
  } else {
    let terminating = false;
    let settled = false;
    const child = spawn(dockerPath, dockerArgs, {
      stdio: "inherit",
      env: { LANG: "C.UTF-8" },
    });

    const terminate = (signal) => {
      if (terminating || settled) return;
      terminating = true;
      // Killing an attached Docker CLI does not stop its container. The runner owns this exact,
      // attempt-derived name and synchronously removes only that container before preserving the
      // cancellation signal for the task-execution supervisor's terminal accounting.
      spawnSync(dockerPath, ["rm", "--force", containerName], {
        stdio: "ignore",
        env: { LANG: "C.UTF-8" },
        timeout: 10_000,
      });
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    };

    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
      process.on(signal, () => terminate(signal));
    }
    child.once("error", (error) => {
      settled = true;
      process.stderr.write(`OCI runtime could not start: ${error instanceof Error ? error.name : "unknown error"}\n`);
      process.exitCode = 1;
    });
    child.once("exit", (code, signal) => {
      settled = true;
      if (terminating) return;
      if (signal !== null) {
        process.kill(process.pid, signal);
      } else {
        process.exitCode = code ?? 1;
      }
    });
  }
}
