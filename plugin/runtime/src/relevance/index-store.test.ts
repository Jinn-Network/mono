// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, test } from "vitest";

import { ensureOwnerOnlyDirectory, ensureOwnerOnlyFile } from "../capture/paths.js";
import { type IndexDatabaseIO } from "./database.js";
import {
  MAX_BODY_CHARS,
  MAX_EXCERPT_CHARS,
  MAX_INDEXED_EXCERPTS,
  MAX_SUMMARY_CHARS,
  openRelevanceIndex,
  type IndexableRecord,
  type RelevanceIndex,
} from "./index-store.js";
import { type SensitivityNonceIO } from "./nonce.js";
import { createSensitivityClassifier } from "./sensitivity.js";

const DIGEST = (seed: string): `sha256:${string}` =>
  `sha256:${seed.repeat(64).slice(0, 64)}` as `sha256:${string}`;

const testIndexIo: IndexDatabaseIO = {
  ensureOwnerOnlyDirectory,
  ensureOwnerOnlyFile,
  removeFile: (path) => rm(path, { force: true }),
};

const testNonceIo: SensitivityNonceIO = {
  readFile,
  writeFile,
  ensureOwnerOnlyFile,
};

let index: RelevanceIndex;
let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "jinn-store-"));
  index = await openRelevanceIndex({
    databasePath: join(home, "index.sqlite"),
    indexIo: testIndexIo,
    classifier: await createSensitivityClassifier({
      noncePath: join(home, "sensitivity-nonce"),
      knownIdentities: [],
      nonceIo: testNonceIo,
    }),
    now: () => "2026-07-30T00:00:00.000Z",
  });
});

const record = (overrides: Partial<IndexableRecord> = {}): IndexableRecord => ({
  plane: "local",
  reference: { family: "execution-evidence", digest: DIGEST("a") },
  summary: "Fix the flaky FTS rebuild in the operator dashboard",
  origin: "urn:jinn:agent:operator-local",
  capturedAt: "2026-07-12T09:14:22.000Z",
  outcome: "completed",
  excerpts: [
    {
      label: "failure",
      sourceEntityId: "trace.ndjson",
      sourceDigest: DIGEST("b"),
      text: "yarn test packages/foo\nFAIL src/index.test.ts",
    },
  ],
  ...overrides,
});

describe("index writes", () => {
  test("indexes a clean record and reports it", async () => {
    const receipt = await index.put(record());
    expect(receipt.status).toBe("indexed");
    expect(receipt.indexedExcerpts).toBe(1);
    expect(receipt.excluded).toEqual([]);
    expect(index.has("local", record().reference)).toBe(true);
  });

  test("re-putting the same reference replaces rather than duplicates", async () => {
    await index.put(record());
    await index.put(record({ summary: "Replaced summary about caching" }));
    const hits = await index.search({ terms: ["caching", "summary"], floor: 1 });
    expect(hits).toHaveLength(1);
    const stale = await index.search({ terms: ["flaky", "dashboard"], floor: 2 });
    expect(stale).toHaveLength(0);
  });

  test("the same digest on the two planes are two documents", async () => {
    await index.put(record({ plane: "local" }));
    await index.put(record({ plane: "public" }));
    expect(index.has("local", record().reference)).toBe(true);
    expect(index.has("public", record().reference)).toBe(true);
  });

  test("an excerpt carrying a credential is excluded, the rest of the record survives", async () => {
    const receipt = await index.put(
      record({
        excerpts: [
          {
            label: "command",
            sourceEntityId: "trace.ndjson",
            sourceDigest: DIGEST("b"),
            text: "export NPM_TOKEN=npm_0123456789abcdefghijklmnopqrstuvwxyz",
          },
          {
            label: "fix",
            sourceEntityId: "trace.ndjson",
            sourceDigest: DIGEST("b"),
            text: "yarn test --no-threads",
          },
        ],
      }),
    );
    expect(receipt.status).toBe("indexed");
    expect(receipt.indexedExcerpts).toBe(1);
    expect(receipt.excluded).toHaveLength(1);
    expect(receipt.excluded[0]?.classes).toContain("credential");
    const hits = await index.search({ terms: ["flaky", "dashboard"], floor: 2 });
    expect(hits[0]?.excerpts.map((excerpt) => excerpt.label)).toEqual(["fix"]);
  });

  test("a secret is not searchable after exclusion", async () => {
    await index.put(
      record({
        excerpts: [
          {
            label: "command",
            sourceEntityId: "trace.ndjson",
            sourceDigest: DIGEST("b"),
            text: "export NPM_TOKEN=npm_0123456789abcdefghijklmnopqrstuvwxyz",
          },
        ],
      }),
    );
    expect(await index.search({ terms: ["npm_token"], floor: 1 })).toHaveLength(0);
  });

  test("a sensitive summary excludes the whole record", async () => {
    const receipt = await index.put(
      record({ summary: `deploy with private_key ${"a1b2c3d4".repeat(8)} to production` }),
    );
    expect(receipt.status).toBe("excluded-record");
    expect(receipt.indexedExcerpts).toBe(0);
    expect(index.has("local", record().reference)).toBe(false);
  });

  test("an excluded record replaces a previously indexed version of itself", async () => {
    await index.put(record());
    expect(index.has("local", record().reference)).toBe(true);
    await index.put(record({ summary: `private_key ${"a1b2c3d4".repeat(8)}` }));
    expect(index.has("local", record().reference)).toBe(false);
  });

  test("a receipt never carries the offending text", async () => {
    const secret = "npm_0123456789abcdefghijklmnopqrstuvwxyz";
    const receipt = await index.put(
      record({
        excerpts: [
          { label: "command", sourceEntityId: "t", sourceDigest: DIGEST("b"), text: `x ${secret}` },
        ],
      }),
    );
    expect(JSON.stringify(receipt)).not.toContain(secret);
  });

  test("budgets bound what one record can contribute", async () => {
    const receipt = await index.put(
      record({
        summary: "s".repeat(MAX_SUMMARY_CHARS + 500),
        excerpts: Array.from({ length: MAX_INDEXED_EXCERPTS + 6 }, (_unused, ordinal) => ({
          label: "note" as const,
          sourceEntityId: "trace.ndjson",
          sourceDigest: DIGEST("b"),
          text: `chunk${ordinal} ${"z".repeat(MAX_EXCERPT_CHARS + 400)}`,
        })),
      }),
    );
    expect(receipt.indexedExcerpts).toBeLessThanOrEqual(MAX_INDEXED_EXCERPTS);
    const hits = await index.search({ terms: ["chunk0"], floor: 1 });
    expect(hits[0]?.summary.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
    const bodyChars = hits[0]!.excerpts.reduce((total, excerpt) => total + excerpt.text.length, 0);
    expect(bodyChars).toBeLessThanOrEqual(MAX_BODY_CHARS);
  });

  test("stats vary with content, which is what makes them a health check", async () => {
    expect(index.stats()).toEqual({ local: 0, public: 0, excludedByTrust: 0 });

    await index.put(record({ plane: "local" }));
    await index.put(record({ plane: "public" }));
    await index.put(
      record({
        plane: "public",
        reference: { family: "execution-evidence", digest: DIGEST("c") },
      }),
    );

    const stats = index.stats();
    expect(stats.local).toBe(1);
    expect(stats.public).toBe(2);
    expect(stats.lastIndexedAt).toBe("2026-07-30T00:00:00.000Z");
  });

  test("an excluded record inflates neither the counts nor the high-water mark", async () => {
    await index.put(record({ summary: `private_key ${"a1b2c3d4".repeat(8)}` }));
    expect(index.stats()).toEqual({ local: 0, public: 0, excludedByTrust: 0 });
  });

  test("the high-water mark survives eviction, so 'empty now' differs from 'never written'", async () => {
    expect(index.stats().lastIndexedAt).toBeUndefined();

    await index.put(record());
    index.remove("local", record().reference);

    const stats = index.stats();
    expect(stats.local).toBe(0);
    expect(stats.public).toBe(0);
    expect(stats.lastIndexedAt).toBe("2026-07-30T00:00:00.000Z");
  });

  test("the high-water mark survives a record being replaced by an excluded version", async () => {
    await index.put(record());
    await index.put(record({ summary: `private_key ${"a1b2c3d4".repeat(8)}` }));
    const stats = index.stats();
    expect(stats.local).toBe(0);
    expect(stats.lastIndexedAt).toBe("2026-07-30T00:00:00.000Z");
  });

  test("trust exclusions are recorded, survive an empty index, and persist", async () => {
    expect(index.stats().excludedByTrust).toBe(0);

    await index.put(record());
    index.remove("local", record().reference);
    index.recordTrustExclusions(7);

    const stats = index.stats();
    expect(stats.local).toBe(0);
    expect(stats.public).toBe(0);
    expect(stats.excludedByTrust).toBe(7);
    expect(stats.lastIndexedAt).toBe("2026-07-30T00:00:00.000Z");
  });

  test("a later clean pass clears a stale trust-exclusion count", async () => {
    index.recordTrustExclusions(7);
    index.recordTrustExclusions(0);
    expect(index.stats().excludedByTrust).toBe(0);
  });

  test("a nonsensical exclusion count is coerced rather than stored", async () => {
    index.recordTrustExclusions(-3);
    expect(index.stats().excludedByTrust).toBe(0);
    index.recordTrustExclusions(2.7);
    expect(index.stats().excludedByTrust).toBe(2);
  });

  test("the high-water mark persists across a reopen", async () => {
    await index.put(record());
    index.close();
    const reopened = await openRelevanceIndex({
      databasePath: index.databasePath,
      indexIo: testIndexIo,
      classifier: await createSensitivityClassifier({
        noncePath: join(home, "sensitivity-nonce"),
        knownIdentities: [],
        nonceIo: testNonceIo,
      }),
      now: () => "2026-08-01T00:00:00.000Z",
    });
    expect(reopened.stats().lastIndexedAt).toBe("2026-07-30T00:00:00.000Z");
    expect(reopened.stats().excludedByTrust).toBe(0);
    reopened.close();
  });

  test("remove deletes both the document and its terms", async () => {
    await index.put(record());
    index.remove("local", record().reference);
    expect(index.has("local", record().reference)).toBe(false);
    expect(await index.search({ terms: ["flaky", "dashboard"], floor: 2 })).toHaveLength(0);
  });
});
