import { sha256Hex } from "@jinn-network/task-execution-protocol";
import { describe, expect, test } from "vitest";
import {
  computeRawCodecCid,
  decodeRawCodecCidDigestHex,
  rawCodecCidFromSha256Digest,
  uploadRawCodecCid,
} from "./ipfs.js";

describe("computeRawCodecCid", () => {
  test("the CID digest equals sha256 of the exact bytes -- raw codec, no dag-pb wrapping (§3 audit)", () => {
    const bytes = new TextEncoder().encode('{"hello":"world"}');
    const { cid, sha256Digest } = computeRawCodecCid(bytes);
    expect(sha256Digest).toBe(`sha256:${sha256Hex(bytes)}`);
    expect(decodeRawCodecCidDigestHex(cid)).toBe(sha256Hex(bytes));
  });

  test("is a canonical CIDv1 base32 raw-codec string (starts with 'b', RFC4648 lowercase)", () => {
    const bytes = new TextEncoder().encode("some content");
    const { cid } = computeRawCodecCid(bytes);
    expect(cid).toMatch(/^b[a-z2-7]+$/);
    expect(cid.length).toBe(59); // 36 bytes -> ceil(36*8/5) = 58 base32 chars + 'b' prefix
  });

  test("is deterministic: the same bytes always produce the same CID", () => {
    const bytes = new TextEncoder().encode("deterministic");
    expect(computeRawCodecCid(bytes).cid).toBe(computeRawCodecCid(bytes).cid);
  });

  test("distinct bytes produce distinct CIDs", () => {
    const a = computeRawCodecCid(new TextEncoder().encode("a")).cid;
    const b = computeRawCodecCid(new TextEncoder().encode("b")).cid;
    expect(a).not.toBe(b);
  });
});

describe("rawCodecCidFromSha256Digest", () => {
  test("reconstructs the same canonical CID that exact bytes produce", () => {
    const bytes = new TextEncoder().encode("advertised delivery");
    const computed = computeRawCodecCid(bytes);

    expect(rawCodecCidFromSha256Digest(computed.sha256Digest)).toBe(computed.cid);
  });

  test("refuses a digest outside the lowercase sha256 digest domain", () => {
    expect(() => rawCodecCidFromSha256Digest(`sha256:${"A".repeat(64)}` as `sha256:${string}`))
      .toThrow(/lowercase sha256/u);
  });
});

describe("uploadRawCodecCid", () => {
  test("computes the CID locally (never trusts a gateway-returned CID) and pins the exact bytes via the injected port", async () => {
    const bytes = new TextEncoder().encode('{"pinned":true}');
    const pinned: Uint8Array[] = [];
    const result = await uploadRawCodecCid(bytes, {
      pin: async (b) => {
        pinned.push(b);
      },
    });
    expect(result).toEqual(computeRawCodecCid(bytes));
    expect(pinned).toHaveLength(1);
    expect(pinned[0]).toEqual(bytes);
  });

  test("propagates a pin-port failure rather than returning a CID for unpinned bytes", async () => {
    const bytes = new TextEncoder().encode("unpinnable");
    await expect(
      uploadRawCodecCid(bytes, {
        pin: async () => {
          throw new Error("gateway unreachable");
        },
      }),
    ).rejects.toThrow(/gateway unreachable/);
  });
});
