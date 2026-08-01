// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-plugin-runtime-"));
const archive = join(temporaryRoot, "plugin-runtime.tgz");
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
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
        return;
      }
      reject(new Error(`${command} exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
    });
  });
}

try {
  await run("corepack", ["yarn@4.13.0", "pack", "--out", archive], { cwd: packageRoot });

  const entries = (await output("tar", ["-tzf", archive])).split(/\r?\n/u).filter(Boolean);
  for (const required of [
    "package/README.md",
    "package/dist/bin.js",
    "package/dist/index.d.ts",
    "package/dist/index.js",
    "package/package.json",
  ]) {
    if (!entries.includes(required)) {
      throw new Error(`packed runtime is missing ${required}`);
    }
  }
  const leaked = entries.filter(
    (entry) =>
      /(?:^|\/)[^/]*\.(?:test|spec)\./u.test(entry) ||
      entry.endsWith(".map") ||
      entry.includes("/src/") ||
      entry.includes("/fixtures/"),
  );
  if (leaked.length > 0) {
    throw new Error(`private/test material leaked into tarball: ${leaked.join(", ")}`);
  }

  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: { "@jinn-network/plugin-runtime": `file:${archive}` },
    }),
  );
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: consumer });

  await writeFile(
    join(consumer, "smoke.mjs"),
    `
import assert from "node:assert/strict";
import * as runtime from "@jinn-network/plugin-runtime";

assert.equal(typeof runtime.createPluginRuntime, "function");
assert.equal(typeof runtime.resolveRuntimeConfig, "function");
assert.equal(typeof runtime.summarizeHealth, "function");
assert.equal("main" in runtime, false);

const config = runtime.resolveRuntimeConfig({ env: {}, homeDirectory: "/srv/packed" });
assert.equal(config.archiveDirectory, "/srv/packed/archive");

const instance = runtime.createPluginRuntime({ config });
await instance.start();
const report = await instance.health();
assert.equal(report.ok, true);
assert.equal(report.checks.length, 0);
await instance.stop();
`,
  );
  await run(process.execPath, [join(consumer, "smoke.mjs")], { cwd: consumer });

  // The binary must run from the installed tarball, and it must keep stdout clean.
  const binary = join(consumer, "node_modules", ".bin", "jinn-plugin-runtime");
  const version = await output(binary, ["--version"], { cwd: consumer });
  const installedManifest = JSON.parse(
    await readFile(
      join(consumer, "node_modules", "@jinn-network/plugin-runtime", "package.json"),
      "utf8",
    ),
  );
  assert.equal(version.trim(), installedManifest.version);
  assert.deepEqual(installedManifest.publishConfig, { access: "public", provenance: true });
  assert.deepEqual(Object.keys(installedManifest.exports), ["."]);

  const health = await output(binary, ["health"], {
    cwd: consumer,
    env: { ...process.env, JINN_PLUGIN_HOME: join(temporaryRoot, "home") },
  });
  const report = JSON.parse(health.trim());
  assert.equal(report.ok, true);
  assert.deepEqual(report.checks, []);

  // Nothing test-only travels with the package.
  await assert.rejects(
    access(join(consumer, "node_modules", "vitest", "package.json")),
    { code: "ENOENT" },
  );

  console.log("Packed plugin runtime tarball shape, isolated consumer, and binary verified.");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
