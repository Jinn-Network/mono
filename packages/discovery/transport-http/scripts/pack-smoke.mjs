import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
// Cross-tree portal dependencies (§7.8): transport-http depends on
// protocol + serve + client; protocol depends on trust-core and client
// depends on trust-core too, so all four must be packed and file:-mapped
// for the consumer graph to resolve end-to-end.
const protocolRoot = join(packageRoot, "..", "protocol");
const serveRoot = join(packageRoot, "..", "serve");
const clientRoot = join(packageRoot, "..", "client");
const trustCoreRoot = join(packageRoot, "..", "..", "trust", "core");
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-record-discovery-transport-http-"));
const archive = join(temporaryRoot, "record-discovery-transport-http.tgz");
const protocolArchive = join(temporaryRoot, "record-discovery-protocol.tgz");
const serveArchive = join(temporaryRoot, "record-discovery-serve.tgz");
const clientArchive = join(temporaryRoot, "record-discovery-client.tgz");
const trustCoreArchive = join(temporaryRoot, "trust-core.tgz");
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

async function packPortal(root, out) {
  await run("corepack", ["yarn@4.13.0", "install", "--immutable"], { cwd: root });
  await run("corepack", ["yarn@4.13.0", "pack", "--out", out], { cwd: root });
}

try {
  await packPortal(trustCoreRoot, trustCoreArchive);
  await packPortal(protocolRoot, protocolArchive);
  await packPortal(serveRoot, serveArchive);
  await packPortal(clientRoot, clientArchive);
  await packPortal(packageRoot, archive);

  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@jinn-network/trust-core": `file:${trustCoreArchive}`,
        "@jinn-network/record-discovery-protocol": `file:${protocolArchive}`,
        "@jinn-network/record-discovery-serve": `file:${serveArchive}`,
        "@jinn-network/record-discovery-client": `file:${clientArchive}`,
        "@jinn-network/record-discovery-transport-http": `file:${archive}`,
      },
    }),
  );
  await run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: consumer },
  );

  const installedRoot = join(
    consumer,
    "node_modules",
    "@jinn-network",
    "record-discovery-transport-http",
  );
  const smokeScript = join(consumer, "smoke.mjs");
  await writeFile(
    smokeScript,
    `
import { readFile, readdir } from "node:fs/promises";
import * as transportHttp from "@jinn-network/record-discovery-transport-http";

if (typeof transportHttp.createFsBlobStore !== "function") throw new Error("createFsBlobStore missing");
if (typeof transportHttp.createArchiveHttpHandler !== "function") throw new Error("createArchiveHttpHandler missing");
if (typeof transportHttp.createHttpTransport !== "function") throw new Error("createHttpTransport missing");
if (typeof transportHttp.createSseStreamTransport !== "function") throw new Error("createSseStreamTransport missing");
const packageJson = JSON.parse(await readFile(${JSON.stringify(join(installedRoot, "package.json"))}, "utf8"));
const jinnDependencies = Object.keys(packageJson.dependencies ?? {}).filter((name) => name.startsWith("@jinn-network/"));
const expectedJinnDependencies = [
  "@jinn-network/record-discovery-client",
  "@jinn-network/record-discovery-protocol",
  "@jinn-network/record-discovery-serve",
];
if (jinnDependencies.length !== expectedJinnDependencies.length
    || jinnDependencies.some((name) => !expectedJinnDependencies.includes(name))) {
  throw new Error("unexpected Jinn coupling: " + jinnDependencies.join(", "));
}
const distFiles = await readdir(${JSON.stringify(join(installedRoot, "dist"))});
if (distFiles.some((name) => name.includes(".test."))) throw new Error("test output leaked into dist");
await readFile(${JSON.stringify(join(installedRoot, "README.md"))});
console.log("Installed package imports, dependency boundary, and dist shape verified.");
`,
  );
  await run(process.execPath, [smokeScript], { cwd: temporaryRoot });
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
