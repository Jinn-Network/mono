import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { canonicalJsonBytes } from "./canonical-json.js";
import { recordDigest } from "./hashing.js";

// Four representative structured records -- one per sealed record family
// this package will implement (Tasks T4-T7). These are literal, structurally
// representative fixtures, not schema-validated instances; the point of this
// test is to pin the sealing spine's output (canonicalJsonBytes + hashing),
// independent of any one family's eventual Zod schema.
const FIXTURES = {
  "key-binding": {
    protocol: "https://jinn.network/trust/key-binding/v1",
    agent: "urn:uuid:11111111-1111-4111-8111-111111111111",
    key: {
      algorithm: "secp256k1",
      didKey: "did:key:z6MkfriendlyWorkingKey",
      keyid: "did:key:z6MkfriendlyWorkingKey",
      publicKey: "0x04abcdef",
    },
    voucher: "did:pkh:eip155:8453:0xAbCdEf0123456789aBcDef0123456789ABcDeF0",
    relationship: "controls",
    scope: ["deliveries", "verdicts"],
    validFrom: "2026-07-28T00:00:00Z",
    ceremony: { digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", type: "eoa" },
    strength: "strong",
    anchors: [],
  },
  revocation: {
    protocol: "https://jinn.network/trust/revocation/v1",
    target: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    revokedBy: "did:pkh:eip155:8453:0xAbCdEf0123456789aBcDef0123456789ABcDeF0",
    effectiveFrom: "2026-07-29T00:00:00Z",
    anchors: [],
  },
  policy: {
    protocol: "https://jinn.network/trust/policy/v1",
    version: 1,
    purposes: {
      "verifier-agent": {
        accepted: ["urn:uuid:22222222-2222-4222-8222-222222222222"],
        requiredStrength: "strong",
      },
    },
    signerSet: ["did:key:z6MkfriendlyWorkingKey"],
    refreshBy: "2026-08-28T00:00:00Z",
  },
  authorization: {
    _type: "https://in-toto.io/Statement/v1",
    predicate: {
      capabilities: ["deliveries:submit"],
      expiry: "2026-08-01T00:00:00Z",
      issuer: "urn:uuid:11111111-1111-4111-8111-111111111111",
      nonce: "n-1",
    },
    predicateType: "https://jinn.network/trust/authorization/v1",
    subject: [{ digest: { sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" }, name: "input-digest" }],
  },
} as const;

const expectedDigestsPath = fileURLToPath(
  new URL("../fixtures/sealing-v1/expected-digests.json", import.meta.url),
);
const expectedDigests: Record<string, string> = JSON.parse(
  readFileSync(expectedDigestsPath, "utf8"),
);

describe("sealing-v1 pinned-digest goldens", () => {
  for (const [family, fixture] of Object.entries(FIXTURES)) {
    test(`${family} canonicalizes to its pinned digest`, () => {
      const digest = recordDigest(canonicalJsonBytes(fixture));
      const expected = expectedDigests[family];
      if (expected === undefined) {
        throw new Error(
          `No pinned digest for "${family}" yet -- actual digest: ${digest}\n`
            + "Paste this into fixtures/sealing-v1/expected-digests.json and re-run.",
        );
      }
      expect(digest).toBe(expected);
    });
  }
});
