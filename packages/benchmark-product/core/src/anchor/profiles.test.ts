import { describe, expect, test } from "vitest";
import {
  OPENTIMESTAMPS_ANCHOR_PROFILE,
  RFC3161_TSA_ANCHOR_PROFILE,
  decodeAnchorProofContent,
} from "@jinn-network/trust-core";
import {
  OPENTIMESTAMPS_PROOF_MEDIA_TYPE as KIT_OTS_MEDIA_TYPE,
  RFC3161_TOKEN_MEDIA_TYPE as KIT_TOKEN_MEDIA_TYPE,
  encodeProofContent as kitEncodeProofContent,
} from "@jinn-network/trust-testing";
import {
  OPENTIMESTAMPS_PROOF_MEDIA_TYPE,
  RFC3161_TOKEN_MEDIA_TYPE,
  anchorProofMediaType,
  encodeAnchorProofContent,
  isProducibleAnchorProfile,
} from "./profiles.js";

describe("proof media types", () => {
  test("are the design's own literals, and agree with the conformance kit's", () => {
    expect(RFC3161_TOKEN_MEDIA_TYPE).toBe("application/vnd.etsi.timestamp-token");
    expect(OPENTIMESTAMPS_PROOF_MEDIA_TYPE).toBe("application/vnd.opentimestamps.ots");
    expect(RFC3161_TOKEN_MEDIA_TYPE).toBe(KIT_TOKEN_MEDIA_TYPE);
    expect(OPENTIMESTAMPS_PROOF_MEDIA_TYPE).toBe(KIT_OTS_MEDIA_TYPE);
  });

  test("never label a bare token as the full TimeStampResp type", () => {
    expect(RFC3161_TOKEN_MEDIA_TYPE).not.toBe("application/timestamp-reply");
  });

  test("are selected by profile", () => {
    expect(anchorProofMediaType(RFC3161_TSA_ANCHOR_PROFILE)).toBe(RFC3161_TOKEN_MEDIA_TYPE);
    expect(anchorProofMediaType(OPENTIMESTAMPS_ANCHOR_PROFILE)).toBe(OPENTIMESTAMPS_PROOF_MEDIA_TYPE);
  });
});

describe("isProducibleAnchorProfile", () => {
  test("admits exactly the two profiles this product can acquire for", () => {
    expect(isProducibleAnchorProfile(RFC3161_TSA_ANCHOR_PROFILE)).toBe(true);
    expect(isProducibleAnchorProfile(OPENTIMESTAMPS_ANCHOR_PROFILE)).toBe(true);
    expect(isProducibleAnchorProfile("https://spec.jinn.network/trust/anchor-locators/base-sepolia-calldata-v1"))
      .toBe(false);
  });
});

describe("encodeAnchorProofContent", () => {
  const cases = [
    new Uint8Array(0),
    Uint8Array.of(0),
    Uint8Array.of(0xff, 0xfe),
    Uint8Array.of(1, 2, 3),
    Uint8Array.of(1, 2, 3, 4),
    Uint8Array.from({ length: 257 }, (_value, index) => index % 256),
  ];

  test("is the exact inverse of trust-core's only sanctioned decoder", () => {
    for (const bytes of cases.slice(1)) {
      expect(Array.from(decodeAnchorProofContent(encodeAnchorProofContent(bytes)))).toEqual(Array.from(bytes));
    }
  });

  test("agrees byte for byte with the conformance kit's encoder", () => {
    for (const bytes of cases) {
      expect(encodeAnchorProofContent(bytes)).toBe(kitEncodeProofContent(bytes));
    }
  });

  test("emits canonical padded standard base64 — never the URL-safe alphabet, never unpadded", () => {
    const encoded = encodeAnchorProofContent(Uint8Array.of(0xfb, 0xff, 0xbf));
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(encoded).toContain("+");
    expect(encodeAnchorProofContent(Uint8Array.of(1)).endsWith("==")).toBe(true);
  });
});
