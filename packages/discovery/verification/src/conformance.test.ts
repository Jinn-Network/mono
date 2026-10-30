// SPDX-License-Identifier: Apache-2.0

/**
 * The published conformance vectors for what this package holds, read through the fixture exports
 * of the packages that vendor them and checked against their digest manifests first, so a vector
 * that changed fails here as a vector and not as a mystery.
 *
 * The two golden DSSE claims in `@jinn-network/evidence-protocol` are the only published envelopes
 * whose signatures another implementation made.
 */

import { createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import {
  TRUST_KEY_BINDING_MEDIA_TYPE,
  sealAnchorEvidence,
  sealAuthorization,
  sealKeyBinding,
  sealRevocation,
  sealSignedRecord,
  sealTrustPolicy,
} from "@jinn-network/trust-core";
import type { DsseSigner, SealedRecord } from "@jinn-network/trust-core";

import {
  createDidKeyDsseVerifier,
  didKeyFromEd25519PublicKey,
  recordDigest,
  verifyDsseSignatures,
} from "./index.js";

const require = createRequire(import.meta.url);

function vector(specifier: string): Uint8Array {
  return new Uint8Array(readFileSync(require.resolve(specifier)));
}

function json<T = unknown>(bytes: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

interface DigestManifest {
  readonly entries: readonly { readonly id: string; readonly sha256: string }[];
}

const TRUST = "@jinn-network/trust-core/fixtures";
const EVIDENCE = "@jinn-network/evidence-protocol/fixtures";

const placeholderSigner = (keyid: string, ...signature: number[]): DsseSigner =>
  async () => [{ signature: new Uint8Array(signature), keyid }];

const PLACEHOLDER_KEY = "did:key:z6MkfriendlyWorkingKey";
const POLICY_KEY = "did:key:z6MkhaTEeQnCVYnQwFRZmpFotWSU7Fdd5tkVEQxCwPvzMWzz";

/** How each sealing-v1 vector was sealed, by the signer trust-core's own vector tests pin. */
const SEALED_VECTORS: Readonly<Record<string, (document: never) => Promise<SealedRecord>>> = {
  "key-binding": (document) => sealKeyBinding(document, placeholderSigner(PLACEHOLDER_KEY, 1, 2, 3)),
  revocation: (document) => sealRevocation(document, placeholderSigner(PLACEHOLDER_KEY, 4, 5, 6)),
  authorization: (document) => sealAuthorization(document, placeholderSigner(PLACEHOLDER_KEY, 7, 8, 9)),
  policy: (document) => sealTrustPolicy(document, placeholderSigner(POLICY_KEY, 1)),
};

describe("sealing-v1 and anchor-evidence-v1", () => {
  const manifest = json<DigestManifest>(vector(`${TRUST}/manifest.sha256.json`));
  const entries = manifest.entries.filter(({ id }) => /^(?:sealing|anchor-evidence)-v1\//u.test(id));

  test("the manifest names every vector this suite reads", () => {
    expect(entries.map(({ id }) => id)).toEqual([
      "anchor-evidence-v1/expected-digests.json",
      "anchor-evidence-v1/golden.json",
      "sealing-v1/authorization.json",
      "sealing-v1/expected-digests.json",
      "sealing-v1/key-binding.json",
      "sealing-v1/policy.json",
      "sealing-v1/revocation.json",
    ]);
  });

  test.each(entries)("recordDigest of $id equals its manifest digest", ({ id, sha256 }) => {
    expect(recordDigest(vector(`${TRUST}/${id}`))).toBe(`sha256:${sha256}`);
  });

  const expected = json<Record<string, string>>(vector(`${TRUST}/sealing-v1/expected-digests.json`));

  test.each(Object.keys(SEALED_VECTORS))("recordDigest of the sealed %s vector equals its pinned digest", async (family) => {
    const sealed = await SEALED_VECTORS[family]!(json<never>(vector(`${TRUST}/sealing-v1/${family}.json`)));
    expect(recordDigest(sealed.envelopeBytes)).toBe(expected[`${family}-golden`]);
  });

  test("recordDigest of the sealed anchor evidence vector equals its pinned digest", () => {
    const pinned = json<Record<string, string>>(vector(`${TRUST}/anchor-evidence-v1/expected-digests.json`));
    const { bytes } = sealAnchorEvidence(json<never>(vector(`${TRUST}/anchor-evidence-v1/golden.json`)));
    expect(recordDigest(bytes)).toBe(pinned["anchor-evidence-golden"]);
  });

  test.each(Object.keys(SEALED_VECTORS))("the sealed %s vector's placeholder signature is reported by nobody", async (family) => {
    const { envelopeBytes } = await SEALED_VECTORS[family]!(json<never>(vector(`${TRUST}/sealing-v1/${family}.json`)));
    expect(createDidKeyDsseVerifier()(envelopeBytes)).toEqual({ validSignerKeyids: [] });
  });

  test("the key-binding vector, sealed with a real key, verifies by its did:key", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const keyid = didKeyFromEd25519PublicKey(publicKey);
    const { envelopeBytes } = await sealSignedRecord({
      record: json(vector(`${TRUST}/sealing-v1/key-binding.json`)),
      payloadType: TRUST_KEY_BINDING_MEDIA_TYPE,
      signer: async ({ preAuthEncoding }) => [
        { signature: new Uint8Array(sign(null, preAuthEncoding, privateKey)), keyid },
      ],
    });
    expect(createDidKeyDsseVerifier()(envelopeBytes)).toEqual({ validSignerKeyids: [keyid] });
  });
});

describe.each(["execution-verification", "result-evaluation"])("the golden %s claim", (name) => {
  const directory = `golden-execution-evidence-v1/claims/${name}`;
  const manifest = json<DigestManifest>(vector(`${EVIDENCE}/manifest.sha256.json`));
  const envelopeBytes = vector(`${EVIDENCE}/${directory}/${name}.dsse.json`);
  const pem = vector(`${EVIDENCE}/${directory}/public-key.pem`);
  const key = {
    keyId: json<{ signatures: { keyid: string }[] }>(envelopeBytes).signatures[0]!.keyid,
    publicKey: createPublicKey(Buffer.from(pem)),
  };

  test("matches its manifest", () => {
    const digests = new Map(manifest.entries.map(({ id, sha256 }) => [id, `sha256:${sha256}`]));
    expect(recordDigest(envelopeBytes)).toBe(digests.get(`${directory}/${name}.dsse.json`));
    expect(recordDigest(pem)).toBe(digests.get(`${directory}/public-key.pem`));
  });

  test("verifies under its published key", () => {
    expect(verifyDsseSignatures(envelopeBytes, [key], { allowRespelledEnvelope: true }).validSignerKeyids)
      .toEqual([key.keyId]);
  });

  test("names its key by the SHA-256 of the SPKI, not by a did:key", () => {
    const spki = key.publicKey.export({ format: "der", type: "spki" });
    expect(key.keyId).toBe(recordDigest(spki).slice("sha256:".length));
  });

  test("is not in the exact sealed encoding, so the strict default refuses it", () => {
    expect(verifyDsseSignatures(envelopeBytes, [key]).validSignerKeyids).toEqual([]);
  });

  test("stops verifying when one payload byte changes", () => {
    const envelope = json<Record<string, unknown> & { payload: string }>(envelopeBytes);
    const payload = Buffer.from(envelope.payload, "base64");
    payload[0] = payload[0]! ^ 0x01;
    const tampered = new TextEncoder().encode(JSON.stringify({ ...envelope, payload: payload.toString("base64") }));
    expect(verifyDsseSignatures(tampered, [key], { allowRespelledEnvelope: true }).validSignerKeyids).toEqual([]);
  });
});
