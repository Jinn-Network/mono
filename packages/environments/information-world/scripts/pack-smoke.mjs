import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-information-world-"));
const archive = join(temporaryRoot, "information-world.tgz");
const consumer = join(temporaryRoot, "consumer");

const REQUIRED_ENTRIES = [
  'package/dist/index.js',
  'package/dist/index.d.ts',
  'package/dist/testing.js',
  'package/dist/testing.d.ts',
  'package/schemas/information-world.schema.json',
  'package/fixtures/world/synthetic.json',
  'package/fixtures/world/synthetic.sha256',
  'package/fixtures/request-key-v1/vectors.json',
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
        "@jinn-network/information-world": `file:${archive}`,
      },
    }),
  );
  // A root-only consumer deliberately omits Vitest. The public root must not reach into the
  // optional ./testing kit, bundled fixtures, or source tree to load.
  await run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: consumer },
  );

  const installedRoot = join(consumer, "node_modules", "@jinn-network", "information-world");
  const smokeScript = join(consumer, "smoke.mjs");
  await writeFile(
    smokeScript,
    `
import { readFile, readdir } from "node:fs/promises";
import {
  INFORMATION_WORLD_KIND,
  canonicalRequestKey,
  informationWorldRecordDigest,
  parseInformationWorldRecord,
} from "@jinn-network/information-world";

if (INFORMATION_WORLD_KIND !== "https://jinn.network/records/information-world/1.0") {
  throw new Error("root import failed");
}
await readFile(new URL(import.meta.resolve("@jinn-network/information-world/schemas/information-world.schema.json")));
const golden = await readFile(new URL(import.meta.resolve("@jinn-network/information-world/fixtures/world/synthetic.json")));
const bytes = new Uint8Array(golden.buffer, golden.byteOffset, golden.byteLength);
const record = parseInformationWorldRecord(bytes);
const pinned = (await readFile(new URL(import.meta.resolve("@jinn-network/information-world/fixtures/world/synthetic.sha256")), "utf8")).trim();
if (informationWorldRecordDigest(bytes) !== pinned) {
  throw new Error("packed golden fixture does not match its pinned digest");
}
const vectorsFile = await readFile(new URL(import.meta.resolve("@jinn-network/information-world/fixtures/request-key-v1/vectors.json")), "utf8");
for (const group of JSON.parse(vectorsFile).groups) {
  const keys = new Set(group.requests.map((request) => canonicalRequestKey({
    method: request.method,
    url: request.url,
    headers: request.headers,
    body: request.body === undefined ? undefined : new TextEncoder().encode(request.body),
  }, group.policy)));
  if (keys.size !== 1) throw new Error("packed request-key vectors do not agree: " + group.name);
}
if (record.corpus.entries.length === 0) throw new Error("packed golden corpus is empty");
const packageJson = JSON.parse(await readFile(${JSON.stringify(join(installedRoot, "package.json"))}, "utf8"));
if (Object.keys(packageJson.dependencies ?? {}).some((name) => name.startsWith('@jinn-network/'))) {
  throw new Error('the information-world package must ship with zero Jinn runtime dependencies');
}
if (packageJson.peerDependencies?.vitest !== '^4.1.8'
    || packageJson.peerDependenciesMeta?.vitest?.optional !== true) {
  throw new Error('the ./testing kit must declare vitest as an exact optional peer');
}
for (const rootEntrypoint of ["index.js", "index.d.ts"]) {
  const rootSource = await readFile(${JSON.stringify(join(installedRoot, "dist"))} + "/" + rootEntrypoint, "utf8");
  if (new RegExp("fixtures|node:fs(?:/promises)?|vitest", "iu").test(rootSource)) {
    throw new Error("root entrypoint leaked a fixture, filesystem, or Vitest reference: " + rootEntrypoint);
  }
}
const distFiles = await readdir(${JSON.stringify(join(installedRoot, "dist"))});
if (distFiles.some((name) => name.includes(".test."))) throw new Error("test output leaked into dist");
await readFile(${JSON.stringify(join(installedRoot, "README.md"))});
console.log("Installed package imports, assets, fixtures, request-key vectors, and dependency boundary verified.");
`,
  );
  await run(process.execPath, [smokeScript], { cwd: temporaryRoot });
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
