// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createProfileAssets } from "./profile-assets.mjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const profileRoot = parseProfileRoot(process.argv.slice(2));
const stale = [];

for (const [relativePath, expected] of createProfileAssets()) {
  let actual;
  try {
    actual = new Uint8Array(
      await readFile(join(profileRoot, relativePath)),
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
    `IPFS registration profile assets are stale:\n${stale.join("\n")}`,
  );
}

console.log("IPFS registration schema and golden fixtures are byte-current.");

function parseProfileRoot(arguments_) {
  if (arguments_.length === 0) return join(packageRoot, "profile");
  if (
    arguments_.length === 2 &&
    arguments_[0] === "--profile-root" &&
    arguments_[1].length > 0
  ) {
    return arguments_[1];
  }
  throw new Error("Usage: check-profile.mjs [--profile-root <directory>]");
}
