import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { sealJson } from "./sealing.js";
import { canonicalJsonBytes, recordDigest, ScopeSchema } from "@jinn-network/trust-core";
import { DISCOVERY_SIGNING_SCOPE } from "./identifiers.js";

// Program ruling §7.1: the sealed bytes of every sealed document family in
// the new trees are the raw RFC 8785 JCS serialization under I-JSON, with
// object keys sorted by UTF-16 code-unit order (never JS insertion order).
// Sealing is re-implemented per package (§17 packages section: "sealing is
// re-implemented per the trust-layer precedent, with cross-package sealing-
// equivalence fixtures"); this test is the mechanical drift guard that keeps
// a future shared-sealing extraction trivial (design §17; Phase-0 open
// question 2 disposition: defer extraction, ship the fixtures).

function trustCoreSeal(value: unknown): { bytes: Uint8Array; digest: `sha256:${string}` } {
  const bytes = canonicalJsonBytes(value);
  return { bytes, digest: recordDigest(bytes) };
}

const fixtureRoot = new URL("../fixtures/equivalence/", import.meta.url);

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(`${name}.json`, fixtureRoot), "utf8"));
}

describe("sealJson is byte-identical to trust-core's canonicalJsonBytes/recordDigest", () => {
  const cases = ["simple", "key-shuffled", "nested"];

  for (const name of cases) {
    it(`matches trust-core for the "${name}" fixture`, async () => {
      const value = await fixture(name);
      const discovery = sealJson(value);
      const trust = trustCoreSeal(value);
      expect(discovery.digest).toBe(trust.digest);
      expect(discovery.bytes).toEqual(trust.bytes);
    });
  }

  it("agrees with trust-core that key order in the input never affects the sealed digest", async () => {
    const simple = await fixture("simple");
    const shuffled = await fixture("key-shuffled");
    expect(sealJson(simple).digest).toBe(sealJson(shuffled).digest);
    expect(trustCoreSeal(simple).digest).toBe(trustCoreSeal(shuffled).digest);
  });
});

// Program ruling §7.11: DISCOVERY_SIGNING_SCOPE is conformant with trust-
// core's namespaced-scope grammar (`namespace:custom`); both trees cite the
// same constant, and this is the cross-tree assertion that it parses under
// trust-core's ScopeVocabulary.
describe("DISCOVERY_SIGNING_SCOPE parses under trust-core's ScopeVocabulary", () => {
  it("parses as a namespaced scope extension", () => {
    expect(ScopeSchema.parse(DISCOVERY_SIGNING_SCOPE)).toBe(DISCOVERY_SIGNING_SCOPE);
  });
});
