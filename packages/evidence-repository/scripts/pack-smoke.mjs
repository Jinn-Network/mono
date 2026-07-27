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
const protocolRoot = join(packageRoot, "..", "evidence-protocol");
const temporaryRoot = await mkdtemp(
  join(tmpdir(), "jinn-evidence-repository-"),
);
const repositoryArchive = join(temporaryRoot, "evidence-repository.tgz");
const protocolArchive = join(temporaryRoot, "evidence-protocol.tgz");
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
  await run("yarn", ["pack", "--out", protocolArchive], {
    cwd: protocolRoot,
  });
  await run("yarn", ["pack", "--out", repositoryArchive], {
    cwd: packageRoot,
  });

  await writeFile(
    join(temporaryRoot, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@jinn-network/evidence-protocol": `file:${protocolArchive}`,
        "@jinn-network/evidence-repository": `file:${repositoryArchive}`,
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
    "evidence-repository",
  );
  const smokeScript = join(consumer, "smoke.mjs");
  await writeFile(
    smokeScript,
    `
import { readFile } from "node:fs/promises";
import {
  EVIDENCE_RECORD_FAMILIES,
  createArtifactReference,
  createRecordReference,
} from "@jinn-network/evidence-repository";

const bytes = new TextEncoder().encode("packed repository");
const record = createRecordReference("execution-evidence", bytes);
const artifact = createArtifactReference(bytes);
if (record.digest !== artifact.digest) throw new Error("root import failed");
if (EVIDENCE_RECORD_FAMILIES.length !== 3) throw new Error("families missing");
await readFile(new URL(import.meta.resolve("@jinn-network/evidence-repository/testing")));
const packageJson = JSON.parse(await readFile(${JSON.stringify(join(installedRoot, "package.json"))}, "utf8"));
const jinnDependencies = Object.keys(packageJson.dependencies ?? {}).filter((name) => name.startsWith("@jinn-network/"));
if (jinnDependencies.join(",") !== "@jinn-network/evidence-protocol") {
  throw new Error("unexpected Jinn dependency boundary: " + jinnDependencies.join(", "));
}
await readFile(${JSON.stringify(join(installedRoot, "README.md"))});
await readFile(${JSON.stringify(join(installedRoot, "specification.md"))});
console.log("Installed repository contract imports, assets, and dependency boundary verified.");
`,
  );
  await run(process.execPath, [smokeScript], { cwd: consumer });
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
