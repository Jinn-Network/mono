import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const backendLocalRoot = join(packageRoot, "..");
const taskExecutionRoot = join(backendLocalRoot, "..");
const protocolRoot = join(taskExecutionRoot, "protocol");
const backendRoot = join(taskExecutionRoot, "backend");

const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-task-execution-supervisor-"));
const archivesRoot = join(temporaryRoot, "archives");
const protocolArchive = join(archivesRoot, "task-execution-protocol.tgz");
const backendArchive = join(archivesRoot, "task-execution-backend.tgz");
const supervisorArchive = join(archivesRoot, "task-execution-supervisor.tgz");
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
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else reject(new Error(`${command} exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
    });
  });
}

function assertArchiveShape(entries) {
  for (const required of ["package/README.md", "package/dist/index.d.ts", "package/dist/index.js", "package/dist/credential-exec.mjs"]) {
    if (!entries.includes(required)) throw new Error(`supervisor archive is missing ${required}`);
  }
  const leaked = entries.filter(
    (entry) => entry.startsWith("package/dist/") && /(?:^|\/)[^/]*\.(?:test|spec)\./u.test(entry),
  );
  if (leaked.length > 0) throw new Error(`supervisor archive contains tests: ${leaked.join(", ")}`);
}

try {
  await mkdir(archivesRoot, { recursive: true });
  await run("yarn", ["pack", "--out", protocolArchive], { cwd: protocolRoot });
  await run("yarn", ["pack", "--out", backendArchive], { cwd: backendRoot });
  await run("yarn", ["pack", "--out", supervisorArchive], { cwd: packageRoot });
  assertArchiveShape((await output("tar", ["-tzf", supervisorArchive])).split(/\r?\n/u).filter(Boolean));

  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@jinn-network/task-execution-protocol": `file:${protocolArchive}`,
        "@jinn-network/task-execution-backend": `file:${backendArchive}`,
        "@jinn-network/task-execution-supervisor": `file:${supervisorArchive}`,
        "@types/node": "^22.0.0",
        typescript: "5.9.3",
      },
    }),
  );
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: consumer });

  const installedRoot = join(consumer, "node_modules", "@jinn-network", "task-execution-supervisor");

  // Compile-time check: the packed public surface (the A2 contract types) resolves for a
  // NodeNext-strict consumer. `order.ts`/`canonical-json.ts` are backend-internal sealing
  // utilities, never part of the public surface (unlike protocol's, which sign TEP documents
  // other packages must reproduce) — so this consumer never imports them by name.
  await writeFile(
    join(consumer, "packed-types.ts"),
    `
import type { AttemptIdentity, SpawnRequest } from "@jinn-network/task-execution-supervisor";

declare const identity: AttemptIdentity;
declare const request: SpawnRequest;
void identity;
void request;
`,
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

  // Runtime check: the packed root import resolves, and the dependency boundary is exactly protocol+backend.
  const smokeScript = join(consumer, "smoke.mjs");
  await writeFile(
    smokeScript,
    `
import { readFile, readdir } from "node:fs/promises";
await import("@jinn-network/task-execution-supervisor");

const packageJson = JSON.parse(await readFile(${JSON.stringify(join(installedRoot, "package.json"))}, "utf8"));
const jinnDependencies = Object.keys(packageJson.dependencies ?? {}).filter((name) => name.startsWith("@jinn-network/")).sort();
if (jinnDependencies.join(",") !== "@jinn-network/task-execution-backend,@jinn-network/task-execution-protocol") {
  throw new Error("unexpected Jinn dependency boundary: " + jinnDependencies.join(", "));
}
const distFiles = await readdir(${JSON.stringify(join(installedRoot, "dist"))});
if (distFiles.some((name) => name.includes(".test."))) throw new Error("test output leaked into dist");
await readFile(${JSON.stringify(join(installedRoot, "README.md"))});
console.log("Installed supervisor root import, assets, and dependency boundary verified.");
`,
  );
  await run(process.execPath, [smokeScript], { cwd: consumer });
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
