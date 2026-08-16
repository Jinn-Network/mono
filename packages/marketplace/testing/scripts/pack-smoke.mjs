import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
// Cross-tree + sibling portal dependencies (§7.8), packed in dependency order (leaves first).
// task-execution-testing's runtime closure includes backend-local/{supervisor,workspace,
// launchers,assembly} plus the assembly's evidence contract deps.
const dependencyChain = [
  ["@jinn-network/evidence-protocol", join(packageRoot, "..", "..", "evidence", "protocol")],
  ["@jinn-network/evidence-repository", join(packageRoot, "..", "..", "evidence", "repository")],
  ["@jinn-network/evidence-discovery", join(packageRoot, "..", "..", "evidence", "discovery")],
  ["@jinn-network/execution-evidence-builder", join(packageRoot, "..", "..", "evidence", "execution-evidence-builder")],
  ["@jinn-network/execution-recorder", join(packageRoot, "..", "..", "evidence", "execution-recorder")],
  ["@jinn-network/task-execution-protocol", join(packageRoot, "..", "..", "task-execution", "protocol")],
  ["@jinn-network/task-execution-backend", join(packageRoot, "..", "..", "task-execution", "backend")],
  ["@jinn-network/task-execution-profiles", join(packageRoot, "..", "..", "task-execution", "profiles")],
  ["@jinn-network/task-execution-supervisor", join(packageRoot, "..", "..", "task-execution", "backend-local", "supervisor")],
  ["@jinn-network/task-execution-workspace", join(packageRoot, "..", "..", "task-execution", "backend-local", "workspace")],
  ["@jinn-network/task-execution-launchers", join(packageRoot, "..", "..", "task-execution", "backend-local", "launchers")],
  ["@jinn-network/task-execution-backend-local", join(packageRoot, "..", "..", "task-execution", "backend-local", "assembly")],
  ["@jinn-network/task-execution-testing", join(packageRoot, "..", "..", "task-execution", "testing")],
  ["@jinn-network/trust-core", join(packageRoot, "..", "..", "trust", "core")],
  ["@jinn-network/trust-resolve", join(packageRoot, "..", "..", "trust", "resolve")],
  ["@jinn-network/trust-testing", join(packageRoot, "..", "..", "trust", "testing")],
  ["@jinn-network/record-discovery-protocol", join(packageRoot, "..", "..", "discovery", "protocol")],
  ["@jinn-network/record-discovery-serve", join(packageRoot, "..", "..", "discovery", "serve")],
  ["@jinn-network/record-discovery-testing", join(packageRoot, "..", "..", "discovery", "testing")],
  ["@jinn-network/marketplace-binding", join(packageRoot, "..", "binding")],
  ["@jinn-network/marketplace-projector", join(packageRoot, "..", "projector")],
  ["@jinn-network/marketplace-venue-base", join(packageRoot, "..", "venue-base")],
];
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-marketplace-testing-"));
const archivesRoot = join(temporaryRoot, "archives");
const testingArchive = join(archivesRoot, "marketplace-testing.tgz");
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

function assertArchiveShape(entries) {
  for (const required of [
    "package/README.md",
    "package/dist/index.d.ts",
    "package/dist/index.js",
    "package/dist/named-check-fixtures.d.ts",
    "package/dist/named-check-fixtures.js",
    "package/dist/projector-conformance.d.ts",
    "package/dist/projector-conformance.js",
    "package/fixtures/manifest.sha256.json",
    "package/fixtures/projector/golden-events/revised-cross-batch-flow-2026-08-03.json",
    "package/fixtures/projector/golden-events/revised-cross-batch-flow.json",
    "package/fixtures/projector/golden-events/revised-task-created-2026-08-03.json",
    "package/fixtures/projector/golden-events/revised-task-created.json",
    "package/fixtures/projector/reorg-scenarios/revised-task-created-reorg-2026-08-03.json",
    "package/fixtures/projector/reorg-scenarios/revised-task-created-reorg.json",
  ]) {
    if (!entries.includes(required)) {
      throw new Error(`marketplace-testing archive is missing ${required}`);
    }
  }
  const leakedTests = entries.filter(
    (entry) => entry.startsWith("package/dist/") && /(?:^|\/)[^/]*\.(?:test|spec)\./u.test(entry),
  );
  if (leakedTests.length > 0) {
    throw new Error(`marketplace-testing archive contains tests: ${leakedTests.join(", ")}`);
  }
}

try {
  await mkdir(archivesRoot, { recursive: true });
  const archives = new Map();
  for (const [name, root] of dependencyChain) {
    const archive = join(archivesRoot, `${name.replace(/[@/]/g, "-")}.tgz`);
    await run("yarn", ["pack", "--out", archive], { cwd: root });
    archives.set(name, archive);
  }
  await run("yarn", ["pack", "--out", testingArchive], { cwd: packageRoot });
  assertArchiveShape(
    (await output("tar", ["-tzf", testingArchive])).split(/\r?\n/u).filter(Boolean),
  );

  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@jinn-network/marketplace-testing": `file:${testingArchive}`,
        ...Object.fromEntries([...archives].map(([name, archive]) => [name, `file:${archive}`])),
        "@types/node": "^22.0.0",
        typescript: "5.9.3",
        vitest: "4.1.8",
      },
    }),
  );
  await run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--legacy-peer-deps"],
    { cwd: consumer },
  );

  const installedRoot = join(consumer, "node_modules", "@jinn-network", "marketplace-testing");

  await writeFile(
    join(consumer, "packed-types.ts"),
    `import "@jinn-network/marketplace-testing";\nimport "@jinn-network/marketplace-testing/backend-conformance";\nimport "@jinn-network/marketplace-testing/named-check-fixtures";\nimport "@jinn-network/marketplace-testing/projector-conformance";\n`,
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
      include: ["packed-types.ts"],
    }),
  );
  await run(
    process.execPath,
    [join(consumer, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"],
    { cwd: consumer },
  );

  const smokeScript = join(consumer, "smoke.mjs");
  await writeFile(
    smokeScript,
    `
import { readFile, readdir } from "node:fs/promises";
import "@jinn-network/marketplace-testing";
import "@jinn-network/marketplace-testing/backend-conformance";
import "@jinn-network/marketplace-testing/named-check-fixtures";
import "@jinn-network/marketplace-testing/projector-conformance";

const packageJson = JSON.parse(await readFile(${JSON.stringify(join(installedRoot, "package.json"))}, "utf8"));
if (packageJson.peerDependencies?.vitest !== "^4.1.8"
    || packageJson.peerDependenciesMeta?.vitest?.optional !== true) {
  throw new Error("packed optional Vitest peer contract changed");
}
const jinnDependencies = Object.keys(packageJson.dependencies ?? {}).filter((name) => name.startsWith("@jinn-network/")).sort();
const expected = ${JSON.stringify(
      [
        "@jinn-network/evidence-protocol",
        "@jinn-network/marketplace-binding",
        "@jinn-network/marketplace-projector",
        "@jinn-network/marketplace-venue-base",
        "@jinn-network/record-discovery-testing",
        "@jinn-network/task-execution-testing",
        "@jinn-network/trust-testing",
      ].sort(),
    )};
if (jinnDependencies.join(",") !== expected.join(",")) {
  throw new Error("unexpected Jinn dependency boundary: " + jinnDependencies.join(", "));
}
const distFiles = await readdir(${JSON.stringify(join(installedRoot, "dist"))});
if (distFiles.some((name) => name.includes(".test."))) throw new Error("test output leaked into dist");
await readFile(${JSON.stringify(join(installedRoot, "README.md"))});
console.log("Installed marketplace-testing root import, assets, and dependency boundary verified.");
`,
  );
  await run(process.execPath, [smokeScript], { cwd: consumer });
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
