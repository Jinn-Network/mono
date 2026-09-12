import { describe, expect, test } from "vitest";

import {
  environmentFixtureUrl,
  loadAdversarialManifest,
  loadEquivalenceExpectedDigest,
  loadEquivalenceInput,
  loadGoldenBytes,
  loadGoldenDigest,
  loadGoldenJson,
  loadInvalidJson,
  readAdversarialBytes,
  readAdversarialJson,
} from "./fixtures.js";
import { environmentRecordDigest } from "./hashing.js";
import {
  EnvironmentRecordSchema,
  parseEnvironmentRecord,
  sealEnvironmentRecord,
} from "./schema.js";

const GOLDEN = ["imported", "tier-1", "extension"] as const;
const INVALID = [
  "index-digest-as-manifest",
  "reference-not-ending-in-digest",
  "shell-command",
  "shell-command-exe-spelling",
  "bare-extension-key",
  "bare-hex-manifest-digest",
] as const;

describe("fixture paths", () => {
  test("resolve a relative path inside fixtures/", () => {
    const root = new URL("../fixtures/", import.meta.url).href;
    expect(environmentFixtureUrl("environment/imported.json").href)
      .toBe(`${root}environment/imported.json`);
  });

  test("refuse a path that escapes fixtures/", () => {
    expect(() => environmentFixtureUrl("/etc/passwd")).toThrow();
    expect(() => environmentFixtureUrl("../package.json")).toThrow();
    expect(() => environmentFixtureUrl("environment/../../package.json")).toThrow();
    // WHATWG URL resolves these as double-dot path segments, so a textual ".." scan misses
    // them and the guard has to be on the resolved url instead.
    expect(() => environmentFixtureUrl("environment/%2e%2e/%2e%2e/package.json")).toThrow();
    expect(() => environmentFixtureUrl("environment/%2E%2E/%2E%2E/package.json")).toThrow();
    expect(() => environmentFixtureUrl("environment/.%2e/.%2e/package.json")).toThrow();
    expect(() => environmentFixtureUrl("file:///etc/passwd")).toThrow();
    expect(() => environmentFixtureUrl("https://example.invalid/x")).toThrow();
  });
});

describe("fixtures", () => {
  test.each(GOLDEN)("golden %s parses and re-seals to its pinned digest", async (name) => {
    const bytes = await loadGoldenBytes(name);
    const digest = await loadGoldenDigest(name);
    expect(environmentRecordDigest(bytes)).toBe(digest);
    expect(parseEnvironmentRecord(bytes).kind).toBeDefined();
    expect(environmentRecordDigest(sealEnvironmentRecord(await loadGoldenJson(name)))).toBe(digest);
  });

  test.each(INVALID)("invalid fixture %s is rejected", async (name) => {
    expect(EnvironmentRecordSchema.safeParse(await loadInvalidJson(name)).success).toBe(false);
  });

  test("key-permuted equivalence twins seal to one pinned digest", async () => {
    const expected = await loadEquivalenceExpectedDigest();
    expect(environmentRecordDigest(sealEnvironmentRecord(await loadEquivalenceInput("a")))).toBe(expected);
    expect(environmentRecordDigest(sealEnvironmentRecord(await loadEquivalenceInput("b")))).toBe(expected);
  });

  test("the adversarial corpus is complete and behaves as its manifest declares", async () => {
    const manifest = await loadAdversarialManifest();
    expect(manifest.fixtures.map((entry) => entry.id).sort()).toEqual([
      "bare-extension-key",
      "bare-hex-manifest-digest",
      "index-digest-as-manifest",
      "namespaced-extension-preserved",
      "recanonicalized-bytes",
      "reference-not-ending-in-digest",
      "shell-command",
      "shell-command-exe-spelling",
    ]);
    for (const entry of manifest.fixtures) {
      if (entry.expectedDisposition === "invalid-bytes") {
        const bytes = await readAdversarialBytes(entry.id);
        expect(EnvironmentRecordSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes))).success)
          .toBe(true);
        expect(() => parseEnvironmentRecord(bytes), entry.description).toThrow();
        continue;
      }
      const accepted = EnvironmentRecordSchema.safeParse(await readAdversarialJson(entry.id)).success;
      expect(accepted, `${entry.id}: ${entry.description}`).toBe(
        entry.expectedDisposition === "accepted",
      );
    }
  });
});
