import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { BenchmarkProductError } from "../errors.js";
import {
  BUNDLE_FORMAT,
  buildBundleManifest,
  verifyBundleManifest,
} from "./manifest.js";

let bundleDir: string;

beforeEach(() => {
  bundleDir = mkdtempSync(join(tmpdir(), "bp40-manifest-"));
});

afterEach(() => {
  rmSync(bundleDir, { recursive: true, force: true });
});

function writeFixture(): void {
  mkdirSync(join(bundleDir, "records"), { recursive: true });
  writeFileSync(join(bundleDir, "benchmark.json"), "benchmark\n");
  writeFileSync(join(bundleDir, "records", `${"a".repeat(64)}.bin`), "record\n");
}

describe("portable bundle manifest", () => {
  test("sorts and binds every non-manifest file, excluding bundle.json itself", () => {
    writeFixture();
    const built = buildBundleManifest(bundleDir, [
      `records/${"a".repeat(64)}.bin`,
      "benchmark.json",
    ]);

    expect(built.manifest).toMatchObject({ format: BUNDLE_FORMAT });
    expect(built.manifest.files.map((file) => file.path)).toEqual([
      "benchmark.json",
      `records/${"a".repeat(64)}.bin`,
    ]);
    expect(built.manifest.files.every((file) => file.path !== "bundle.json")).toBe(true);
    expect(built.bytes).toEqual(canonicalJsonBytes(built.manifest));
    expect(built.identity).toMatch(/^[a-f0-9]{64}$/);
  });

  test.each(["", ".", "../escape", "/absolute", "records/../escape", "bundle.json"])(
    "refuses unsafe or reserved path %j",
    (path) => {
      writeFixture();
      expect(() => buildBundleManifest(bundleDir, [path])).toThrow(BenchmarkProductError);
    },
  );

  test("verification rejects duplicate, missing, extra, tampered, and symbolic-link entries", () => {
    writeFixture();
    const built = buildBundleManifest(bundleDir, [
      "benchmark.json",
      `records/${"a".repeat(64)}.bin`,
    ]);
    writeFileSync(join(bundleDir, "bundle.json"), built.bytes);
    expect(verifyBundleManifest(bundleDir).identity).toBe(built.identity);

    const duplicate = {
      ...built.manifest,
      files: [...built.manifest.files, built.manifest.files[0]!],
    };
    writeFileSync(join(bundleDir, "bundle.json"), canonicalJsonBytes(duplicate));
    expect(() => verifyBundleManifest(bundleDir)).toThrowError(/duplicate/i);

    writeFileSync(join(bundleDir, "bundle.json"), built.bytes);
    writeFileSync(join(bundleDir, "unexpected.txt"), "extra\n");
    expect(() => verifyBundleManifest(bundleDir)).toThrowError(/unexpected/i);
    rmSync(join(bundleDir, "unexpected.txt"));

    writeFileSync(join(bundleDir, "benchmark.json"), "tampered\n");
    expect(() => verifyBundleManifest(bundleDir)).toThrowError(/mismatch/i);
    writeFileSync(join(bundleDir, "benchmark.json"), "benchmark\n");

    rmSync(join(bundleDir, "benchmark.json"));
    expect(() => verifyBundleManifest(bundleDir)).toThrowError(/missing/i);
    symlinkSync("records", join(bundleDir, "benchmark.json"));
    expect(() => verifyBundleManifest(bundleDir)).toThrowError(/symbolic link/i);
  });
});
