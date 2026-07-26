// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

const matrices = [
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

for (const matrix of matrices) {
  const name =
    `jinn-evidence-ipfs-${matrix.version.replaceAll(".", "-")}-` +
    randomBytes(6).toString("hex");
  try {
    await run("docker", [
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
    const endpoint = await waitForEndpoint(name);
    for (const testFile of matrix.tests) {
      await run(
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
    await runAllowingFailure("docker", ["stop", "--time", "5", name]);
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...options,
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

async function runAllowingFailure(command, args) {
  try {
    await run(command, args);
  } catch {
    // Cleanup is best effort and targets only the unique container we created.
  }
}

function commandOutput(command, args) {
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8").trim());
        return;
      }
      reject(
        new Error(
          `${command} exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`,
        ),
      );
    });
  });
}

async function waitForEndpoint(name) {
  let endpoint;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (endpoint === undefined) {
      try {
        const binding = await commandOutput("docker", [
          "port",
          name,
          "5001/tcp",
        ]);
        const match = /^127\.0\.0\.1:(\d+)$/u.exec(binding);
        if (match !== null) endpoint = `http://127.0.0.1:${match[1]}`;
      } catch {
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
