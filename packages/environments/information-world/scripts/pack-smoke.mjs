import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

function relativeModuleSpecifiers(source) {
  return [...source.matchAll(/\b(?:from|import)\s*(?:\(\s*)?["'](\.{1,2}\/[^"']+)["']/g)]
    .map((match) => match[1]);
}

function packedRelativeModule(file, specifier, declarations) {
  const target = join(dirname(file), specifier);
  const candidates = declarations
    ? [
      ...(target.endsWith(".js") ? [`${target.slice(0, -3)}.d.ts`] : []),
      ...(target.endsWith(".d.ts") ? [target] : []),
      `${target}.d.ts`,
      join(target, "index.d.ts"),
    ]
    : [target, `${target}.js`, join(target, "index.js")];
  return candidates.find((candidate) => existsSync(candidate));
}

async function packedRelativeClosure(entrypoint, declarations) {
  const discovered = new Set();
  const pending = [entrypoint];
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || discovered.has(file)) continue;
    discovered.add(file);
    const source = await readFile(file, "utf8");
    for (const specifier of relativeModuleSpecifiers(source)) {
      const target = packedRelativeModule(file, specifier, declarations);
      if (target === undefined) {
        throw new Error(`unresolvable packed relative edge: ${file} -> ${specifier}`);
      }
      if (!discovered.has(target)) pending.push(target);
    }
  }
  return [...discovered];
}

function packedGraphLeakFindings(files, entrypoint, phase) {
  return files.flatMap((file) => {
    const findings = [];
    const path = file.slice(dirname(entrypoint).length + 1);
    if (/(?:^|\/)fixtures(?:\.|\/)/u.test(path)) {
      findings.push({ file, reason: `${phase} fixture region` });
    }
    if (/(?:^|\/)testing(?:\.|\/)/u.test(path)) {
      findings.push({ file, reason: `${phase} testing region` });
    }
    return findings;
  });
}

async function packedRootLeakFindings(runtimeEntrypoint, declarationEntrypoint) {
  const runtimeFiles = await packedRelativeClosure(runtimeEntrypoint, false);
  const declarationFiles = await packedRelativeClosure(declarationEntrypoint, true);
  const findings = [
    ...packedGraphLeakFindings(runtimeFiles, runtimeEntrypoint, "runtime"),
    ...packedGraphLeakFindings(declarationFiles, declarationEntrypoint, "declaration"),
  ];
  for (const [phase, files] of [["runtime", runtimeFiles], ["declaration", declarationFiles]]) {
    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const module of ["node:fs", "node:fs/promises"]) {
        if (source.includes(`"${module}"`) || source.includes(`'${module}'`)) {
          findings.push({ file, reason: `${phase} ${module}` });
        }
      }
      if (/['"]vitest['"]/u.test(source)) findings.push({ file, reason: `${phase} vitest` });
    }
  }
  return findings;
}

async function assertPackedRootClosureCanary() {
  const graph = join(temporaryRoot, "root-closure-canary");
  await mkdir(graph);
  await Promise.all([
    writeFile(join(graph, "index.js"), 'export * from "./support.js";\n'),
    writeFile(join(graph, "support.js"), 'export * from "./fixtures.js";\nexport * from "./testing.js";\n'),
    writeFile(join(graph, "fixtures.js"), 'import { readFile } from "node:fs/promises";\nexport { readFile };\n'),
    writeFile(join(graph, "testing.js"), 'import { test } from "vitest";\nexport { test };\n'),
    writeFile(join(graph, "index.d.ts"), 'export * from "./support.js";\n'),
    writeFile(join(graph, "support.d.ts"), 'export * from "./fixtures.js";\nexport * from "./testing.js";\n'),
    writeFile(join(graph, "fixtures.d.ts"), 'import type { Stats } from "node:fs";\nexport type FixtureStats = Stats;\n'),
    writeFile(join(graph, "testing.d.ts"), 'import type { TestContext } from "vitest";\nexport type FixtureTest = TestContext;\n'),
  ]);
  const reasons = (await packedRootLeakFindings(join(graph, "index.js"), join(graph, "index.d.ts")))
    .map((finding) => finding.reason).sort();
  const expected = [
    'declaration fixture region', 'declaration node:fs', 'declaration testing region', 'declaration vitest',
    'runtime fixture region', 'runtime node:fs/promises', 'runtime testing region', 'runtime vitest',
  ];
  if (JSON.stringify(reasons) !== JSON.stringify(expected)) {
    throw new Error(`root-closure canary missed a transitive leak: ${JSON.stringify(reasons)}`);
  }
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

  // This writes and statically scans a temporary graph; it never imports or executes the
  // mutation modules. A direct-root-only scan would miss both support-file leaks.
  await assertPackedRootClosureCanary();

  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@jinn-network/information-world": `file:${archive}`,
        "@types/node": "^22.0.0",
        "typescript": "^5.9.3",
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
  const rootLeaks = await packedRootLeakFindings(
    join(installedRoot, "dist", "index.js"),
    join(installedRoot, "dist", "index.d.ts"),
  );
  if (rootLeaks.length > 0) {
    throw new Error(`packed root entrypoint leaked: ${rootLeaks
      .map(({ file, reason }) => `${file}: ${reason}`).join(", ")}`);
  }
  if (existsSync(join(consumer, "node_modules", "vitest"))) {
    throw new Error("the root-only runtime and type consumer must not install Vitest");
  }
  await writeFile(
    join(consumer, "root-types.ts"),
    'import type * as InformationWorld from "@jinn-network/information-world";\n'
      + 'export type RootEntrypoint = typeof InformationWorld;\n',
  );
  await writeFile(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        strict: true,
        target: "ES2022",
      },
      include: ["root-types.ts"],
    }),
  );
  const tsc = join(consumer, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  await run(tsc, ["--project", "tsconfig.json"], { cwd: consumer });
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

if (INFORMATION_WORLD_KIND !== "https://spec.jinn.network/records/information-world/v1") {
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
