// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const protocolRoot = join(packageRoot, "..", "protocol");
const temporaryRoot = await mkdtemp(
  join(tmpdir(), "jinn-execution-evidence-builder-"),
);
const protocolArchive = join(temporaryRoot, "evidence-protocol.tgz");
const builderArchive = join(temporaryRoot, "execution-evidence-builder.tgz");
const consumer = join(temporaryRoot, "consumer");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

try {
  await run("yarn", ["pack", "--out", protocolArchive], {
    cwd: protocolRoot,
  });
  await run("yarn", ["pack", "--out", builderArchive], {
    cwd: packageRoot,
  });
  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@jinn-network/evidence-protocol": `file:${protocolArchive}`,
        "@jinn-network/execution-evidence-builder": `file:${builderArchive}`,
      },
    }),
  );
  await run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: consumer },
  );
  await writeFile(
    join(consumer, "smoke.mjs"),
    `
import assert from "node:assert/strict";
import {
  EXECUTION_EVIDENCE_BUILDER_ERROR_CODES,
  buildExecutionEvidence,
} from "@jinn-network/execution-evidence-builder";

assert.equal(typeof buildExecutionEvidence, "function");
assert.deepEqual(EXECUTION_EVIDENCE_BUILDER_ERROR_CODES, [
  "RECORDING_CONFLICT",
  "PROTOCOL_CONFORMANCE_FAILED",
]);
`,
  );
  await run("node", ["smoke.mjs"], { cwd: consumer });
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
