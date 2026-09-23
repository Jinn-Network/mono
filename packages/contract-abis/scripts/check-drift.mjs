import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest } from "./lib.mjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = loadManifest();
const contractsDir = join(packageRoot, manifest.contractsDir);
const committedRoot = join(packageRoot, "generated");
// The TypeScript slices under src/generated/slices are what consumers actually
// compile into dist/, so the gate has to diff them alongside the JSON (#3121).
const committedTsSliceRoot = join(packageRoot, "src", "generated", "slices");

function compileContracts() {
  const result = spawnSync("yarn", ["compile"], {
    cwd: contractsDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`contracts compile failed with exit ${result.status}`);
  }
}

function walkFiles(dir, extension, base = dir) {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(path, extension, base));
    } else if (entry.isFile() && entry.name.endsWith(extension)) {
      files.push(relative(base, path));
    }
  }
  return files.sort();
}

/**
 * Compare one fresh tree against one committed tree, appending to `drift`.
 * Returns the number of distinct files considered.
 */
function diffTree(freshRoot, committedRoot_, extension, label, drift) {
  const freshFiles = walkFiles(freshRoot, extension);
  const committedFiles = walkFiles(committedRoot_, extension);
  const allFiles = [...new Set([...freshFiles, ...committedFiles])].sort();
  for (const file of allFiles) {
    let fresh;
    let committed;
    try {
      fresh = readFileSync(join(freshRoot, file), "utf8");
    } catch {
      drift.push(`missing fresh ${label}/${file}`);
      continue;
    }
    try {
      committed = readFileSync(join(committedRoot_, file), "utf8");
    } catch {
      drift.push(`missing committed ${label}/${file}`);
      continue;
    }
    if (fresh !== committed) {
      drift.push(`drift ${label}/${file}`);
    }
  }
  return allFiles.length;
}

compileContracts();

const tempRoot = mkdtempSync(join(tmpdir(), "contract-abis-drift-"));
try {
  const generate = spawnSync(process.execPath, [
    join(packageRoot, "scripts/generate.mjs"),
    tempRoot,
  ], {
    cwd: packageRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (generate.status !== 0) {
    process.stderr.write(generate.stdout ?? "");
    process.stderr.write(generate.stderr ?? "");
    throw new Error(`generate failed with exit ${generate.status}`);
  }

  /** @type {string[]} */
  const drift = [];
  const jsonCount = diffTree(tempRoot, committedRoot, ".json", "generated", drift);
  const tsCount = diffTree(
    join(tempRoot, "ts-slices"),
    committedTsSliceRoot,
    ".ts",
    "src/generated/slices",
    drift,
  );

  if (drift.length > 0) {
    console.error("ABI drift detected:");
    for (const line of drift) console.error(`  - ${line}`);
    console.error("Run: cd packages/contract-abis && yarn generate");
    process.exit(1);
  }

  console.log(`ABI drift check passed (${jsonCount} JSON, ${tsCount} TypeScript)`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
