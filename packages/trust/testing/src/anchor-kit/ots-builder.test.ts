// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";

import { bytesToHex, concatenateBytes } from "./der-encoder.js";
import {
  KIT_BITCOIN_BLOCK_HEIGHT,
  KIT_CALENDAR_URI,
  OTS_BITCOIN_ATTESTATION_TAG,
  OTS_HEADER_MAGIC,
  OTS_PENDING_ATTESTATION_TAG,
  applyOtsOperation,
  buildLinearOtsProof,
  buildSyntheticBlockHeader,
  createOpenTimestampsKitFixtures,
  encodeVarbytes,
  encodeVaruint,
  replayOtsOperations,
  serializeDetachedOtsProof,
} from "./ots-builder.js";
import type { OtsOperation } from "./ots-builder.js";

// ---------------------------------------------------------------------------
// The builder is validated two ways, both of them pure:
//
//  - **replay** -- the operation sequence a proof carries, applied by hashing,
//    reaches the commitment the synthetic header carries. That is the whole of
//    what an OpenTimestamps verifier does before it reaches a header, so a
//    builder whose replay did not land would be minting proofs no verifier could
//    ever accept;
//  - **serialization** -- the header magic, varints, operation tags, and
//    attestation tags are asserted against the format's own constants at the
//    byte level, so a kit proof stays readable by the reference tooling.
//
// The serialization was additionally checked against a real calendar response
// captured during the program's P0 gate; the annotated bytes are recorded in
// `fixtures/anchor-kit-v1/cross-validation.md`. That capture is deliberately not
// committed -- the real upgraded proof arrives with the provider packet.
// ---------------------------------------------------------------------------

const DIGEST = sha256(new TextEncoder().encode("anchor kit ots subject"));

describe("varint and varbytes", () => {
  test("a varuint is little-endian base-128 with a continuation bit", () => {
    expect(bytesToHex(encodeVaruint(0))).toBe("00");
    expect(bytesToHex(encodeVaruint(1))).toBe("01");
    expect(bytesToHex(encodeVaruint(127))).toBe("7f");
    expect(bytesToHex(encodeVaruint(128))).toBe("8001");
    // 880017 = 53*128^2 + 91*128 + 17.
    expect(bytesToHex(encodeVaruint(KIT_BITCOIN_BLOCK_HEIGHT))).toBe("91db35");
    expect(KIT_BITCOIN_BLOCK_HEIGHT).toBe(53 * 128 * 128 + 91 * 128 + 17);
    expect(() => encodeVaruint(-1)).toThrow();
  });

  test("varbytes prefixes its length", () => {
    expect(bytesToHex(encodeVarbytes(Uint8Array.of(0xaa, 0xbb)))).toBe("02aabb");
  });
});

describe("replay", () => {
  test("each operation is exactly what its name says", () => {
    expect(bytesToHex(applyOtsOperation(Uint8Array.of(1), { kind: "sha256" })))
      .toBe(bytesToHex(sha256(Uint8Array.of(1))));
    expect(bytesToHex(applyOtsOperation(Uint8Array.of(1), {
      kind: "append",
      argument: Uint8Array.of(2),
    }))).toBe("0102");
    expect(bytesToHex(applyOtsOperation(Uint8Array.of(1), {
      kind: "prepend",
      argument: Uint8Array.of(2),
    }))).toBe("0201");
  });

  test("a sequence replays to the commitment, computed here independently", () => {
    const operations: readonly OtsOperation[] = [
      { kind: "append", argument: Uint8Array.of(0xaa) },
      { kind: "sha256" },
      { kind: "prepend", argument: Uint8Array.of(0xbb) },
      { kind: "sha256" },
    ];
    const expected = sha256(concatenateBytes([
      Uint8Array.of(0xbb),
      sha256(concatenateBytes([DIGEST, Uint8Array.of(0xaa)])),
    ]));
    expect(bytesToHex(replayOtsOperations(DIGEST, operations))).toBe(bytesToHex(expected));
  });
});

describe("serialization", () => {
  test("a detached proof carries the format's header, version, and file digest", () => {
    const proof = buildLinearOtsProof({
      fileDigest: DIGEST,
      operations: [{ kind: "sha256" }],
      attestations: [{ kind: "pending", uri: KIT_CALENDAR_URI }],
    });
    expect(bytesToHex(proof.subarray(0, OTS_HEADER_MAGIC.length)))
      .toBe(bytesToHex(OTS_HEADER_MAGIC));
    expect(OTS_HEADER_MAGIC.length).toBe(31);
    let offset = OTS_HEADER_MAGIC.length;
    expect(proof[offset]).toBe(1); // major version
    expect(proof[offset + 1]).toBe(0x08); // the file hash operation: sha256
    offset += 2;
    expect(bytesToHex(proof.subarray(offset, offset + 32))).toBe(bytesToHex(DIGEST));
    // Then the timestamp: one sha256 op, then the attestation marker.
    expect(bytesToHex(proof.subarray(offset + 32, offset + 34))).toBe("0800");
  });

  test("a pending attestation carries its tag and a doubly length-prefixed URI", () => {
    const proof = buildLinearOtsProof({
      fileDigest: DIGEST,
      operations: [{ kind: "sha256" }],
      attestations: [{ kind: "pending", uri: KIT_CALENDAR_URI }],
    });
    const tagIndex = bytesToHex(proof).indexOf(bytesToHex(OTS_PENDING_ATTESTATION_TAG)) / 2;
    expect(tagIndex).toBeGreaterThan(0);
    const payload = proof.subarray(tagIndex + 8);
    const uriBytes = new TextEncoder().encode(KIT_CALENDAR_URI);
    expect(payload[0]).toBe(uriBytes.length + 1);
    expect(payload[1]).toBe(uriBytes.length);
    expect(new TextDecoder().decode(payload.subarray(2, 2 + uriBytes.length)))
      .toBe(KIT_CALENDAR_URI);
  });

  test("a Bitcoin attestation carries its tag and the height as a varuint", () => {
    const proof = buildLinearOtsProof({
      fileDigest: DIGEST,
      operations: [{ kind: "sha256" }],
      attestations: [{ kind: "bitcoin", height: KIT_BITCOIN_BLOCK_HEIGHT }],
    });
    const tagIndex = bytesToHex(proof).indexOf(bytesToHex(OTS_BITCOIN_ATTESTATION_TAG)) / 2;
    const payload = proof.subarray(tagIndex + 8);
    const height = encodeVaruint(KIT_BITCOIN_BLOCK_HEIGHT);
    expect(payload[0]).toBe(height.length);
    expect(bytesToHex(payload.subarray(1, 1 + height.length))).toBe(bytesToHex(height));
  });

  test("several attestations at one node are separated the reference way", () => {
    const proof = buildLinearOtsProof({
      fileDigest: DIGEST,
      operations: [{ kind: "sha256" }],
      attestations: [
        { kind: "pending", uri: KIT_CALENDAR_URI },
        { kind: "bitcoin", height: KIT_BITCOIN_BLOCK_HEIGHT },
      ],
    });
    // Every attestation but the last is introduced by 0xff 0x00; the last by
    // 0x00 alone, because this node carries no further operations.
    const hex = bytesToHex(proof);
    expect(hex).toContain(`ff00${bytesToHex(OTS_BITCOIN_ATTESTATION_TAG)}`);
    expect(hex).toContain(`00${bytesToHex(OTS_PENDING_ATTESTATION_TAG)}`);
  });

  test("a terminal node with no attestation is refused, and so is a short digest", () => {
    expect(() => buildLinearOtsProof({
      fileDigest: DIGEST,
      operations: [{ kind: "sha256" }],
      attestations: [],
    })).toThrow(/at least one attestation/);
    expect(() => serializeDetachedOtsProof({
      fileDigest: DIGEST.subarray(0, 16),
      timestamp: { attestations: [{ kind: "pending", uri: "x" }], operations: [] },
    })).toThrow(/32 bytes/);
  });
});

describe("synthetic block headers", () => {
  test("the header is 80 bytes and carries the commitment as its merkle root", () => {
    const merkleRoot = sha256(new TextEncoder().encode("commitment"));
    const header = buildSyntheticBlockHeader({ merkleRoot });
    expect(header.length).toBe(80);
    expect(bytesToHex(header.subarray(36, 68))).toBe(bytesToHex(merkleRoot));
    expect(() => buildSyntheticBlockHeader({ merkleRoot: merkleRoot.subarray(0, 16) }))
      .toThrow(/32 bytes/);
  });
});

describe("the kit fixture set", () => {
  const fixtures = createOpenTimestampsKitFixtures(DIGEST);

  test("the complete proof's replay matches the supplied header's merkle root", () => {
    const header = fixtures.blockHeaders[0]!;
    const commitment = header.header.subarray(36, 68);
    // Recovered from the proof bytes rather than from the builder's internals:
    // the operation sequence is append("jinn"), sha256, prepend("anchor"),
    // sha256, which is what the serialized proof carries.
    const replayed = replayOtsOperations(DIGEST, [
      { kind: "append", argument: new TextEncoder().encode("jinn") },
      { kind: "sha256" },
      { kind: "prepend", argument: new TextEncoder().encode("anchor") },
      { kind: "sha256" },
    ]);
    expect(bytesToHex(replayed)).toBe(bytesToHex(commitment));
    expect(header.height).toBe(KIT_BITCOIN_BLOCK_HEIGHT);
  });

  test("the fabricated proof attests to the same height with another commitment", () => {
    const header = fixtures.blockHeaders[0]!;
    const fabricated = replayOtsOperations(DIGEST, [
      { kind: "append", argument: Uint8Array.of(0xde, 0xad, 0xbe, 0xef) },
      { kind: "sha256" },
    ]);
    expect(bytesToHex(fabricated)).not.toBe(bytesToHex(header.header.subarray(36, 68)));
    // It attests to a height the kit *does* supply a header for -- otherwise a
    // verifier would report "no material for this height" and the fixture would
    // be testing absence rather than a fabricated commitment.
    const heightBytes = bytesToHex(encodeVaruint(KIT_BITCOIN_BLOCK_HEIGHT));
    expect(bytesToHex(fixtures.fabricatedCompleteProof))
      .toContain(`${bytesToHex(OTS_BITCOIN_ATTESTATION_TAG)}0${heightBytes.length / 2}${heightBytes}`);
  });

  test("the upgraded pair covers one digest with two proofs", () => {
    const digestHex = bytesToHex(DIGEST);
    expect(bytesToHex(fixtures.pendingProof)).toContain(digestHex);
    expect(bytesToHex(fixtures.completeProof)).toContain(digestHex);
    expect(bytesToHex(fixtures.pendingProof))
      .toContain(bytesToHex(OTS_PENDING_ATTESTATION_TAG));
    expect(bytesToHex(fixtures.pendingProof))
      .not.toContain(bytesToHex(OTS_BITCOIN_ATTESTATION_TAG));
    expect(bytesToHex(fixtures.completeProof))
      .toContain(bytesToHex(OTS_BITCOIN_ATTESTATION_TAG));
  });

  test("the fixture set is deterministic", () => {
    const again = createOpenTimestampsKitFixtures(DIGEST);
    expect(bytesToHex(again.completeProof)).toBe(bytesToHex(fixtures.completeProof));
    expect(bytesToHex(again.pendingProof)).toBe(bytesToHex(fixtures.pendingProof));
    expect(bytesToHex(again.blockHeaders[0]!.header))
      .toBe(bytesToHex(fixtures.blockHeaders[0]!.header));
  });
});
