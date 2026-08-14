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
const profilesRoot = join(taskExecutionRoot, "profiles");
const supervisorRoot = join(backendLocalRoot, "supervisor");
const workspaceRoot = join(backendLocalRoot, "workspace");

const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-task-execution-launchers-"));
const archivesRoot = join(temporaryRoot, "archives");
const protocolArchive = join(archivesRoot, "task-execution-protocol.tgz");
const backendArchive = join(archivesRoot, "task-execution-backend.tgz");
const profilesArchive = join(archivesRoot, "task-execution-profiles.tgz");
const supervisorArchive = join(archivesRoot, "task-execution-supervisor.tgz");
const workspaceArchive = join(archivesRoot, "task-execution-workspace.tgz");
const launchersArchive = join(archivesRoot, "task-execution-launchers.tgz");
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
  for (const required of ["package/README.md", "package/dist/index.d.ts", "package/dist/index.js"]) {
    if (!entries.includes(required)) throw new Error(`launchers archive is missing ${required}`);
  }
  const leaked = entries.filter(
    (entry) => entry.startsWith("package/dist/") && /(?:^|\/)[^/]*\.(?:test|spec)\./u.test(entry),
  );
  if (leaked.length > 0) throw new Error(`launchers archive contains tests: ${leaked.join(", ")}`);
  if (entries.includes("package/dist/credential-exec.mjs")) {
    throw new Error("launchers archive must not own the supervisor credential bridge");
  }
}

try {
  await mkdir(archivesRoot, { recursive: true });
  // launchers legitimately depends on protocol, profiles, supervisor, and workspace (portal-
  // resolved in the tree — supervisor's own dependency on backend must also be packed so npm's
  // flat resolution can satisfy it), so the throwaway npm consumer below must resolve all of
  // them from local tarballs — never the registry.
  await run("yarn", ["pack", "--out", protocolArchive], { cwd: protocolRoot });
  await run("yarn", ["pack", "--out", backendArchive], { cwd: backendRoot });
  await run("yarn", ["pack", "--out", profilesArchive], { cwd: profilesRoot });
  await run("yarn", ["pack", "--out", supervisorArchive], { cwd: supervisorRoot });
  await run("yarn", ["pack", "--out", workspaceArchive], { cwd: workspaceRoot });
  await run("yarn", ["pack", "--out", launchersArchive], { cwd: packageRoot });
  assertArchiveShape((await output("tar", ["-tzf", launchersArchive])).split(/\r?\n/u).filter(Boolean));

  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@jinn-network/task-execution-protocol": `file:${protocolArchive}`,
        "@jinn-network/task-execution-backend": `file:${backendArchive}`,
        "@jinn-network/task-execution-profiles": `file:${profilesArchive}`,
        "@jinn-network/task-execution-supervisor": `file:${supervisorArchive}`,
        "@jinn-network/task-execution-workspace": `file:${workspaceArchive}`,
        "@jinn-network/task-execution-launchers": `file:${launchersArchive}`,
        "@types/node": "^22.0.0",
        typescript: "5.9.3",
      },
    }),
  );
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: consumer });

  const installedRoot = join(consumer, "node_modules", "@jinn-network", "task-execution-launchers");

  // Compile-time check: the packed public surface (the A2 contract types) resolves for a
  // NodeNext-strict consumer. `order.ts`/`canonical-json.ts` are backend-internal sealing
  // utilities, never part of the public surface — this consumer never imports them by name.
  await writeFile(
    join(consumer, "packed-types.ts"),
    `
import type {
  BlameRule,
  LaunchPlan,
  LauncherCapabilities,
  LauncherContract,
  ResultContract,
} from "@jinn-network/task-execution-launchers";

declare const plan: LaunchPlan;
declare const contract: LauncherContract;
declare const capabilities: LauncherCapabilities;
declare const rule: BlameRule;
declare const resultContract: ResultContract;
void plan;
void contract;
void capabilities;
void rule;
void resultContract;
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

  // Runtime check: the packed root import works, and the dependency boundary is exactly
  // protocol+profiles+supervisor+workspace.
  const smokeScript = join(consumer, "smoke.mjs");
  await writeFile(
    smokeScript,
    `
import { readFile, readdir } from "node:fs/promises";
await import("@jinn-network/task-execution-launchers");

const packageJson = JSON.parse(await readFile(${JSON.stringify(join(installedRoot, "package.json"))}, "utf8"));
const jinnDependencies = Object.keys(packageJson.dependencies ?? {}).filter((name) => name.startsWith("@jinn-network/")).sort();
const expected = [
  "@jinn-network/task-execution-profiles",
  "@jinn-network/task-execution-protocol",
  "@jinn-network/task-execution-supervisor",
  "@jinn-network/task-execution-workspace",
].sort();
if (jinnDependencies.join(",") !== expected.join(",")) {
  throw new Error("unexpected Jinn dependency boundary: " + jinnDependencies.join(", "));
}
const distFiles = await readdir(${JSON.stringify(join(installedRoot, "dist"))});
if (distFiles.some((name) => name.includes(".test."))) throw new Error("test output leaked into dist");
await readFile(${JSON.stringify(join(installedRoot, "README.md"))});
console.log("Installed launchers root import, assets, and dependency boundary verified.");
`,
  );
  await run(process.execPath, [smokeScript], { cwd: consumer });
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
