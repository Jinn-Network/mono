import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(root, "..", "..", "..");
const temporary = await mkdtemp(join(tmpdir(), "jinn-benchmarking-publication-"));
function run(command, args, options = {}) { return new Promise((resolve, reject) => { const child = spawn(command, args, { stdio: "inherit", ...options }); child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))); }); }
async function build(directory) { await run("yarn", ["build"], { cwd: directory }); }
async function pack(directory, name) { const archive = join(temporary, name); const destination = join(temporary, `${name}.pack`); await mkdir(destination); await run("npm", ["pack", "--ignore-scripts", "--pack-destination", destination], { cwd: directory }); const { readdir, rename } = await import("node:fs/promises"); const found = (await readdir(destination)).find((entry) => entry.endsWith(".tgz")); if (found === undefined) throw new Error(`no archive for ${directory}`); await rename(join(destination, found), archive); return archive; }
try {
  const protocolRoot = join(repo, "packages/task-execution/protocol"); const trustRoot = join(repo, "packages/trust/core");
  const recordsRoot = join(repo, "packages/benchmarking/records"); const discoveryProtocolRoot = join(repo, "packages/discovery/protocol");
  const discoveryServeRoot = join(repo, "packages/discovery/serve"); const publicationRoot = join(repo, "packages/discovery/publication");
  for (const directory of [protocolRoot, trustRoot, discoveryProtocolRoot, discoveryServeRoot, recordsRoot, publicationRoot, root]) await build(directory);
  const protocol = await pack(protocolRoot, "protocol.tgz");
  const trust = await pack(trustRoot, "trust-core.tgz");
  const records = await pack(recordsRoot, "records.tgz");
  const discoveryProtocol = await pack(discoveryProtocolRoot, "discovery-protocol.tgz");
  const discoveryServe = await pack(discoveryServeRoot, "discovery-serve.tgz");
  const publication = await pack(publicationRoot, "record-publication.tgz");
  const benchmarkPublication = await pack(root, "benchmarking-publication.tgz");
  const consumer = join(temporary, "consumer"); await mkdir(consumer);
  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: {
    "@jinn-network/task-execution-protocol": `file:${protocol}`, "@jinn-network/trust-core": `file:${trust}`, "@jinn-network/benchmarking-records": `file:${records}`,
    "@jinn-network/record-discovery-protocol": `file:${discoveryProtocol}`, "@jinn-network/record-discovery-serve": `file:${discoveryServe}`,
    "@jinn-network/record-publication": `file:${publication}`, "@jinn-network/benchmarking-publication": `file:${benchmarkPublication}`,
  } }));
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: consumer });
  await writeFile(join(consumer, "smoke.mjs"), 'import { buildBenchmarkPublicationPlan, buildObservationArchive, verifyBenchmarkAccounting } from "@jinn-network/benchmarking-publication"; if (![buildBenchmarkPublicationPlan, buildObservationArchive, verifyBenchmarkAccounting].every((value) => typeof value === "function")) throw new Error("public API missing");');
  await run(process.execPath, [join(consumer, "smoke.mjs")], { cwd: consumer });
} finally { await rm(temporary, { recursive: true, force: true }); }
