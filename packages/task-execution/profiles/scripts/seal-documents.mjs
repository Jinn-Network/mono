// Regenerates the sealed v1 profile documents under `profiles/task-profiles/` from the builders
// in `dist/` (run after `yarn build`; see `package.json`'s `check:documents`/`generate:documents`).
// `--write` seals every builder's output to `profile.json` (raw, no-indentation, no-trailing-
// newline JCS bytes per program §7.1) and its pinned digest to `profile.sha256`; `--check` fails
// on drift. Mirrors evidence's `generate-profile.mjs` --write/--check convention.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sealTaskProfile } from "../dist/task-profile/seal.js";
import { buildRepositoryWorkProfile } from "../dist/documents/repository-work-1.0.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];

if (mode !== "--write" && mode !== "--check") {
  throw new Error("Expected --write or --check");
}

const DOCUMENTS = [
  {
    dir: join("profiles", "task-profiles", "repository-work", "1.0"),
    build: buildRepositoryWorkProfile,
  },
];

const drift = [];

for (const { dir, build } of DOCUMENTS) {
  const { bytes, digest } = sealTaskProfile(build());
  const jsonPath = join(packageRoot, dir, "profile.json");
  const shaPath = join(packageRoot, dir, "profile.sha256");
  const shaText = `${digest}\n`;

  if (mode === "--write") {
    await mkdir(join(packageRoot, dir), { recursive: true });
    await writeFile(jsonPath, bytes);
    await writeFile(shaPath, shaText);
    continue;
  }

  const [actualJson, actualSha] = await Promise.all([
    readFile(jsonPath).catch(() => undefined),
    readFile(shaPath, "utf8").catch(() => undefined),
  ]);
  if (actualJson === undefined || Buffer.compare(Buffer.from(actualJson), Buffer.from(bytes)) !== 0) {
    drift.push(`${dir}/profile.json is out of date or missing`);
  }
  if (actualSha !== shaText) {
    drift.push(`${dir}/profile.sha256 is out of date or missing`);
  }
}

if (drift.length > 0) {
  throw new Error(`Sealed document drift:\n- ${drift.join("\n- ")}`);
}

console.log(
  mode === "--write"
    ? `Wrote ${DOCUMENTS.length} sealed profile document(s).`
    : `Checked ${DOCUMENTS.length} sealed profile document(s).`,
);
