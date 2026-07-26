// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, test } from "vitest";

import {
  MAX_STANDARD_IPFS_BLOCK_BYTES,
  buildArtifactRegistrationBytes,
  createGatewayBlockReader,
  digestToRawCid,
} from "./index.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("IPFS repository package boundary", () => {
  test("exports the profile and reader primitives from the root", () => {
    assert.equal(MAX_STANDARD_IPFS_BLOCK_BYTES, 2 * 1024 * 1024);
    assert.equal(typeof digestToRawCid, "function");
    assert.equal(typeof buildArtifactRegistrationBytes, "function");
    assert.equal(typeof createGatewayBlockReader, "function");
  });

  test("declares only Repository as a runtime Jinn dependency", async () => {
    const packageJson = JSON.parse(
      await readFile(join(packageRoot, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      resolutions?: Record<string, string>;
    };
    const runtimeJinnDependencies = Object.keys(
      packageJson.dependencies ?? {},
    ).filter((name) => name.startsWith("@jinn-network/"));

    assert.deepEqual(runtimeJinnDependencies, [
      "@jinn-network/evidence-repository",
    ]);
    assert.equal(
      packageJson.devDependencies?.["@jinn-network/evidence-protocol"],
      "0.1.0",
    );
    assert.equal(
      packageJson.resolutions?.["@jinn-network/evidence-protocol"],
      "portal:../protocol",
    );
    assert.equal(
      packageJson.resolutions?.["@jinn-network/evidence-repository"],
      "portal:../repository",
    );
  });
});
