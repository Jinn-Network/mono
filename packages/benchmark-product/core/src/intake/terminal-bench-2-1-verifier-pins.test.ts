// SPDX-License-Identifier: Apache-2.0

/**
 * The verifier pins of the official Terminal-Bench 2.1 slate, held to committed inputs.
 *
 * `scripts/generate-terminal-bench-2-1-verifier-pins.mjs` reads the 89 task packages and writes two
 * files: the pins this package seals EvaluationSpecs from, and a manifest of every package file's
 * path and SHA-256. The generator needs the packages and is never run in CI. This test needs
 * neither. It rebuilds the chain from the two committed files and the slate table:
 *
 *   manifest lines  ->  Harbor's content hash  ==  the package ref the slate pins
 *   manifest `tests/` lines, in code-point order  ==  the pinned test material
 *
 * So a digest in the pins that is not a digest of the package the slate names fails here. What
 * the chain cannot reach offline is said in the last test: the timeout and the image reference
 * are read from `task.toml`, whose bytes are not committed. The manifest carries that file's
 * digest, inside the package hash, so anyone who holds the package can check both.
 */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  ExternalVerifierBlockSchema,
  compareCodePointStrings,
  harborPackageContentHash,
} from "@jinn-network/task-execution-profiles";
import { TERMINAL_BENCH_2_1_DATASET_ID, TERMINAL_BENCH_2_1_DATASET_REF } from "../runtime/terminal-bench-2-1/manifest.js";
import { TERMINAL_BENCH_21_OFFICIAL_TASKS } from "./terminal-bench-2-1-slate.js";
import { TERMINAL_BENCH_21_VERIFIER_PINS } from "./terminal-bench-2-1-verifier-pins.js";

interface PackageManifest {
  readonly datasetId: string;
  readonly datasetRevision: string;
  readonly packages: readonly {
    readonly name: string;
    readonly ref: string;
    readonly files: readonly { readonly path: string; readonly sha256: string }[];
  }[];
}

const manifest = JSON.parse(readFileSync(
  new URL("../../test/fixtures/terminal-bench-2-1-packages/manifest.json", import.meta.url),
  "utf8",
)) as PackageManifest;

const SLATE_NAMES = TERMINAL_BENCH_21_OFFICIAL_TASKS.map((task) => task.name);

describe("the committed package manifest", () => {
  test("names the dataset revision the slate pins, and every official task once, in slate order", () => {
    expect(manifest.datasetId).toBe(TERMINAL_BENCH_2_1_DATASET_ID);
    expect(manifest.datasetRevision).toBe(TERMINAL_BENCH_2_1_DATASET_REF);
    expect(manifest.packages.map((entry) => entry.name)).toEqual(SLATE_NAMES);
    expect(manifest.packages).toHaveLength(89);
  });

  test("each package's file lines hash, by Harbor's rule, to the package ref the slate pins", () => {
    for (const [index, task] of TERMINAL_BENCH_21_OFFICIAL_TASKS.entries()) {
      const entry = manifest.packages[index]!;
      expect(entry.ref, task.name).toBe(task.ref);
      expect(`sha256:${harborPackageContentHash(entry.files)}`, task.name).toBe(task.ref);
    }
  });

  test("lists each package's files once, ascending by Unicode code point, as digests and nothing else", () => {
    for (const entry of manifest.packages) {
      const paths = entry.files.map((file) => file.path);
      expect([...paths].sort(compareCodePointStrings), entry.name).toEqual(paths);
      expect(new Set(paths).size, entry.name).toBe(paths.length);
      for (const file of entry.files) {
        expect(Object.keys(file).sort(), `${entry.name}/${file.path}`).toEqual(["path", "sha256"]);
        expect(file.sha256, `${entry.name}/${file.path}`).toMatch(/^[a-f0-9]{64}$/u);
      }
      // Every package is a Harbor task: a config, and a verifier script under `tests/`.
      expect(paths, entry.name).toContain("task.toml");
      expect(paths, entry.name).toContain("tests/test.sh");
    }
  });
});

describe("the verifier pins", () => {
  test("pin every official task once, in slate order", () => {
    expect(TERMINAL_BENCH_21_VERIFIER_PINS.map((pin) => pin.name)).toEqual(SLATE_NAMES);
  });

  test("each task's test material is its package's `tests/` files, by digest, in code-point order", () => {
    for (const [index, pin] of TERMINAL_BENCH_21_VERIFIER_PINS.entries()) {
      const fromManifest = manifest.packages[index]!.files
        .filter((file) => file.path.startsWith("tests/"))
        .sort((left, right) => compareCodePointStrings(left.path, right.path))
        .map((file) => ({ name: file.path, sha256: file.sha256 }));
      expect(fromManifest.length, pin.name).toBeGreaterThan(0);
      expect(pin.testMaterial, pin.name).toEqual(fromManifest);
    }
  });

  test("each pin is a block the external-verifier family accepts", () => {
    for (const pin of TERMINAL_BENCH_21_VERIFIER_PINS) {
      expect(ExternalVerifierBlockSchema.safeParse({
        harness: "harbor",
        verifierSemanticsVersion: "1",
        testMaterial: pin.testMaterial.map((file) => ({ name: file.name, digest: { sha256: file.sha256 } })),
        declaredImage: pin.declaredImage,
        timeout: pin.timeoutSec,
      }).success, pin.name).toBe(true);
    }
  });

  test("the timeout and the image reference rest on the generator's reading of task.toml", () => {
    // Not re-derivable here: `task.toml` bytes are not committed, because the file carries its
    // authors' names and email addresses. What is pinned is the shape the generator asserted, and
    // the two values the operator's ruling quotes for the first task.
    for (const pin of TERMINAL_BENCH_21_VERIFIER_PINS) {
      expect(Number.isInteger(pin.timeoutSec) && pin.timeoutSec > 0, pin.name).toBe(true);
      expect(pin.declaredImage, pin.name).toMatch(/^[^\s"\\]+$/u);
      // A tag, never a digest: no package pins its image.
      expect(pin.declaredImage, pin.name).not.toContain("@sha256:");
    }
    expect(TERMINAL_BENCH_21_VERIFIER_PINS[0]).toEqual({
      name: "adaptive-rejection-sampler",
      timeoutSec: 900,
      declaredImage: "alexgshaw/adaptive-rejection-sampler:20251031",
      testMaterial: [
        { name: "tests/test.sh", sha256: "38b43560d173cc2b952c3a3e17b8a480216d84e33450515e047bcb0d806b1e0a" },
        { name: "tests/test_outputs.py", sha256: "547dc6e107f034f41703722aeceb6d0236e3fb69116fc3f2fbaba11884de352f" },
      ],
    });
  });
});
