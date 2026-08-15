import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "jinn-record-publication-"));
const archive = join(temporary, "package.tgz");
const protocolArchive = join(temporary, "protocol.tgz");
const serveArchive = join(temporary, "serve.tgz");
const trustArchive = join(temporary, "trust.tgz");
function run(command, args, cwd) { return new Promise((resolve, reject) => { const child = spawn(command, args, { cwd, stdio: "inherit" }); child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))); }); }
try {
  await run("npm", ["pack", "--ignore-scripts", "--pack-destination", temporary], join(root, "../../trust/core"));
  await run("npm", ["pack", "--ignore-scripts", "--pack-destination", temporary], join(root, "../protocol"));
  await run("npm", ["pack", "--ignore-scripts", "--pack-destination", temporary], join(root, "../serve"));
  const packed = await (await import("node:fs/promises")).readdir(temporary);
  const archiveNamed = (needle) => join(temporary, packed.find((name) => name.includes(needle) && name.endsWith(".tgz")));
  await (await import("node:fs/promises")).rename(archiveNamed("trust-core"), trustArchive);
  await (await import("node:fs/promises")).rename(archiveNamed("record-discovery-protocol"), protocolArchive);
  await (await import("node:fs/promises")).rename(archiveNamed("record-discovery-serve"), serveArchive);
  await run("corepack", ["yarn@4.13.0", "pack", "--out", archive], root);
  await mkdir(join(temporary, "consumer"));
  await writeFile(join(temporary, "consumer/package.json"), JSON.stringify({ private: true, type: "module", dependencies: {
    "@jinn-network/trust-core": `file:${trustArchive}`,
    "@jinn-network/record-discovery-protocol": `file:${protocolArchive}`,
    "@jinn-network/record-discovery-serve": `file:${serveArchive}`,
    "@jinn-network/record-publication": `file:${archive}`
  } }));
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], join(temporary, "consumer"));
  await writeFile(join(temporary, "consumer/smoke.mjs"), 'import { executePublicationPlan, createDiscoverySourceAnnouncementPort } from "@jinn-network/record-publication"; if (typeof executePublicationPlan !== "function" || typeof createDiscoverySourceAnnouncementPort !== "function") throw new Error("public API missing");');
  await run(process.execPath, ["smoke.mjs"], join(temporary, "consumer"));
  await readFile(join(temporary, "consumer/node_modules/@jinn-network/record-publication/README.md"));
} finally { await rm(temporary, { recursive: true, force: true }); }
