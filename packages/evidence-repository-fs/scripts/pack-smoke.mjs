import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = join(packageRoot, "..");
const temporaryRoot = await mkdtemp(
  join(tmpdir(), "jinn-evidence-repository-fs-"),
);
const protocolArchive = join(temporaryRoot, "evidence-protocol.tgz");
const contractArchive = join(temporaryRoot, "evidence-repository.tgz");
const filesystemArchive = join(
  temporaryRoot,
  "evidence-repository-fs.tgz",
);
const consumer = join(temporaryRoot, "consumer");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...options,
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

try {
  for (const [directory, archive] of [
    ["evidence-protocol", protocolArchive],
    ["evidence-repository", contractArchive],
    ["evidence-repository-fs", filesystemArchive],
  ]) {
    await run("yarn", ["pack", "--out", archive], {
      cwd: join(packagesRoot, directory),
    });
  }

  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@jinn-network/evidence-protocol": `file:${protocolArchive}`,
        "@jinn-network/evidence-repository": `file:${contractArchive}`,
        "@jinn-network/evidence-repository-fs": `file:${filesystemArchive}`,
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
    "evidence-repository-fs",
  );
  const smokeScript = join(consumer, "smoke.mjs");
  await writeFile(
    smokeScript,
    `
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFilesystemEvidenceRepository } from "@jinn-network/evidence-repository-fs";

const rootDir = await mkdtemp(join(tmpdir(), "jinn-packed-fs-"));
try {
  const repository = await createFilesystemEvidenceRepository({ rootDir });
  const bytes = new TextEncoder().encode("packed filesystem repository");
  const receipt = await repository.putRecord("execution-evidence", bytes);
  const retrieved = await repository.getRecord(receipt.reference);
  if (!retrieved || !Buffer.from(retrieved).equals(Buffer.from(bytes))) {
    throw new Error("packed filesystem round trip failed");
  }
  const packageJson = JSON.parse(await readFile(${JSON.stringify(join(installedRoot, "package.json"))}, "utf8"));
  const jinnDependencies = Object.keys(packageJson.dependencies ?? {}).filter((name) => name.startsWith("@jinn-network/"));
  if (jinnDependencies.join(",") !== "@jinn-network/evidence-repository") {
    throw new Error("unexpected Jinn dependency boundary: " + jinnDependencies.join(", "));
  }
  await readFile(${JSON.stringify(join(installedRoot, "README.md"))});
  console.log("Installed filesystem repository imports, assets, and exact-byte round trip verified.");
} finally {
  await rm(rootDir, { recursive: true, force: true });
}
`,
  );
  await run(process.execPath, [smokeScript], { cwd: consumer });
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
