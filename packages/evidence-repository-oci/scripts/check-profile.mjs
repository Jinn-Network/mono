import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createProfileAssets } from "./profile-assets.mjs";

const packageRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const stale = [];

for (const [relativePath, expected] of createProfileAssets()) {
  let actual;
  try {
    actual = new Uint8Array(
      await readFile(join(packageRoot, relativePath)),
    );
  } catch {
    stale.push(`${relativePath} (missing)`);
    continue;
  }
  if (!Buffer.from(actual).equals(Buffer.from(expected))) {
    stale.push(relativePath);
  }
}

if (stale.length > 0) {
  throw new Error(
    `OCI profile assets are stale. Run yarn generate:profile:\n${stale.join("\n")}`,
  );
}

console.log("OCI profile schema and golden fixtures are byte-current.");
