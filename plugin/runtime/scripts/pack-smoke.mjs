// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(packageRoot, "..", "..");

// Cross-tree portal dependencies from plugin/runtime/package.json resolutions.
// Packed in dependency order so the isolated consumer's npm install resolves
// end-to-end without registry fetches for unpublished @jinn-network packages.
const portals = [
  {
    name: "@jinn-network/trust-core",
    root: join(repoRoot, "packages", "trust", "core"),
    archive: "trust-core.tgz",
  },
  {
    name: "@jinn-network/evidence-protocol",
    root: join(repoRoot, "packages", "evidence", "protocol"),
    archive: "evidence-protocol.tgz",
  },
  {
    name: "@jinn-network/record-discovery-protocol",
    root: join(repoRoot, "packages", "discovery", "protocol"),
    archive: "record-discovery-protocol.tgz",
  },
  {
    name: "@jinn-network/record-discovery-serve",
    root: join(repoRoot, "packages", "discovery", "serve"),
    archive: "record-discovery-serve.tgz",
  },
  {
    name: "@jinn-network/evidence-repository",
    root: join(repoRoot, "packages", "evidence", "repository"),
    archive: "evidence-repository.tgz",
  },
  {
    name: "@jinn-network/execution-evidence-builder",
    root: join(repoRoot, "packages", "evidence", "execution-evidence-builder"),
    archive: "execution-evidence-builder.tgz",
  },
  {
    name: "@jinn-network/execution-recorder",
    root: join(repoRoot, "packages", "evidence", "execution-recorder"),
    archive: "execution-recorder.tgz",
  },
  {
    name: "@jinn-network/evidence-discovery",
    root: join(repoRoot, "packages", "evidence", "discovery"),
    archive: "evidence-discovery.tgz",
  },
  {
    name: "@jinn-network/evidence-derivation",
    root: join(repoRoot, "packages", "evidence", "derivation"),
    archive: "evidence-derivation.tgz",
  },
  {
    name: "@jinn-network/evidence-retrieval",
    root: join(repoRoot, "packages", "evidence", "retrieval"),
    archive: "evidence-retrieval.tgz",
  },
  {
    name: "@jinn-network/evidence-catalog-sqlite",
    root: join(repoRoot, "packages", "evidence", "catalog-sqlite"),
    archive: "evidence-catalog-sqlite.tgz",
  },
  {
    name: "@jinn-network/evidence-local-runtime",
    root: join(repoRoot, "packages", "evidence", "local-runtime"),
    archive: "evidence-local-runtime.tgz",
  },
  {
    name: "@jinn-network/evidence-trace",
    root: join(repoRoot, "packages", "evidence", "trace"),
    archive: "evidence-trace.tgz",
  },
  {
    name: "@jinn-network/evidence-trace-decode",
    root: join(repoRoot, "packages", "evidence", "trace-decode"),
    archive: "evidence-trace-decode.tgz",
  },
  {
    name: "@jinn-network/record-discovery-client",
    root: join(repoRoot, "packages", "discovery", "client"),
    archive: "record-discovery-client.tgz",
  },
  {
    name: "@jinn-network/record-discovery-transport-http",
    root: join(repoRoot, "packages", "discovery", "transport-http"),
    archive: "record-discovery-transport-http.tgz",
  },
];

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

async function packPortal(root, out) {
  await run("corepack", ["yarn@4.13.0", "pack", "--out", out], { cwd: root });
}

try {
  const portalArchives = new Map();
  for (const portal of portals) {
    const out = join(temporaryRoot, portal.archive);
    await packPortal(portal.root, out);
    portalArchives.set(portal.name, out);
  }

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
  const dependencies = Object.fromEntries(
    portals.map((portal) => [portal.name, `file:${portalArchives.get(portal.name)}`]),
  );
  dependencies["@jinn-network/plugin-runtime"] = `file:${archive}`;
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies,
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
