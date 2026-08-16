import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
// Cross-tree + sibling portal dependencies (§7.8), packed in dependency order (leaves first).
// Runtime closure: pipeline's four direct deps (binding, backend, backend-local, protocol) plus
// backend-local assembly's evidence contract slice and binding's trust-{core,resolve} — mirrors
// marketplace-packed-types / marketplace-testing pack-smoke, trimmed to this package's runtime
// boundary (no record-discovery, task-execution-testing, or trust-testing).
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
  ["@jinn-network/trust-core", join(packageRoot, "..", "..", "trust", "core")],
  ["@jinn-network/trust-resolve", join(packageRoot, "..", "..", "trust", "resolve")],
  ["@jinn-network/marketplace-binding", join(packageRoot, "..", "binding")],
];
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-marketplace-pipeline-"));
const archivesRoot = join(temporaryRoot, "archives");
const pipelineArchive = join(archivesRoot, "marketplace-pipeline.tgz");
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
  for (const required of ["package/README.md", "package/dist/index.d.ts", "package/dist/index.js"]) {
    if (!entries.includes(required)) {
      throw new Error(`marketplace-pipeline archive is missing ${required}`);
    }
  }
  const leakedTests = entries.filter(
    (entry) => entry.startsWith("package/dist/") && /(?:^|\/)[^/]*\.(?:test|spec)\./u.test(entry),
  );
  if (leakedTests.length > 0) {
    throw new Error(`marketplace-pipeline archive contains tests: ${leakedTests.join(", ")}`);
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
  await run("yarn", ["pack", "--out", pipelineArchive], { cwd: packageRoot });
  assertArchiveShape(
    (await output("tar", ["-tzf", pipelineArchive])).split(/\r?\n/u).filter(Boolean),
  );

  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@jinn-network/marketplace-pipeline": `file:${pipelineArchive}`,
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

  const installedRoot = join(consumer, "node_modules", "@jinn-network", "marketplace-pipeline");

  await writeFile(
    join(consumer, "packed-types.ts"),
    `import "@jinn-network/marketplace-pipeline";\n`,
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
import "@jinn-network/marketplace-pipeline";

const packageJson = JSON.parse(await readFile(${JSON.stringify(join(installedRoot, "package.json"))}, "utf8"));
const jinnDependencies = Object.keys(packageJson.dependencies ?? {}).filter((name) => name.startsWith("@jinn-network/")).sort();
const expected = ${JSON.stringify(
      [
        "@jinn-network/marketplace-binding",
        "@jinn-network/task-execution-backend",
        "@jinn-network/task-execution-backend-local",
        "@jinn-network/task-execution-protocol",
      ].sort(),
    )};
if (jinnDependencies.join(",") !== expected.join(",")) {
  throw new Error("unexpected Jinn dependency boundary: " + jinnDependencies.join(", "));
}
const distFiles = await readdir(${JSON.stringify(join(installedRoot, "dist"))});
if (distFiles.some((name) => name.includes(".test."))) throw new Error("test output leaked into dist");
await readFile(${JSON.stringify(join(installedRoot, "README.md"))});
console.log("Installed marketplace-pipeline root import, assets, and dependency boundary verified.");
`,
  );
  await run(process.execPath, [smokeScript], { cwd: consumer });
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
