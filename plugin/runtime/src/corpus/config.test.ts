// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";

import { ENVIRONMENT_KEYS, resolveRuntimeConfig } from "../config.js";

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
    expect(config.corpus.syncIntervalMs).toBe(300_000);
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

  test("rejects a sync interval below one second", () => {
    expect(() =>
      resolveRuntimeConfig({ ...base, file: { corpus: { syncIntervalMs: 999 } } }),
    ).toThrow(/syncIntervalMs/);
  });

  test("rejects a sync interval above one day", () => {
    expect(() =>
      resolveRuntimeConfig({ ...base, file: { corpus: { syncIntervalMs: 86_400_001 } } }),
    ).toThrow(/syncIntervalMs/);
  });

  test("the sync interval is file-only — no environment key moves it (custody law C2)", () => {
    expect(Object.values(ENVIRONMENT_KEYS)).toEqual(["JINN_PLUGIN_HOME", "JINN_PLUGIN_LOG_LEVEL"]);
    const config = resolveRuntimeConfig({
      ...base,
      env: { JINN_PLUGIN_CORPUS_SYNC_INTERVAL_MS: "1000" },
      file: { corpus: { syncIntervalMs: 60_000 } },
    });
    expect(config.corpus.syncIntervalMs).toBe(60_000);
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

  // #3444: `declaredSigningKeys` in `session-host-corpus.ts` aggregates keys per
  // AGENT across sources and de-duplicates on `keyid` alone, keeping whichever
  // it saw first. Two sources of one agent declaring the same key with
  // different `validFrom` values therefore let source ORDER decide when the key
  // is admitted. Rejecting the contradiction here is what makes that dedup
  // provably order-independent, and it matches how the rest of this resolver
  // handles a contradiction rather than guessing at intent.
  describe("a signing key declared twice for one agent", () => {
    const KEYID = `did:key:z${"6Mk".repeat(8)}` as const;
    const signed = (validFrom: string, over: Record<string, unknown> = {}) => ({
      ...source(),
      ...over,
      signingKeys: [{ keyid: KEYID, validFrom }],
    });

    test("is rejected when the two declarations disagree on validFrom", () => {
      expect(() =>
        resolveRuntimeConfig({
          ...base,
          file: {
            corpus: {
              sources: [
                signed("2026-07-01T00:00:00Z"),
                signed("2026-08-01T00:00:00Z", {
                  name: "evaluations",
                  repositoryId: "archive.test/evaluations",
                }),
              ],
            },
          },
        }),
      ).toThrow(/2026-07-01T00:00:00\.000Z.*2026-08-01T00:00:00\.000Z|2026-08-01T00:00:00\.000Z.*2026-07-01T00:00:00\.000Z/s);
    });

    test("names the agent and the keyid so the operator can find both declarations", () => {
      expect(() =>
        resolveRuntimeConfig({
          ...base,
          file: {
            corpus: {
              sources: [
                signed("2026-07-01T00:00:00Z"),
                signed("2026-08-01T00:00:00Z", {
                  name: "evaluations",
                  repositoryId: "archive.test/evaluations",
                }),
              ],
            },
          },
        }),
      ).toThrow(new RegExp(`${KEYID}[\\s\\S]*|https://agents\\.test/alice`));
    });

    test("the rejection does not depend on which source is written first", () => {
      const write = (first: string, second: string) => () =>
        resolveRuntimeConfig({
          ...base,
          file: {
            corpus: {
              sources: [
                signed(first),
                signed(second, { name: "evaluations", repositoryId: "archive.test/evaluations" }),
              ],
            },
          },
        });
      expect(write("2026-07-01T00:00:00Z", "2026-08-01T00:00:00Z")).toThrow();
      expect(write("2026-08-01T00:00:00Z", "2026-07-01T00:00:00Z")).toThrow();
    });

    test("an identical redeclaration is legitimate and still resolves", () => {
      const config = resolveRuntimeConfig({
        ...base,
        file: {
          corpus: {
            sources: [
              signed("2026-07-01T00:00:00Z"),
              signed("2026-07-01T00:00:00Z", {
                name: "evaluations",
                repositoryId: "archive.test/evaluations",
              }),
            ],
          },
        },
      });
      expect(config.corpus.sources).toHaveLength(2);
    });

    test("two agents may declare the same keyid at different instants", () => {
      const config = resolveRuntimeConfig({
        ...base,
        file: {
          corpus: {
            sources: [
              signed("2026-07-01T00:00:00Z"),
              signed("2026-08-01T00:00:00Z", {
                agent: "https://agents.test/bob",
                repositoryId: "archive.test/bob-attempts",
              }),
            ],
          },
        },
      });
      expect(config.corpus.sources).toHaveLength(2);
    });

    test("one source contradicting itself is rejected too", () => {
      expect(() =>
        resolveRuntimeConfig({
          ...base,
          file: {
            corpus: {
              sources: [
                {
                  ...source(),
                  signingKeys: [
                    { keyid: KEYID, validFrom: "2026-07-01T00:00:00Z" },
                    { keyid: KEYID, validFrom: "2026-08-01T00:00:00Z" },
                  ],
                },
              ],
            },
          },
        }),
      ).toThrow(/validFrom/);
    });

    test("offset spellings of one instant are not a contradiction", () => {
      // `validFrom` is canonicalized to UTC on the way in, so the comparison
      // is between instants, not between the digits the operator wrote.
      const config = resolveRuntimeConfig({
        ...base,
        file: {
          corpus: {
            sources: [
              signed("2026-08-01T00:00:00Z"),
              signed("2026-07-31T19:00:00-05:00", {
                name: "evaluations",
                repositoryId: "archive.test/evaluations",
              }),
            ],
          },
        },
      });
      expect(config.corpus.sources).toHaveLength(2);
    });
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

  test("defaults the chain-verification posture to verified", () => {
    // A production mirror over remote holder feeds verifies what it consumes;
    // choosing anything else takes a config line.
    expect(resolveRuntimeConfig(base).corpus.chainVerification).toBe("verified");
  });

  test("accepts all three postures by name", () => {
    for (const posture of ["verified", "rejecting"] as const) {
      const config = resolveRuntimeConfig({ ...base, file: { corpus: { chainVerification: posture } } });
      expect(config.corpus.chainVerification).toBe(posture);
    }
    const unverified = resolveRuntimeConfig({
      ...base,
      file: { corpus: { chainVerification: "unverified", acknowledgeUnverifiedChain: true } },
    });
    expect(unverified.corpus.chainVerification).toBe("unverified");
  });

  test("the unverified posture is unreachable without the acknowledgement", () => {
    expect(() =>
      resolveRuntimeConfig({ ...base, file: { corpus: { chainVerification: "unverified" } } }),
    ).toThrow(/acknowledgeUnverifiedChain/);
  });

  test("the acknowledgement alone still selects the unverified posture", () => {
    // The pre-`chainVerification` spelling of the same intent: an install that
    // wrote only the flag keeps mirroring, rather than being silently
    // upgraded into a posture it has no driver for.
    const config = resolveRuntimeConfig({
      ...base,
      file: { corpus: { acknowledgeUnverifiedChain: true } },
    });
    expect(config.corpus.chainVerification).toBe("unverified");
  });

  test("rejects an unknown posture", () => {
    expect(() =>
      resolveRuntimeConfig({ ...base, file: { corpus: { chainVerification: "trust-me" } } }),
    ).toThrow(/corpus configuration is invalid/);
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
