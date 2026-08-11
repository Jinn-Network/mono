// SPDX-License-Identifier: MIT

import { lstatSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluationHarnessEntrypoint,
  resourceSha256Digest,
} from "./live-swe-rebench-runner.js";

describe("live SWE-rebench runner package resolution", () => {
  it("resolves the ESM-only evaluation harness to its executable", () => {
    const entrypoint = evaluationHarnessEntrypoint();

    expect(basename(entrypoint)).toBe("bin.js");
    expect(lstatSync(realpathSync(entrypoint)).isFile()).toBe(true);
  });

  it("accepts both Task-resource and canonical loadout digest spellings", () => {
    const hex = "a".repeat(64);

    expect(resourceSha256Digest({ digest: { sha256: hex } })).toBe(`sha256:${hex}`);
    expect(resourceSha256Digest({ digest: `sha256:${hex}` })).toBe(`sha256:${hex}`);
    expect(resourceSha256Digest({ digest: hex })).toBeUndefined();
  });
});
