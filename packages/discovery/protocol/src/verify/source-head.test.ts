import { describe, it, expect } from "vitest";
import type { DsseEnvelope } from "@jinn-network/trust-core";
import { RECORD_DISCOVERY_VERSION, GENESIS_SEQUENCE, MEDIA_HEAD, MEDIA_ENTRY } from "../identifiers.js";
import { sealJson } from "../sealing.js";
import { sha256Hex } from "../hashing.js";
import { dssePreAuthEncoding } from "../dsse.js";
import type { SourceHead } from "../head.js";
import { verifySourceHead } from "./source-head.js";
import type { FreshnessPolicy, KeyResolver, ResolvedKey, SignatureVerifier } from "./ports.js";

// `source-head-revalidation` (#3443): steps 1-3 of source-chain-verification
// applied to a head that names the position the consumer already holds. What
// these tests pin is that "already accepted once" buys the head NOTHING --
// every gate short of the chain walk is re-run on every call.

const AGENT = "did:key:zAgentSourceOne";
const KEYID = "key-1";
const SOURCE = { agent: AGENT, name: "feed" };
const NOW = new Date("2026-07-28T00:00:00.000Z");

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fakeSig(pae: Uint8Array, keyid = KEYID): Uint8Array {
  return new TextEncoder().encode(`${sha256Hex(pae)}:${keyid}`);
}

const keys: KeyResolver = {
  async resolve(): Promise<ResolvedKey[]> {
    return [{ keyid: KEYID, publicKey: "fake", algorithm: "fake" }];
  },
  async everBound(): Promise<boolean> {
    return true;
  },
};
const sigs: SignatureVerifier = {
  async verify(pae, sig, key): Promise<boolean> {
    return new TextDecoder().decode(sig) === `${sha256Hex(pae)}:${key.keyid}`;
  },
};
const fresh: FreshnessPolicy = {
  isFresh(refreshBy: string, now: Date): boolean {
    return new Date(refreshBy).getTime() > now.getTime();
  },
};

const ports = { keys, sigs, fresh, now: NOW };

function makeHead(overrides: Partial<SourceHead> = {}): SourceHead {
  return {
    protocol: RECORD_DISCOVERY_VERSION,
    origin: `${AGENT}/feed`,
    sequence: GENESIS_SEQUENCE,
    entry: `sha256:${"a".repeat(64)}`,
    issuedAt: "2026-07-27T12:00:00.000Z",
    refreshBy: "2026-07-29T00:00:00.000Z",
    ...overrides,
  };
}

function signedHead(head: SourceHead, keyid = KEYID, payloadType: string = MEDIA_HEAD): DsseEnvelope {
  const payload = sealJson(head).bytes;
  const pae = dssePreAuthEncoding(payloadType, payload);
  return {
    payloadType: payloadType as typeof MEDIA_HEAD,
    payload: encodeBase64(payload),
    signatures: [{ keyid, sig: encodeBase64(fakeSig(pae, keyid)) }],
  };
}

describe("verifySourceHead", () => {
  it("accepts a head this consumer has already accepted, re-served unchanged", async () => {
    const head = makeHead();
    expect(await verifySourceHead({ source: SOURCE, head, headSignature: signedHead(head), ports })).toEqual({
      status: "ok",
    });
  });

  it("refuses a head that has crossed refreshBy, however often it was accepted before", async () => {
    const head = makeHead({ refreshBy: "2026-07-27T00:00:00.000Z" });
    expect(await verifySourceHead({ source: SOURCE, head, headSignature: signedHead(head), ports })).toEqual({
      status: "stale",
    });
  });

  it("refuses a head signed by a key that is not currently valid", async () => {
    // The signature itself is well-formed and verifies -- it is the key's
    // standing at `now` that fails, which is the revocation/rotation gate a
    // cached acceptance would have skipped.
    const head = makeHead();
    expect(
      await verifySourceHead({ source: SOURCE, head, headSignature: signedHead(head, "rotated-out"), ports }),
    ).toEqual({ status: "unauthorized-signer" });
  });

  it("refuses an envelope whose payload is not these head bytes", async () => {
    const head = makeHead();
    const other = makeHead({ issuedAt: "2026-07-27T13:00:00.000Z" });
    expect(await verifySourceHead({ source: SOURCE, head, headSignature: signedHead(other), ports })).toEqual({
      status: "head-payload-mismatch",
    });
  });

  it("refuses an envelope that is not a head envelope", async () => {
    const head = makeHead();
    expect(
      await verifySourceHead({ source: SOURCE, head, headSignature: signedHead(head, KEYID, MEDIA_ENTRY), ports }),
    ).toEqual({ status: "head-payload-mismatch" });
  });

  it("refuses an unparseable envelope", async () => {
    const head = makeHead();
    const broken = { payloadType: MEDIA_HEAD, payload: "!!!not-base64!!!", signatures: [] } as unknown as DsseEnvelope;
    expect(await verifySourceHead({ source: SOURCE, head, headSignature: broken, ports })).toEqual({
      status: "invalid-head-envelope",
    });
  });

  it("refuses a head whose origin names an agent other than the source being followed", async () => {
    // Keys are resolved from the head's own origin, so without this binding an
    // impostor's validly-signed head would satisfy a poll of this source.
    const head = makeHead({ origin: "did:key:zImpostor/feed" });
    expect(await verifySourceHead({ source: SOURCE, head, headSignature: signedHead(head), ports })).toEqual({
      status: "head-origin-mismatch",
    });
  });

  it("refuses a head whose origin names another source of the same agent", async () => {
    const head = makeHead({ origin: `${AGENT}/other-feed` });
    expect(await verifySourceHead({ source: SOURCE, head, headSignature: signedHead(head), ports })).toEqual({
      status: "head-origin-mismatch",
    });
  });
});
