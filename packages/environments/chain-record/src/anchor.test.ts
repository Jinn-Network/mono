import { describe, expect, test } from "vitest";

import { anchorAuthenticityBoundOf, ChainSourceAnchorSchema } from "./anchor.js";

const anchor = () => ({
  caip2ChainId: "eip155:1",
  nativeChainId: 1,
  genesisHash: `0x${"d".repeat(64)}`,
  blockNumber: 21_000_000,
  blockHash: `0x${"e".repeat(64)}`,
  stateRoot: `0x${"f".repeat(64)}`,
  timestamp: 1_735_689_600,
  finalityPolicy: "finalized",
});

describe("source anchor (§4.3)", () => {
  test("accepts a fully declared anchor", () => {
    expect(ChainSourceAnchorSchema.safeParse(anchor()).success).toBe(true);
  });

  test("refuses a CAIP-2 id that disagrees with the native chain id", () => {
    expect(
      ChainSourceAnchorSchema.safeParse({ ...anchor(), caip2ChainId: "eip155:8453" }).success,
    ).toBe(false);
  });

  test("accepts a confirmations-based finality policy", () => {
    expect(
      ChainSourceAnchorSchema.safeParse({ ...anchor(), finalityPolicy: "confirmations:64" }).success,
    ).toBe(true);
    expect(
      ChainSourceAnchorSchema.safeParse({ ...anchor(), finalityPolicy: "confirmations:0" }).success,
    ).toBe(false);
  });

  test("requires the block hash: it is what makes root-to-hash falsifiable from one header", () => {
    const document = anchor() as Record<string, unknown>;
    delete document.blockHash;
    expect(ChainSourceAnchorSchema.safeParse(document).success).toBe(false);
  });
});

// E5, in code. The anchor bound is a property a consumer can compute from the record alone;
// CE3 states the resulting case in the attestation rather than inferring it.
describe("the anchor-authenticity bound (E5)", () => {
  test("an anchor with no header proof binds the subset to a DECLARED root", () => {
    expect(anchorAuthenticityBoundOf(ChainSourceAnchorSchema.parse(anchor()))).toBe("declared");
  });

  test("an anchor committing a header-proof artifact is header-proven", () => {
    const withProof = ChainSourceAnchorSchema.parse({
      ...anchor(),
      headerProof: { name: "header-proof", digest: { sha256: "9".repeat(64) } },
    });
    expect(anchorAuthenticityBoundOf(withProof)).toBe("header-proven");
  });

  test("a record with no anchor claims no source correspondence at all", () => {
    expect(anchorAuthenticityBoundOf(undefined)).toBe("not-anchored");
  });
});
