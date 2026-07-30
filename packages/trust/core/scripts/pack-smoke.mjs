// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-trust-core-"));
const coreArchive = join(temporaryRoot, "trust-core.tgz");
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

function output(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve(Buffer.concat(stdout).toString("utf8"))
      : reject(new Error(
        `${command} exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`,
      )));
  });
}

function assertArchiveShape(entries) {
  const required = [
    "package/README.md",
    "package/dist/index.d.ts",
    "package/dist/index.js",
  ];
  for (const entry of required) {
    if (!entries.includes(entry)) {
      throw new Error(`packed trust-core is missing ${entry}`);
    }
  }
  const leakedTests = entries.filter((entry) =>
    /(?:^|\/)[^/]*\.(?:test|spec)\./u.test(entry));
  if (leakedTests.length > 0) {
    throw new Error(`test files leaked into trust-core tarball: ${leakedTests.join(", ")}`);
  }
}

try {
  await run("corepack", ["yarn@4.13.0", "pack", "--out", coreArchive], { cwd: packageRoot });
  const archiveEntries = (await output("tar", ["-tzf", coreArchive]))
    .split(/\r?\n/u)
    .filter(Boolean);
  assertArchiveShape(archiveEntries);

  await mkdir(consumer);
  await writeFile(join(consumer, "package.json"), JSON.stringify({
    private: true,
    type: "module",
    dependencies: {
      "@jinn-network/trust-core": `file:${coreArchive}`,
    },
  }));
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: consumer,
  });
  await writeFile(
    join(consumer, "consume.mjs"),
    'import * as trust from "@jinn-network/trust-core";\n'
      + "console.log(typeof trust);\n",
  );
  await run(process.execPath, ["consume.mjs"], { cwd: consumer });
  console.log("Packed trust-core distribution + archive shape verified.");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
