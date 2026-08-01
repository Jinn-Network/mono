// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";

import { resolveRuntimeConfig } from "../config.js";

const base = {
  env: {} as Readonly<Record<string, string | undefined>>,
  homeDirectory: "/home/agent/.jinn-plugin",
};

const source = () => ({
  agent: "https://agents.test/alice",
  name: "attempts",
  servingRoot: "https://archive.test",
  archiveRootUrl: "https://archive.test/sources/attempts/entries/0000000000000001",
  repositoryId: "archive.test/attempts",
});

describe("corpus configuration", () => {
  test("defaults to following no archives and mirroring nothing", () => {
    const config = resolveRuntimeConfig(base);
    expect(config.corpus.sources).toEqual([]);
    expect(config.corpus.maxEntriesPerSync).toBe(500);
    expect(config.corpus.syncTimeoutMs).toBe(30_000);
    expect(config.corpus.acknowledgeUnverifiedChain).toBe(false);
    expect(config.corpus.trust).toBeUndefined();
  });

  test("derives the mirror paths from the home directory", () => {
    const config = resolveRuntimeConfig(base);
    expect(config.mirrorCatalogPath).toBe("/home/agent/.jinn-plugin/mirror/catalog.sqlite");
    expect(config.mirrorObjectsDirectory).toBe("/home/agent/.jinn-plugin/mirror/objects");
    expect(config.mirrorLockPath).toBe("/home/agent/.jinn-plugin/mirror-sync.lock");
  });

  test("accepts a followed archive from the config file", () => {
    const config = resolveRuntimeConfig({ ...base, file: { corpus: { sources: [source()] } } });
    expect(config.corpus.sources).toHaveLength(1);
    expect(config.corpus.sources[0]!.repositoryId).toBe("archive.test/attempts");
  });

  test("the environment cannot add, remove, or redirect a followed archive", () => {
    const config = resolveRuntimeConfig({
      ...base,
      env: {
        JINN_PLUGIN_CORPUS_SOURCES: JSON.stringify([source()]),
        JINN_PLUGIN_CORPUS_TRUST_GENESIS: `sha256:${"a".repeat(64)}`,
      },
      file: { corpus: { sources: [source()] } },
    });
    expect(config.corpus.sources).toHaveLength(1);
    expect(config.corpus.sources[0]!.servingRoot).toBe("https://archive.test");
    expect(config.corpus.trust).toBeUndefined();
  });

  test("rejects a non-https serving root", () => {
    expect(() =>
      resolveRuntimeConfig({
        ...base,
        file: { corpus: { sources: [{ ...source(), servingRoot: "http://archive.test" }] } },
      }),
    ).toThrow(/https/);
  });

  test("rejects a source name outside the record-discovery grammar", () => {
    expect(() =>
      resolveRuntimeConfig({ ...base, file: { corpus: { sources: [{ ...source(), name: "Attempts" }] } } }),
    ).toThrow(/source-name/);
  });

  test("rejects two sources sharing one repository id", () => {
    expect(() =>
      resolveRuntimeConfig({
        ...base,
        file: { corpus: { sources: [source(), { ...source(), name: "evaluations" }] } },
      }),
    ).toThrow(/repository id/);
  });

  test("rejects the same archive followed twice", () => {
    expect(() =>
      resolveRuntimeConfig({
        ...base,
        file: {
          corpus: { sources: [source(), { ...source(), repositoryId: "archive.test/attempts-2" }] },
        },
      }),
    ).toThrow(/followed twice/);
  });

  test("accepts a trust configuration and defaults the producer purpose", () => {
    const config = resolveRuntimeConfig({
      ...base,
      file: {
        corpus: { trust: { genesisDigest: `sha256:${"b".repeat(64)}`, policyDirectory: "policy" } },
      },
    });
    expect(config.corpus.trust?.producerPurpose).toBe("jinn:corpus-producer");
    expect(config.corpus.trust?.policyDirectory).toBe("/home/agent/.jinn-plugin/policy");
  });

  test("rejects a malformed genesis digest", () => {
    expect(() =>
      resolveRuntimeConfig({
        ...base,
        file: { corpus: { trust: { genesisDigest: "not-a-digest", policyDirectory: "policy" } } },
      }),
    ).toThrow();
  });
});
