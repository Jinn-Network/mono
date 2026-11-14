// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  TRUST_KEY_BINDING_FORMAT,
  ceremonyEvidenceDigest,
  parseDsseEnvelope,
  sealKeyBinding,
  verifyEnvelopeBinding,
  verifyEoaCeremony,
} from "@jinn-network/trust-core";
import type {
  CeremonyCurrencyProfile,
  DsseChainVerifier,
  EoaCeremonyEvidence,
  KeyBinding,
  Sha256Digest,
  SiweCeremonyMessage,
} from "@jinn-network/trust-core";
import { createBindingResolver } from "@jinn-network/trust-resolve";
import { describe, expect, test } from "vitest";

// ---------------------------------------------------------------------------
// The conformance vectors of the ceremony currency text,
// https://spec.jinn.network/profiles/ceremony-currency/v1 §9, copied byte for
// byte from Jinn-Network/spec at SPEC_COMMIT, under SPEC_PATH, into
// `fixtures/ceremony-currency-v1/`. No signed specification release carries
// them yet, so `.github/scripts/sync-spec-release.mjs` cannot vendor them; this
// test pins every file's SHA-256 instead, so a copy that drifts fails here. The
// loader below is local to this file on purpose.
// ---------------------------------------------------------------------------

const SPEC_COMMIT = "a0937a95eab5745882496381146b578aec8788c4";
const SPEC_PATH = "documents/@jinn-network/trust-testing/fixtures/ceremony-currency-v1";

const PINNED: Readonly<Record<string, string>> = {
  "README.md": "d36ebb698a97e368a59bac14b73e854a57677afb98ff49ad26bf19e7eb3d7f5c",
  "commitment-after-a-third-resource.json": "a37a21472c3876e5be03041a6a23cc5938ae70d1b1b7266642b614a12d1a2170",
  "commitment-in-upper-case.json": "471b1b1768868cce9c3d079f02a087ed447a2f09a0ec1bc3e901fab93a2de42b",
  "commitment-not-last.json": "ef6a26b8aeab88e25755d6154d6a2c1bdaca589b0cc900fb9514ee2c3c4b635d",
  "commitment-of-an-unknown-version.json": "ff6cb5d122f741471ca9514a4826e01d90170fbe01438892a97ea0af2102da04",
  "committed-after-the-cutover.json": "e2f9c88b9ad038c9f3b14e8f4cda063c0f94925fd1555e35d289705271f4596f",
  "committed-with-an-expiry.json": "30630c6a7e41b39a5ebb7dfbccc999896a42e5ce424c100f24a9b521f19aa3b2",
  "committed.json": "6abe57a07781172b774e78c5b38caa40ca9a76da11cf29652ecf17ee8e244cb4",
  "domain-in-upper-case.json": "3bad58aa119fa56ff621b963e15ac550a40d655c4518b19f42987c76104f0d1d",
  "end-moved.json": "f75526a2ae61af081526652479050b0bc1cda39edb8fa96c83ae61f467fcf8fa",
  "end-removed.json": "38c71e77746a209061eb00d819a86364bddab024a6e1648b489e3f05a7d24d4b",
  "no-commitment-and-no-cutover.json": "665909ee2335783b62b446fd70d9a38eaacb68084ac04c601bacced504cef7e8",
  "no-commitment-at-the-cutover.json": "188ef4ec31dc00851047e0cd3c9776485f3a42a053ee5caf215f1c7552963cf2",
  "no-commitment-before-the-cutover.json": "86985507fba4919a6df8316ac47f8f1af32034510304455151848c1c6194ec81",
  "other-domain.json": "721c4c3e6fe5958859108ebccc498323856d6e1a3d23010ad05072e9a752d16d",
  "other-relationship.json": "5e9b1413400a2cd53376d6be3b08500985bd0d756f261b8d8f414850fa66a104",
  "other-start.json": "8766cfc77f00003cb7c2159e1f1951bbb4861d4f9840fd39b2527aa8fb59af0a",
  "other-uri.json": "24ac098a463636c73c3c739c97687f39474d2586b03534490bb176a0c21d1966",
  "takes-effect-after-the-expiration.json": "783fcf6217ce654eaedfa3e5c5e01791c6485e49430476d7f08c1ea3ad4340f0",
  "takes-effect-at-the-expiration.json": "3f846bcaddf8c2388ee9be0cdcefd47da84e65064acd883e7355a7e47a13c4ff",
  "takes-effect-before-the-account-vouched.json": "85f56e278c29ce527d69b1bc09f2ad85a1bf25086c43d7dbecb73418d40b6e13",
  "two-commitments.json": "ef6078ca1648271bb3214e6d7fa6d84ee8a1439cabfc89a3491eaee74d9e3853",
  "unreadable-expiration.json": "5d491f49b3edd003ea01553762d5b58f238c0c72fc01317730d99e3f55efef6c",
  "unreadable-issued-at.json": "8e27e2408121724f34567dee7e91fd5072e91675e195eea6801bed1594a21baf",
  "verified-long-after-the-expiration.json": "a02855a9bc5756fc2024189303a8f6749ed50700ce17c11072386602f7f961da",
  "wider-scope.json": "5da02b869ec1dafebdc71ea11cd8ebeec7a63ea0526246d1f747f579daa87a95",
};

/** Cases that fail on the deployment's ceremony domain and URI (section 5), which
 * `matchCeremonyContent` checked before this text. Every other case passes every
 * check that applied before it, so with the text off it verifies. */
const DOMAIN_AND_URI_CASES = new Set(["domain-in-upper-case", "other-domain", "other-uri"]);

interface CeremonyCurrencyVector {
  readonly name: string;
  readonly description: string;
  readonly input: {
    readonly record: Pick<KeyBinding, "agent" | "voucher" | "relationship" | "scope" | "validFrom" | "expiresAt"> & {
      readonly key: { readonly didKey: string };
    };
    readonly ceremony: {
      readonly type: "eoa";
      readonly message: SiweCeremonyMessage;
      readonly messageBytesHex: string;
      readonly signatureHex: string;
    };
    readonly effectiveStart: string;
    readonly cutover?: string;
    readonly verifiedAt?: string;
  };
  readonly expect: "verified" | "ceremony-verification-failed";
}

const directory = fileURLToPath(new URL("../fixtures/ceremony-currency-v1/", import.meta.url));
const vectors: readonly CeremonyCurrencyVector[] = Object.keys(PINNED)
  .filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(readFileSync(`${directory}${name}`, "utf8")) as CeremonyCurrencyVector);

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function evidenceOf(vector: CeremonyCurrencyVector): EoaCeremonyEvidence {
  const { message, messageBytesHex, signatureHex } = vector.input.ceremony;
  return { type: "eoa", message, messageBytes: hexToBytes(messageBytesHex), signature: hexToBytes(signatureHex) };
}

function profileOf(vector: CeremonyCurrencyVector): CeremonyCurrencyProfile {
  return vector.input.cutover === undefined ? {} : { termsCutover: vector.input.cutover };
}

function bindingOf(vector: CeremonyCurrencyVector, anchor: Sha256Digest): KeyBinding {
  const { record } = vector.input;
  const didKey = record.key.didKey;
  return {
    protocol: TRUST_KEY_BINDING_FORMAT,
    agent: record.agent,
    key: { publicKey: didKey, keyid: didKey, algorithm: "Ed25519", didKey },
    voucher: record.voucher,
    relationship: record.relationship,
    scope: [...record.scope],
    validFrom: record.validFrom,
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
    ceremony: { type: "eoa", digest: ceremonyEvidenceDigest(evidenceOf(vector)) },
    strength: "strong",
    anchors: [{ digest: anchor }],
  };
}

/** Trusts each envelope's declared keyids, as the kit's fakes do: the EOA
 * ceremony is the only signature these cases are about, and it is real. */
const declaredSigners: DsseChainVerifier = (envelopeBytes) => ({
  validSignerKeyids: parseDsseEnvelope(envelopeBytes).signatures
    .map((signature) => signature.keyid)
    .filter((keyid): keyid is string => keyid !== undefined),
});

/**
 * The whole procedure: the case's record sealed by its key, anchored at its
 * effective start under a profile that requires anchors, resolved by the real
 * `createBindingResolver`, and verified by `verifyEnvelopeBinding`.
 */
async function verifyThroughTheProcedure(vector: CeremonyCurrencyVector, ceremonyCurrency?: CeremonyCurrencyProfile) {
  const anchor = `sha256:${"a".repeat(64)}` as Sha256Digest;
  const binding = bindingOf(vector, anchor);
  const didKey = binding.key.didKey;
  const sealed = await sealKeyBinding(binding, async () => [{ signature: Uint8Array.of(1), keyid: didKey }]);
  const stored = {
    binding,
    envelopeBytes: sealed.envelopeBytes,
    bindingDigest: sealed.recordDigest,
    ceremonyEvidence: evidenceOf(vector),
  };
  const bindingResolver = createBindingResolver({
    bindings: {
      async listBindingsForAgent(agent) { return agent === binding.agent ? [stored] : []; },
      async listRevocationsForTargets() { return []; },
    },
    anchors: {
      async lookupAnchor(digest) {
        return digest === anchor ? { digest, anchorTime: vector.input.effectiveStart } : null;
      },
    },
    requireAnchors: true,
    recordSignedByItsKey: (record) => declaredSigners(record.envelopeBytes).validSignerKeyids.includes(record.binding.key.didKey),
    ...(ceremonyCurrency === undefined ? {} : { ceremonyCurrency }),
  });
  return verifyEnvelopeBinding(
    {
      envelopeBytes: sealed.envelopeBytes,
      key: didKey,
      agent: binding.agent,
      family: "deliveries",
      // Evidence time, which the ceremony's own times are never compared with.
      atTime: vector.input.verifiedAt ?? vector.input.effectiveStart,
    },
    {
      bindingResolver,
      witnessVerifier: { async verify1271Witness() { return { verified: false }; } },
      dsseVerifier: declaredSigners,
    },
  );
}

describe("ceremony currency vectors (ceremony-currency/v1)", () => {
  test(`the copy is ${SPEC_PATH} at Jinn-Network/spec ${SPEC_COMMIT}, byte for byte`, () => {
    expect(readdirSync(directory).sort()).toEqual(Object.keys(PINNED).sort());
    for (const [name, sha256] of Object.entries(PINNED)) {
      expect(createHash("sha256").update(readFileSync(`${directory}${name}`)).digest("hex"), name).toBe(sha256);
    }
    expect(vectors).toHaveLength(25);
  });

  describe.each(vectors.map((vector) => [vector.name, vector] as const))("%s", (_name, vector) => {
    const verified = vector.expect === "verified";

    test(`verifyEoaCeremony under the text: ${vector.expect}`, () => {
      const result = verifyEoaCeremony(evidenceOf(vector), bindingOf(vector, `sha256:${"a".repeat(64)}`), {
        profile: profileOf(vector),
        effectiveStart: vector.input.effectiveStart,
      });
      expect(result.verified, result.reason).toBe(verified);
    });

    test(`the resolver and verifyEnvelopeBinding under the text: ${vector.expect}`, async () => {
      const outcome = await verifyThroughTheProcedure(vector, profileOf(vector));
      if (verified) {
        expect(outcome, outcome.detail).toMatchObject({ ok: true });
      } else {
        expect(outcome).toMatchObject({ ok: false, reason: "ceremony-verification-failed" });
      }
    });

    test("with the text off, the outcome is the one from before the text", async () => {
      const before = !DOMAIN_AND_URI_CASES.has(vector.name);
      const binding = bindingOf(vector, `sha256:${"a".repeat(64)}`);
      expect(verifyEoaCeremony(evidenceOf(vector), binding).verified).toBe(before);
      const outcome = await verifyThroughTheProcedure(vector);
      expect(outcome.ok, outcome.detail).toBe(before);
      if (!before) expect(outcome.reason).toBe("ceremony-verification-failed");
    });
  });
});
