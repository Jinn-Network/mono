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

function walkJsonFiles(dir, base = dir) {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkJsonFiles(path, base));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(relative(base, path));
    }
  }
  return files.sort();
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

  const freshFiles = walkJsonFiles(tempRoot);
  const committedFiles = walkJsonFiles(committedRoot);
  const allFiles = [...new Set([...freshFiles, ...committedFiles])].sort();

  /** @type {string[]} */
  const drift = [];
  for (const file of allFiles) {
    const freshPath = join(tempRoot, file);
    const committedPath = join(committedRoot, file);
    let fresh;
    let committed;
    try {
      fresh = readFileSync(freshPath, "utf8");
    } catch {
      drift.push(`missing fresh ${file}`);
      continue;
    }
    try {
      committed = readFileSync(committedPath, "utf8");
    } catch {
      drift.push(`missing committed ${file}`);
      continue;
    }
    if (fresh !== committed) {
      drift.push(`drift ${file}`);
    }
  }

  if (drift.length > 0) {
    console.error("ABI drift detected:");
    for (const line of drift) console.error(`  - ${line}`);
    console.error("Run: cd packages/contract-abis && yarn generate");
    process.exit(1);
  }

  console.log(`ABI drift check passed (${allFiles.length} files)`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
