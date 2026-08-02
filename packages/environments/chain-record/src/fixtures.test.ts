import { describe, expect, test } from "vitest";

import {
  ChainEnvironmentRecordSchema,
  CryptoEnvironmentRecordSchema,
  chainEnvironmentRecordDigest,
  cryptoEnvironmentRecordDigest,
  parseChainEnvironmentRecord,
  sealChainEnvironmentRecord,
  sealCryptoEnvironmentRecord,
} from "./index.js";
import {
  loadAdversarialManifest,
  loadChainGoldenBytes,
  loadChainGoldenDigest,
  loadChainGoldenJson,
  loadCompositeGoldenBytes,
  loadCompositeGoldenDigest,
  loadCompositeGoldenJson,
  loadEquivalenceExpectedDigest,
  loadEquivalenceInput,
  readAdversarialBytes,
  readAdversarialJson,
} from "./fixtures.js";
import { isWellKnownDevAddress } from "./dev-addresses.js";

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const CHAIN_GOLDEN = ["closed-anchored-subset", "closed-local", "archive-dependent"] as const;
const COMPOSITE_GOLDEN = ["chain-only", "composed", "extension"] as const;

describe.each(CHAIN_GOLDEN)("chain golden: %s", (name) => {
  test("parses under the record schema", async () => {
    expect(ChainEnvironmentRecordSchema.safeParse(await loadChainGoldenJson(name)).success).toBe(true);
  });

  test("producer-side re-seal reproduces the pinned bytes and digest", async () => {
    const resealed = sealChainEnvironmentRecord(await loadChainGoldenJson(name));
    expect(decode(resealed)).toBe(decode(await loadChainGoldenBytes(name)));
    expect(chainEnvironmentRecordDigest(resealed)).toBe(await loadChainGoldenDigest(name));
  });

  test("consumer-side digest over stored bytes matches without re-canonicalization", async () => {
    expect(chainEnvironmentRecordDigest(await loadChainGoldenBytes(name)))
      .toBe(await loadChainGoldenDigest(name));
  });

  test("no fixture account is a well-known dev-mnemonic address", async () => {
    const record = parseChainEnvironmentRecord(await loadChainGoldenBytes(name));
    for (const account of record.fixtures.accounts) {
      expect(isWellKnownDevAddress(account.address), account.address).toBe(false);
    }
  });
});

describe.each(COMPOSITE_GOLDEN)("composite golden: %s", (name) => {
  test("parses under the composite schema", async () => {
    expect(CryptoEnvironmentRecordSchema.safeParse(await loadCompositeGoldenJson(name)).success).toBe(true);
  });

  test("producer-side re-seal reproduces the pinned bytes and digest", async () => {
    const resealed = sealCryptoEnvironmentRecord(await loadCompositeGoldenJson(name));
    expect(decode(resealed)).toBe(decode(await loadCompositeGoldenBytes(name)));
    expect(cryptoEnvironmentRecordDigest(resealed)).toBe(await loadCompositeGoldenDigest(name));
  });
});

// Program §4 contract 8, corpus-wide: keys are fresh per record, so no address may appear in
// two golden records. This is the check that catches copy-paste between fixtures.
test("no fixture address is reused across the golden chain records", async () => {
  const seen = new Map<string, string>();
  for (const name of CHAIN_GOLDEN) {
    const record = parseChainEnvironmentRecord(await loadChainGoldenBytes(name));
    for (const account of record.fixtures.accounts) {
      expect(seen.has(account.address), `${account.address} reused: ${seen.get(account.address)} and ${name}`)
        .toBe(false);
      seen.set(account.address, name);
    }
  }
  expect(seen.size).toBeGreaterThan(0);
});

test("key-permuted inputs seal to one pinned digest", async () => {
  const expected = await loadEquivalenceExpectedDigest();
  expect(chainEnvironmentRecordDigest(sealChainEnvironmentRecord(await loadEquivalenceInput("a"))))
    .toBe(expected);
  expect(chainEnvironmentRecordDigest(sealChainEnvironmentRecord(await loadEquivalenceInput("b"))))
    .toBe(expected);
});

describe("the adversarial corpus", () => {
  test("declares the nine cases the design's review findings named", async () => {
    const manifest = await loadAdversarialManifest();
    expect(manifest.fixtures.map((entry) => entry.id).sort()).toEqual([
      "anchor-root-as-initial-commitment",
      "artifact-entry-uncovered",
      "bare-extension-key",
      "digest-confusion-bare-hex",
      "index-digest-as-manifest",
      "namespaced-extension-preserved",
      "origin-precedence-undeclared",
      "recanonicalized-bytes",
      "well-known-fixture-address",
    ]);
  });

  test("every entry behaves exactly as its manifest declares", async () => {
    const manifest = await loadAdversarialManifest();
    for (const entry of manifest.fixtures) {
      const schema = entry.recordKind === "crypto-environment"
        ? CryptoEnvironmentRecordSchema
        : ChainEnvironmentRecordSchema;
      if (entry.expectedDisposition === "invalid-bytes") {
        const bytes = await readAdversarialBytes(entry.id);
        expect(() => parseChainEnvironmentRecord(bytes), `${entry.id}: ${entry.description}`).toThrow();
        continue;
      }
      const accepted = schema.safeParse(await readAdversarialJson(entry.id)).success;
      expect(accepted, `${entry.id}: ${entry.description}`)
        .toBe(entry.expectedDisposition === "accepted");
    }
  });

  test("every entry carries a description saying what the attack is", async () => {
    const manifest = await loadAdversarialManifest();
    for (const entry of manifest.fixtures) {
      expect(entry.description.length, entry.id).toBeGreaterThan(40);
    }
  });
});
