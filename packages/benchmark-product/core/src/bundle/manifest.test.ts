import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { BenchmarkProductError } from "../errors.js";
import { BUNDLE_V10_FORMAT, buildBundleManifest, verifyBundleManifest } from "./manifest.js";
import { BUNDLE_FORMAT, BUNDLE_V4_FORMAT, BUNDLE_V6_FORMAT } from "../legacy-closures.js";

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

  test("keeps v2 as the byte-stable default and emits v4 only when explicitly selected", () => {
    writeFixture();
    const paths = ["benchmark.json", `records/${"a".repeat(64)}.bin`];
    const legacy = buildBundleManifest(bundleDir, paths);
    const explicitLegacy = buildBundleManifest(bundleDir, paths, { format: BUNDLE_FORMAT });
    const binary = buildBundleManifest(bundleDir, paths, { format: BUNDLE_V4_FORMAT });

    expect(legacy.bytes).toEqual(explicitLegacy.bytes);
    expect(binary.manifest.format).toBe(BUNDLE_V4_FORMAT);
    expect(binary.manifest.files).toEqual(legacy.manifest.files);
    expect(binary.bytes).not.toEqual(legacy.bytes);
  });

  // Issue #3403: the composed generation's manifest is `/2`'s plus one required member, the
  // capability vector. This copy and `@colophon-claims/check`'s must agree, or the producer
  // cannot emit what the verifier accepts.
  test("a composed manifest carries its capability vector, spelled even when empty", () => {
    writeFixture();
    const paths = ["benchmark.json", `records/${"a".repeat(64)}.bin`];
    const legacy = buildBundleManifest(bundleDir, paths);
    const bare = buildBundleManifest(bundleDir, paths, { format: BUNDLE_V10_FORMAT, capabilities: [] });
    const anchored = buildBundleManifest(bundleDir, paths, { format: BUNDLE_V10_FORMAT, capabilities: ["anchoring"] });

    expect(bare.manifest).toEqual({ format: BUNDLE_V10_FORMAT, capabilities: [], files: legacy.manifest.files });
    expect(anchored.manifest).toEqual({ format: BUNDLE_V10_FORMAT, capabilities: ["anchoring"], files: legacy.manifest.files });
    // The vector is sealed into the identity: two vectors over the same files are two bundles.
    expect(anchored.identity).not.toBe(bare.identity);

    writeFileSync(join(bundleDir, "bundle.json"), anchored.bytes);
    expect(verifyBundleManifest(bundleDir).manifest).toEqual(anchored.manifest);
  });

  test("a composed manifest is closed, canonical, and must-understand", () => {
    writeFixture();
    const paths = ["benchmark.json", `records/${"a".repeat(64)}.bin`];
    const { files } = buildBundleManifest(bundleDir, paths).manifest;
    const refusalOf = (manifest: unknown): string => {
      writeFileSync(join(bundleDir, "bundle.json"), canonicalJsonBytes(manifest as never));
      try {
        verifyBundleManifest(bundleDir);
      } catch (cause) {
        return (cause as Error).message;
      }
      return "NOT REFUSED";
    };

    // No vector at all: "no capabilities" is the statement `[]`, never an absence.
    expect(refusalOf({ format: BUNDLE_V10_FORMAT, files })).toMatch(/manifest schema/u);
    // An unknown top-level member.
    expect(refusalOf({ format: BUNDLE_V10_FORMAT, capabilities: [], files, profile: "x" })).toMatch(/manifest schema/u);
    // A misordered or duplicated vector is a different byte string, refused before any logic runs.
    expect(refusalOf({ format: BUNDLE_V10_FORMAT, capabilities: ["binary-qualification", "anchoring"], files })).toMatch(/manifest schema/u);
    expect(refusalOf({ format: BUNDLE_V10_FORMAT, capabilities: ["anchoring", "anchoring"], files })).toMatch(/manifest schema/u);
    // A token this build does not implement refuses the bundle whole, by name -- and as THIS
    // package's typed refusal, not the reader package's, so a core caller branching on the error
    // class sees the same identity every other manifest refusal carries.
    expect(refusalOf({ format: BUNDLE_V10_FORMAT, capabilities: ["zz-unknown"], files })).toMatch(/does not implement capability "zz-unknown"/u);
    expect(() => verifyBundleManifest(bundleDir)).toThrow(BenchmarkProductError);
    // A legacy format cannot grow a vector by relabeling: the open object strips it, and the
    // canonical re-encoding then differs from the bytes on disk.
    expect(refusalOf({ format: BUNDLE_V6_FORMAT, capabilities: ["anchoring"], files })).toMatch(/canonical manifest encoding/u);

    // The producer end reads the same registry: a vector this build could not verify is not one
    // it will seal, so no bundle identity is ever minted that no reader could accept.
    for (const capabilities of [["Anchoring"], ["zz-unknown"], ["disclosure-specification"]]) {
      expect(() => buildBundleManifest(bundleDir, paths, { format: BUNDLE_V10_FORMAT, capabilities }), JSON.stringify(capabilities))
        .toThrow(BenchmarkProductError);
    }
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
