import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
// Unlike benchmarking-records, this package has NO Jinn runtime dependency, so the consumer
// graph needs no cross-tree portal packing: the tarball alone must install and import.
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-environment-record-"));
const archive = join(temporaryRoot, "environment-record.tgz");
const consumer = join(temporaryRoot, "consumer");

const REQUIRED_ENTRIES = [
  'package/dist/index.js',
  'package/dist/index.d.ts',
  'package/dist/testing.js',
  'package/dist/testing.d.ts',
  'package/schemas/environment.schema.json',
  'package/fixtures/environment/imported.json',
  'package/fixtures/environment/imported.sha256',
  'package/fixtures/adversarial-v1/manifest.json',
  'package/README.md',
  'package/package.json',
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

function capture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "inherit"], ...options });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

try {
  await run("yarn", ["pack", "--out", archive], { cwd: packageRoot });

  // The tarball is the published surface: assert what it must carry, and what it must not.
  const entries = (await capture("tar", ["-tzf", archive]))
    .split("\n").map((line) => line.trim()).filter(Boolean);
  const missing = REQUIRED_ENTRIES.filter((entry) => !entries.includes(entry));
  if (missing.length > 0) throw new Error(`tarball is missing entries: ${missing.join(", ")}`);
  const leaked = entries.filter((entry) =>
    entry.includes(".test.") || entry.endsWith(".map") || entry.startsWith("package/src/"));
  if (leaked.length > 0) throw new Error(`tarball leaked entries: ${leaked.join(", ")}`);

  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@jinn-network/environment-record": `file:${archive}`,
      },
    }),
  );
  // No `vitest` in the consumer: the ./testing kit declares it as an OPTIONAL peer, so a
  // root-only consumer must install and import cleanly without it.
  await run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: consumer },
  );

  const installedRoot = join(consumer, "node_modules", "@jinn-network", "environment-record");
  const smokeScript = join(consumer, "smoke.mjs");
  await writeFile(
    smokeScript,
    `
import { readFile, readdir } from "node:fs/promises";
import {
  ENVIRONMENT_RECORD_KIND,
  environmentRecordDigest,
  parseEnvironmentRecord,
} from "@jinn-network/environment-record";

if (ENVIRONMENT_RECORD_KIND !== "https://spec.jinn.network/records/environment/v1") {
  throw new Error("root import failed");
}
await readFile(new URL(import.meta.resolve("@jinn-network/environment-record/schemas/environment.schema.json")));
const golden = await readFile(new URL(import.meta.resolve("@jinn-network/environment-record/fixtures/environment/imported.json")));
const bytes = new Uint8Array(golden.buffer, golden.byteOffset, golden.byteLength);
parseEnvironmentRecord(bytes);
const pinned = (await readFile(new URL(import.meta.resolve("@jinn-network/environment-record/fixtures/environment/imported.sha256")), "utf8")).trim();
if (environmentRecordDigest(bytes) !== pinned) {
  throw new Error("packed golden fixture does not match its pinned digest");
}
const packageJson = JSON.parse(await readFile(${JSON.stringify(join(installedRoot, "package.json"))}, "utf8"));
if (Object.keys(packageJson.dependencies ?? {}).some((name) => name.startsWith('@jinn-network/'))) {
  throw new Error('the record package must ship with zero Jinn runtime dependencies');
}
if (packageJson.peerDependencies?.vitest !== '^4.1.8'
    || packageJson.peerDependenciesMeta?.vitest?.optional !== true) {
  throw new Error('the ./testing kit must declare vitest as an exact optional peer');
}
const distFiles = await readdir(${JSON.stringify(join(installedRoot, "dist"))});
if (distFiles.some((name) => name.includes(".test."))) throw new Error("test output leaked into dist");
await readFile(${JSON.stringify(join(installedRoot, "README.md"))});
console.log("Installed package imports, assets, fixtures, and dependency boundary verified.");
`,
  );
  await run(process.execPath, [smokeScript], { cwd: temporaryRoot });
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
