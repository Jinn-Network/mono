import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createProfileAssets } from "./profile-assets.mjs";

const packageRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

for (const [relativePath, bytes] of createProfileAssets()) {
  const path = join(packageRoot, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

console.log("Generated OCI profile schema and golden fixtures.");
