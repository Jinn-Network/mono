// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import { canonicalJsonBytes } from "./canonical-json.js";
import { recoverEip191Address } from "./ceremony.js";
import { dssePreAuthEncoding, parseExactDsseEnvelope } from "./dsse.js";
import { TRUST_KEY_BINDING_FORMAT, TRUST_KEY_BINDING_MEDIA_TYPE, TRUST_REVOCATION_MEDIA_TYPE } from "./identifiers.js";
import type { ResolvedBinding } from "./interfaces.js";
import type { KeyBinding } from "./key-binding.js";
import type { DsseChainVerifier } from "./policy.js";
import { validateRevocation } from "./revocation.js";
import { didPkh } from "./spellings.js";
import type { VoucherIdentity } from "./spellings.js";
import type { Sha256Digest } from "./types.js";
import { checkBindingRevocation } from "./verify.js";

// The specification's `key-authority-v1` vectors that this package runs, copied byte for byte from
// the commit `provenance.json` names. Only the `account-signature` group is here: its cases state a
// revocation directly, where the other groups state worlds a store resolver has to build.
const FIXTURES = new URL("./__fixtures__/", import.meta.url);
const GROUP = "key-authority-v1/account-signature/";

interface Provenance {
  readonly repository: string;
  readonly commit: string;
  readonly root: string;
  readonly entries: readonly { readonly id: string; readonly sha256: string }[];
}

interface AccountSignatureVector {
  readonly name: string;
  readonly input: {
    readonly voucher: Extract<VoucherIdentity, { kind: "account" }>;
    readonly envelope: unknown;
  };
  readonly expect: "signed" | "not-signed" | "no-effect";
}

const provenance = JSON.parse(readFileSync(new URL("key-authority-v1/provenance.json", FIXTURES), "utf8")) as Provenance;
const vectors = provenance.entries.map(({ id }) =>
  JSON.parse(readFileSync(new URL(id, FIXTURES), "utf8")) as AccountSignatureVector);

/**
 * Section 8, "An account's signature": a DSSE signature whose keyid is the account's `did:pkh`,
 * a 65-byte EIP-191 `personal_sign` signature over the pre-authentication encoding of the
 * envelope's payload type and payload, recovering to that account.
 */
const accountSignatureVerifier: DsseChainVerifier = (envelopeBytes) => {
  const envelope = parseExactDsseEnvelope(envelopeBytes);
  const pae = dssePreAuthEncoding(envelope.payloadType, envelope.payloadBytes);
  return {
    validSignerKeyids: envelope.signatures.flatMap(({ keyid, sig }) => {
      const chainId = /^did:pkh:eip155:([0-9]+):0x[0-9a-fA-F]{40}$/u.exec(keyid ?? "")?.[1];
      if (keyid === undefined || chainId === undefined || envelope.payloadType !== TRUST_REVOCATION_MEDIA_TYPE) return [];
      try {
        return didPkh(chainId, recoverEip191Address(pae, new Uint8Array(Buffer.from(sig, "base64")))) === keyid ? [keyid] : [];
      } catch {
        return [];
      }
    }),
  };
};

/** The binding the vector's revocation reaches: vouched by `voucher`, filed under the digest the
 * revocation names, and in place before it. */
function bindingReached(voucher: AccountSignatureVector["input"]["voucher"], envelopeBytes: Uint8Array): ResolvedBinding {
  const revocation = validateRevocation(envelopeBytes).value;
  if (revocation === undefined) throw new Error("the vector's envelope is not a revocation record");
  const key = "did:key:z6MkfACCOUNTSIGNATURE1111111111111111111111";
  const binding: KeyBinding = {
    protocol: TRUST_KEY_BINDING_FORMAT,
    agent: "urn:uuid:dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    key: { publicKey: "0x00", keyid: key, algorithm: "ed25519", didKey: key },
    voucher,
    relationship: "controls",
    scope: ["verdicts", "bindings"],
    validFrom: "2026-07-01T00:00:00Z",
    ceremony: { type: voucher.contractAccount ? "safe" : "eoa", digest: `sha256:${"e".repeat(64)}` },
    strength: "strong",
    anchors: [],
  };
  return {
    binding,
    envelopeBytes: canonicalJsonBytes({ payloadType: TRUST_KEY_BINDING_MEDIA_TYPE, binding }),
    bindingDigest: revocation.target as Sha256Digest,
    effectiveStart: "2026-07-01T00:00:00Z",
    isGenesis: true,
    revocations: [{ revocation, envelopeBytes, effectiveTime: revocation.effectiveFrom }],
  };
}

/** Whether the vector's revocation counts against the binding it reaches, at its own effective time. */
async function revocationCounts(voucher: AccountSignatureVector["input"]["voucher"], envelopeBytes: Uint8Array): Promise<boolean> {
  const reached = bindingReached(voucher, envelopeBytes);
  const outcome = await checkBindingRevocation(reached, reached.revocations[0]!.effectiveTime, {
    bindingResolver: { resolveBinding: async () => null },
    witnessVerifier: { verify1271Witness: async () => ({ verified: true }) },
    dsseVerifier: accountSignatureVerifier,
  });
  return !outcome.ok;
}

describe("key-authority-v1 account-signature vectors", () => {
  test("are the bytes the specification published at the recorded commit", () => {
    expect(provenance.repository).toBe("https://github.com/Jinn-Network/spec");
    expect(provenance.commit).toMatch(/^[0-9a-f]{40}$/u);
    const onDisk = readdirSync(new URL(GROUP, FIXTURES)).map((name) => `${GROUP}${name}`).sort();
    expect(onDisk).toEqual(provenance.entries.map(({ id }) => id).sort());
    for (const { id, sha256 } of provenance.entries) {
      expect(createHash("sha256").update(readFileSync(new URL(id, FIXTURES))).digest("hex"), id).toBe(sha256);
    }
  });

  test.each(vectors.map((vector) => [vector.name, vector] as const))("%s", async (_name, vector) => {
    const envelopeBytes = canonicalJsonBytes(vector.input.envelope);
    const { voucher } = vector.input;
    const signed = accountSignatureVerifier(envelopeBytes).validSignerKeyids.includes(voucher.did);
    const counts = await revocationCounts(voucher, envelopeBytes);
    switch (vector.expect) {
      case "signed":
        expect({ signed, counts }).toEqual({ signed: true, counts: true });
        break;
      case "not-signed":
        expect({ signed, counts }).toEqual({ signed: false, counts: false });
        break;
      case "no-effect":
        expect(counts).toBe(false);
        // Whatever the signature holds: where it is the account's own, the same revocation
        // counts once the voucher is not a contract account, so `contractAccount` is what refuses it.
        if (signed) expect(await revocationCounts({ ...voucher, contractAccount: false }, envelopeBytes)).toBe(true);
        break;
    }
  });
});
