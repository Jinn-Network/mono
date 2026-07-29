import { sha256Hex } from "@jinn-network/task-execution-protocol";
import { describe, expect, test } from "vitest";
import { checkDeliveryCorrespondence, convergeDelivery } from "./delivery.js";
import { keccakEvidenceHash, rejectZeroEvidenceHash } from "./venue/digest.js";

describe("convergeDelivery", () => {
  test("pins exact sealed bytes and computes both today-mode digests from them", async () => {
    const sealed = new TextEncoder().encode("sealed delivery");
    const pinned: Uint8Array[] = [];
    const result = await convergeDelivery(sealed, { pin: async (bytes) => { pinned.push(bytes); } });
    expect(result.sha256Digest).toBe(`sha256:${sha256Hex(sealed)}`);
    expect(result.keccakEvidenceHash).toBe(keccakEvidenceHash(sealed));
    expect(pinned).toEqual([sealed]);
  });

  test("returns a typed divergence if either asserted digest disagrees with chain facts", () => {
    const digest = `sha256:${"a".repeat(64)}` as const;
    const hash = `0x${"b".repeat(64)}` as const;
    expect(checkDeliveryCorrespondence({ sha256Digest: digest, keccakEvidenceHash: hash, onChainSha256CidDigest: digest, onChainKeccak: hash })).toEqual({ ok: true });
    expect(checkDeliveryCorrespondence({ sha256Digest: digest, keccakEvidenceHash: hash, onChainSha256CidDigest: digest, onChainKeccak: `0x${"c".repeat(64)}` })).toMatchObject({ ok: false, kind: "digest-divergence" });
  });

  test("retains the all-zero evidence-hash guard before a delivery claim", () => {
    expect(() => rejectZeroEvidenceHash(`0x${"0".repeat(64)}`)).toThrow(/all-zero/);
  });
});
