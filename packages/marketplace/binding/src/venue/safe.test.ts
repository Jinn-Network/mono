import { describe, expect, test } from "vitest";
import { buildSafeSignature } from "./safe.js";

describe("buildSafeSignature", () => {
  test("encodes signer address as r, zero as s, and v=01 (Safe approved-hash convention)", () => {
    const sig = buildSafeSignature("0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98");
    expect(sig).toBe(
      "0x" + "0".repeat(24) + "8a34793e10595c89b7e41cc7ff0f76850f44ad98" + "0".repeat(64) + "01",
    );
    expect(sig.length).toBe(2 + 65 * 2); // 65-byte signature
  });
});
