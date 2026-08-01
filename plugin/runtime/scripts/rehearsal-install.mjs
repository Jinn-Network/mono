#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Pack portal dependencies plus the runtime and npm-install into a rehearsal
// prefix. Unpublished @jinn-network packages are not on the registry, so a bare
// `npm pack` + `npm install <tarball>` cannot satisfy the pin. Usage:
//   node rehearsal-install.mjs <work-dir> <install-prefix>

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [, , workDir, installPrefix] = process.argv;
if (!workDir || !installPrefix) {
  console.error("usage: rehearsal-install.mjs <work-dir> <install-prefix>");
  process.exit(2);
}

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(packageRoot, "..", "..");

const portals = [
  { name: "@jinn-network/trust-core", root: join(repoRoot, "packages", "trust", "core"), archive: "trust-core.tgz" },
  { name: "@jinn-network/evidence-protocol", root: join(repoRoot, "packages", "evidence", "protocol"), archive: "evidence-protocol.tgz" },
  { name: "@jinn-network/record-discovery-protocol", root: join(repoRoot, "packages", "discovery", "protocol"), archive: "record-discovery-protocol.tgz" },
  { name: "@jinn-network/evidence-repository", root: join(repoRoot, "packages", "evidence", "repository"), archive: "evidence-repository.tgz" },
  { name: "@jinn-network/execution-recorder", root: join(repoRoot, "packages", "evidence", "execution-recorder"), archive: "execution-recorder.tgz" },
  { name: "@jinn-network/evidence-discovery", root: join(repoRoot, "packages", "evidence", "discovery"), archive: "evidence-discovery.tgz" },
  { name: "@jinn-network/evidence-derivation", root: join(repoRoot, "packages", "evidence", "derivation"), archive: "evidence-derivation.tgz" },
  { name: "@jinn-network/evidence-retrieval", root: join(repoRoot, "packages", "evidence", "retrieval"), archive: "evidence-retrieval.tgz" },
  { name: "@jinn-network/evidence-catalog-sqlite", root: join(repoRoot, "packages", "evidence", "catalog-sqlite"), archive: "evidence-catalog-sqlite.tgz" },
  { name: "@jinn-network/evidence-local-runtime", root: join(repoRoot, "packages", "evidence", "local-runtime"), archive: "evidence-local-runtime.tgz" },
  { name: "@jinn-network/evidence-trajectory", root: join(repoRoot, "packages", "evidence", "trajectory"), archive: "evidence-trajectory.tgz" },
  { name: "@jinn-network/evidence-trace-decode", root: join(repoRoot, "packages", "evidence", "trace-decode"), archive: "evidence-trace-decode.tgz" },
  { name: "@jinn-network/record-discovery-client", root: join(repoRoot, "packages", "discovery", "client"), archive: "record-discovery-client.tgz" },
];

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

const portalArchives = new Map();
for (const portal of portals) {
  await run("corepack", ["yarn@4.13.0", "build"], { cwd: portal.root });
  const out = join(workDir, portal.archive);
  await run("corepack", ["yarn@4.13.0", "pack", "--out", out], { cwd: portal.root });
  portalArchives.set(portal.name, out);
}

const runtimeArchive = join(workDir, "plugin-runtime.tgz");
await run("corepack", ["yarn@4.13.0", "pack", "--out", runtimeArchive], { cwd: packageRoot });

await mkdir(installPrefix, { recursive: true });
const dependencies = Object.fromEntries(
  portals.map((portal) => [portal.name, `file:${portalArchives.get(portal.name)}`]),
);
dependencies["@jinn-network/plugin-runtime"] = `file:${runtimeArchive}`;
await writeFile(
  join(installPrefix, "package.json"),
  JSON.stringify({ private: true, type: "module", dependencies }, null, 2),
);
await run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], { cwd: installPrefix });
