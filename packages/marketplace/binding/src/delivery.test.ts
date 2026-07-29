import { sealDelivery, sha256Hex } from "@jinn-network/task-execution-protocol";
import { describe, expect, test } from "vitest";
import { checkDeliveryCorrespondence, convergeDelivery } from "./delivery.js";
import { keccakEvidenceHash, rejectZeroEvidenceHash } from "./venue/digest.js";

const ATTEMPT = "urn:uuid:11111111-1111-4111-8111-111111111111";
const EXECUTION = "urn:uuid:22222222-2222-4222-8222-222222222222";

function deliveryBytes(input: {
  readonly executionIds?: readonly string[];
  readonly evidenceRecords?: readonly {
    readonly family: "execution-evidence";
    readonly digest: `sha256:${string}`;
  }[];
  readonly summary?: string;
} = {}): Uint8Array {
  return sealDelivery({
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    attempt: ATTEMPT,
    task: `sha256:${"1".repeat(64)}`,
    outputs: [],
    outcome: "fulfilled",
    executionIds: input.executionIds ?? [EXECUTION],
    evidenceRecords: input.evidenceRecords ?? [
      {
        family: "execution-evidence",
        digest: `sha256:${"2".repeat(64)}`,
      },
    ],
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    createdAt: "2026-07-29T00:00:00Z",
  });
}

/** Admission tests for invalid Unicode must not route through protocol sealing. */
function deliveryBytesFromRecord(record: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(record));
}

function deliveryRecordWithMutation(
  mutate: (record: Record<string, unknown>) => void,
): Uint8Array {
  const record = JSON.parse(new TextDecoder().decode(deliveryBytes())) as Record<string, unknown>;
  mutate(record);
  return deliveryBytesFromRecord(record);
}

describe("convergeDelivery", () => {
  test("validates, pins the exact sealed bytes, and computes both today-mode digests from them", async () => {
    const sealed = deliveryBytes();
    const pinned: Uint8Array[] = [];
    const result = await convergeDelivery(sealed, { pin: async (bytes) => { pinned.push(bytes); } });
    expect(result.sha256Digest).toBe(`sha256:${sha256Hex(sealed)}`);
    expect(result.keccakEvidenceHash).toBe(keccakEvidenceHash(sealed));
    expect(pinned).toEqual([sealed]);
  });

  test("rejects schema-valid but noncanonical Delivery JSON before pinning", async () => {
    const canonical = deliveryBytes();
    const noncanonical = new TextEncoder().encode(
      JSON.stringify(JSON.parse(new TextDecoder().decode(canonical)), null, 2),
    );
    const pinned: Uint8Array[] = [];

    await expect(
      convergeDelivery(noncanonical, { pin: async (bytes) => { pinned.push(bytes); } }),
    ).rejects.toMatchObject({
      kind: "noncanonical-delivery",
      detail: "Delivery bytes do not equal protocol canonical sealed bytes",
    });
    expect(pinned).toEqual([]);
  });

  test("rejects duplicate-key Delivery JSON even when JSON.parse yields a valid record", async () => {
    const canonicalText = new TextDecoder().decode(deliveryBytes());
    const duplicateKeyText = canonicalText.replace(
      `"attempt":"${ATTEMPT}",`,
      `"attempt":"${ATTEMPT}","attempt":"${ATTEMPT}",`,
    );
    const pinned: Uint8Array[] = [];

    await expect(
      convergeDelivery(
        new TextEncoder().encode(duplicateKeyText),
        { pin: async (bytes) => { pinned.push(bytes); } },
      ),
    ).rejects.toMatchObject({
      kind: "noncanonical-delivery",
      detail: "Delivery bytes do not equal protocol canonical sealed bytes",
    });
    expect(pinned).toEqual([]);
  });

  test("rejects an unpaired UTF-16 surrogate before pinning", async () => {
    const unpairedHighSurrogate = String.fromCharCode(0xd800);
    const admittedBytes = deliveryRecordWithMutation((record) => {
      record.summary = unpairedHighSurrogate;
    });
    const pinned: Uint8Array[] = [];

    await expect(
      convergeDelivery(
        admittedBytes,
        { pin: async (bytes) => { pinned.push(bytes); } },
      ),
    ).rejects.toMatchObject({
      kind: "invalid-delivery",
      detail: expect.stringContaining("unpaired UTF-16 surrogate"),
    });
    expect(pinned).toEqual([]);
  });

  test("rejects an unpaired UTF-16 surrogate in a nested extension value before pinning", async () => {
    const unpairedLowSurrogate = String.fromCharCode(0xdc00);
    const admittedBytes = deliveryRecordWithMutation((record) => {
      record["https://example.test/extension"] = {
        note: unpairedLowSurrogate,
      };
    });
    const pinned: Uint8Array[] = [];

    await expect(
      convergeDelivery(
        admittedBytes,
        { pin: async (bytes) => { pinned.push(bytes); } },
      ),
    ).rejects.toMatchObject({
      kind: "invalid-delivery",
      detail: expect.stringContaining("unpaired UTF-16 surrogate"),
    });
    expect(pinned).toEqual([]);
  });

  test("accepts a valid supplementary Unicode scalar", async () => {
    const supplementaryScalar = String.fromCodePoint(0x1f600);
    const sealed = deliveryBytes({ summary: supplementaryScalar });
    const pinned: Uint8Array[] = [];

    await expect(
      convergeDelivery(sealed, { pin: async (bytes) => { pinned.push(bytes); } }),
    ).resolves.toMatchObject({
      sha256Digest: `sha256:${sha256Hex(sealed)}`,
    });
    expect(pinned).toEqual([sealed]);
  });

  test.each([
    {
      label: "executionIds",
      sealed: deliveryBytes({ executionIds: [] }),
      kind: "missing-execution-ids",
      detail: "marketplace Delivery requires at least one executionId",
    },
    {
      label: "evidenceRecords",
      sealed: deliveryBytes({ evidenceRecords: [] }),
      kind: "missing-evidence-records",
      detail: "marketplace Delivery requires at least one evidenceRecord",
    },
  ])("rejects missing mandatory $label before pinning", async ({ sealed, kind, detail }) => {
    const pinned: Uint8Array[] = [];
    await expect(
      convergeDelivery(sealed, { pin: async (bytes) => { pinned.push(bytes); } }),
    ).rejects.toMatchObject({ kind, detail });
    expect(pinned).toEqual([]);
  });

  test("rejects malformed Delivery bytes before pinning", async () => {
    const pinned: Uint8Array[] = [];
    await expect(
      convergeDelivery(
        new TextEncoder().encode("{\"not\":\"a Delivery\"}"),
        { pin: async (bytes) => { pinned.push(bytes); } },
      ),
    ).rejects.toMatchObject({
      kind: "invalid-delivery",
      detail: expect.stringContaining("schema validation"),
    });
    expect(pinned).toEqual([]);
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
