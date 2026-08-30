// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { resolveRuntimeConfig } from "./config.js";
import { createLocalCorpusPorts, resolveCorpusBinIoFields } from "./session-host-corpus.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "jinn-corpus-ports-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function ports() {
  return createLocalCorpusPorts({
    config: resolveRuntimeConfig({ env: {}, homeDirectory: home }),
    fetchLike: async () => new Response(new Uint8Array(), { status: 200 }),
  });
}

describe("createLocalCorpusPorts", () => {
  test("supplies every port the corpus capability needs", () => {
    const built = ports();
    expect(typeof built.corpusTransport.fetch).toBe("function");
    expect(typeof built.corpusFs.readFile).toBe("function");
    expect(typeof built.dsseVerifier).toBe("function");
    expect(typeof built.readPolicyVersions).toBe("function");
    expect(typeof built.corpusVerifyDriver.verifySource).toBe("function");
  });
});

describe("readPolicyVersions", () => {
  test("reads regular files in name order and skips dotfiles and subdirectories", async () => {
    const directory = join(home, "policy");
    await mkdir(join(directory, "nested"), { recursive: true });
    await writeFile(join(directory, "002.dsse"), "second");
    await writeFile(join(directory, "001.dsse"), "first");
    await writeFile(join(directory, ".hidden"), "ignored");
    await writeFile(join(directory, "nested", "003.dsse"), "ignored");

    const versions = await ports().readPolicyVersions(directory);
    expect(versions.map((bytes) => new TextDecoder().decode(bytes))).toEqual(["first", "second"]);
  });

  test("rejects when the configured directory does not exist", async () => {
    // The capability turns this into `corpus-trust-policy` red with no remedy;
    // silently reading an empty chain would admit nobody while looking healthy.
    await expect(ports().readPolicyVersions(join(home, "absent"))).rejects.toThrow();
  });
});

describe("resolveCorpusBinIoFields", () => {
  test("builds the BinIo corpus fields for a resolvable home directory", () => {
    const fields = resolveCorpusBinIoFields({ env: {}, homeDirectory: home });
    expect(Object.keys(fields).sort()).toEqual([
      "corpusFs",
      "corpusTransport",
      "corpusVerifyDriver",
      "dsseVerifier",
      "readPolicyVersions",
    ]);
  });

  test("yields no fields when configuration cannot be resolved", () => {
    // `main` owns the `configuration failed` message and exit code; composing
    // here must not pre-empt it with a different failure at import time.
    expect(resolveCorpusBinIoFields({ env: {}, homeDirectory: "relative/home" })).toEqual({});
  });
});
