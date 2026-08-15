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
const trustPackagesRoot = join(packageRoot, "..");
const coreRoot = join(trustPackagesRoot, "core");
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-trust-resolve-"));
const coreArchive = join(temporaryRoot, "trust-core.tgz");
const resolveArchive = join(temporaryRoot, "trust-resolve.tgz");
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
      throw new Error(`packed trust-resolve is missing ${entry}`);
    }
  }
  const leakedTests = entries.filter((entry) =>
    /(?:^|\/)[^/]*\.(?:test|spec)\./u.test(entry));
  if (leakedTests.length > 0) {
    throw new Error(`test files leaked into trust-resolve tarball: ${leakedTests.join(", ")}`);
  }
}

try {
  for (const [root, archive] of [
    [coreRoot, coreArchive],
    [packageRoot, resolveArchive],
  ]) {
    await run("corepack", ["yarn@4.13.0", "pack", "--out", archive], { cwd: root });
  }
  const archiveEntries = (await output("tar", ["-tzf", resolveArchive]))
    .split(/\r?\n/u)
    .filter(Boolean);
  assertArchiveShape(archiveEntries);

  await mkdir(consumer);
  await writeFile(join(consumer, "package.json"), JSON.stringify({
    private: true,
    type: "module",
    dependencies: {
      "@jinn-network/trust-core": `file:${coreArchive}`,
      "@jinn-network/trust-resolve": `file:${resolveArchive}`,
    },
  }));
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: consumer,
  });
  await writeFile(
    join(consumer, "consume.mjs"),
    'import * as resolve from "@jinn-network/trust-resolve";\n'
      + "console.log(typeof resolve);\n",
  );
  await run(process.execPath, ["consume.mjs"], { cwd: consumer });
  console.log("Packed trust-resolve distribution + archive shape verified.");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
