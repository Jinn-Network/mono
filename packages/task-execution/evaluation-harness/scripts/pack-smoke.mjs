import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const taskExecutionRoot = resolve(packageRoot, "..");
const packagesRoot = resolve(taskExecutionRoot, "..");
const evidenceRoot = join(packagesRoot, "evidence");

const packageInputs = [
  [join(evidenceRoot, "protocol"), "@jinn-network/evidence-protocol"],
  [join(evidenceRoot, "repository"), "@jinn-network/evidence-repository"],
  [join(evidenceRoot, "attestation-issuer"), "@jinn-network/attestation-issuer"],
  [join(taskExecutionRoot, "protocol"), "@jinn-network/task-execution-protocol"],
  [join(taskExecutionRoot, "backend"), "@jinn-network/task-execution-backend"],
  [join(taskExecutionRoot, "profiles"), "@jinn-network/task-execution-profiles"],
  [join(taskExecutionRoot, "backend-local", "supervisor"), "@jinn-network/task-execution-supervisor"],
  [join(taskExecutionRoot, "backend-local", "workspace"), "@jinn-network/task-execution-workspace"],
  [join(taskExecutionRoot, "backend-local", "launchers"), "@jinn-network/task-execution-launchers"],
  [packageRoot, "@jinn-network/task-execution-evaluation-harness"],
];

const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-evaluation-harness-"));
const archivesRoot = join(temporaryRoot, "archives");
const consumerRoot = join(temporaryRoot, "consumer");

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

function output(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const stdout = [];
    const stderr = [];
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolvePromise(Buffer.concat(stdout).toString("utf8"));
      } else {
        reject(new Error(
          `${command} exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`,
        ));
      }
    });
  });
}

try {
  await mkdir(archivesRoot, { recursive: true });
  const archives = new Map();
  for (const [root, name] of packageInputs) {
    const archive = join(
      archivesRoot,
      `${name.slice("@jinn-network/".length)}.tgz`,
    );
    await run("yarn", ["pack", "--out", archive], { cwd: root });
    archives.set(name, archive);
  }

  const harnessArchive = archives.get(
    "@jinn-network/task-execution-evaluation-harness",
  );
  const entries = (await output("tar", ["-tzf", harnessArchive]))
    .split(/\r?\n/u)
    .filter(Boolean);
  for (const required of [
    "package/README.md",
    "package/dist/index.d.ts",
    "package/dist/index.js",
  ]) {
    if (!entries.includes(required)) {
      throw new Error(`evaluation-harness archive is missing ${required}`);
    }
  }
  if (entries.some((entry) => /(?:^|\/)[^/]*\.(?:test|spec)\./u.test(entry))) {
    throw new Error("evaluation-harness archive contains tests");
  }

  await mkdir(consumerRoot);
  await writeFile(
    join(consumerRoot, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        ...Object.fromEntries(
          [...archives].map(([name, archive]) => [name, `file:${archive}`]),
        ),
        "@types/node": "^22.0.0",
        typescript: "5.9.3",
      },
    }),
  );
  await run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: consumerRoot },
  );

  await writeFile(
    join(consumerRoot, "packed-types.ts"),
    `
import type {
  CompletedEvaluation,
  EvaluatorAdapter,
  EvaluatorRegistration,
  EvaluationOperationalError,
} from "@jinn-network/task-execution-evaluation-harness";

declare const completed: CompletedEvaluation;
declare const adapter: EvaluatorAdapter;
declare const registration: EvaluatorRegistration;
declare const failure: EvaluationOperationalError;
void completed;
void adapter;
void registration;
void failure;
`,
  );
  await writeFile(
    join(consumerRoot, "tsconfig.json"),
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
    [
      join(consumerRoot, "node_modules", "typescript", "bin", "tsc"),
      "-p",
      "tsconfig.json",
    ],
    { cwd: consumerRoot },
  );

  const installedRoot = join(
    consumerRoot,
    "node_modules",
    "@jinn-network",
    "task-execution-evaluation-harness",
  );
  const smokeScript = join(consumerRoot, "smoke.mjs");
  await writeFile(
    smokeScript,
    `
import { readFile, readdir } from "node:fs/promises";
const harness = await import("@jinn-network/task-execution-evaluation-harness");
if (typeof harness.validateCompletedEvaluation !== "function") {
  throw new Error("root runtime exports are incomplete");
}
const packageJson = JSON.parse(await readFile(${JSON.stringify(join(installedRoot, "package.json"))}, "utf8"));
const actual = Object.keys(packageJson.dependencies ?? {}).filter((name) => name.startsWith("@jinn-network/")).sort();
const expected = ${JSON.stringify([
  "@jinn-network/attestation-issuer",
  "@jinn-network/evidence-protocol",
  "@jinn-network/task-execution-launchers",
  "@jinn-network/task-execution-profiles",
  "@jinn-network/task-execution-supervisor",
  "@jinn-network/task-execution-workspace",
].sort())};
if (actual.join(",") !== expected.join(",")) {
  throw new Error("unexpected Jinn dependency boundary: " + actual.join(", "));
}
const distFiles = await readdir(${JSON.stringify(join(installedRoot, "dist"))});
if (distFiles.some((name) => name.includes(".test."))) {
  throw new Error("test output leaked into dist");
}
await readFile(${JSON.stringify(join(installedRoot, "README.md"))});
console.log("Installed evaluation-harness contracts and dependency boundary verified.");
`,
  );
  await run(process.execPath, [smokeScript], { cwd: consumerRoot });
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
