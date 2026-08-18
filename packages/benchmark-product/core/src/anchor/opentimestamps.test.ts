/**
 * The producer-side `.ots` mirror, pinned against the two things that can prove it is a mirror
 * and not a plausible reinvention:
 *
 * 1. the conformance kit's own byte-verified builder (`@jinn-network/trust-testing`), which this
 *    package may import here and nowhere else (the TEST_ONLY_JINN boundary), and
 * 2. the kit's committed real-calendar capture — 530 bytes of what three public calendars and the
 *    Bitcoin chain actually did — which is where a naive serialized-byte sort silently diverges.
 *
 * Every proof this module writes is also replayed through the real `trust-core` verifier, because
 * bytes nobody can verify are not a proof.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { createOpenTimestampsProofVerifier, sha256Hex } from "@jinn-network/trust-core";
import {
  KIT_BITCOIN_BLOCK_HEIGHT,
  KIT_CALENDAR_URI,
  KIT_SECOND_CALENDAR_URI,
  buildLinearOtsProof,
  createOpenTimestampsKitFixtures,
  encodeVaruint as kitEncodeVaruint,
  otsBranch,
  otsFork,
  replayOtsOperations as kitReplay,
  serializeDetachedOtsProof as kitSerialize,
} from "@jinn-network/trust-testing";
import {
  OpenTimestampsFormatError,
  encodeVaruint,
  forkOtsBranches,
  hasBitcoinAttestation,
  parseDetachedOtsProof,
  parseOtsCalendarResponse,
  replayOtsOperations,
  serializeDetachedOtsProof,
  spliceOtsUpgrade,
  toHex,
} from "./opentimestamps.js";
import type { OtsAttestation, OtsOperation } from "./opentimestamps.js";

const SUBJECT = "47fe3768e164b8663dd4da743c8f416fa09658c652f21617f45eea8a5a8a705c";

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

const fileDigest = hexToBytes(SUBJECT);

/** The kit's committed real-calendar fixtures, reached through its published `./fixtures/*`
 * export rather than a deep path into its tree. */
function kitFixture(name: string): Uint8Array {
  const resolved = createRequire(import.meta.url)
    .resolve(`@jinn-network/trust-testing/fixtures/anchor-kit-v1/${name}`);
  return new Uint8Array(readFileSync(resolved));
}

describe("varuint encoding", () => {
  test("matches the reference on the pinned vectors, including the wide ones", () => {
    for (const value of [0, 1, 127, 128, 200, 300, 880_017, 962_949, 2 ** 32 + 1]) {
      expect(toHex(encodeVaruint(value))).toBe(toHex(kitEncodeVaruint(value)));
    }
    expect(toHex(encodeVaruint(880_017))).toBe("91db35");
  });

  test("refuses a negative or non-integer varuint rather than emitting nonsense", () => {
    expect(() => encodeVaruint(-1)).toThrow(OpenTimestampsFormatError);
    expect(() => encodeVaruint(1.5)).toThrow(OpenTimestampsFormatError);
  });
});

describe("serialization against the kit's byte-verified builder", () => {
  const cases: Array<[string, readonly OtsOperation[], readonly OtsAttestation[]]> = [
    ["a pending calendar promise", [{ kind: "append", argument: Uint8Array.of(1, 2, 3) }, { kind: "sha256" }], [{ kind: "pending", uri: KIT_CALENDAR_URI }]],
    ["a Bitcoin attestation", [{ kind: "sha256" }], [{ kind: "bitcoin", height: KIT_BITCOIN_BLOCK_HEIGHT }]],
    ["a prepend path", [{ kind: "prepend", argument: Uint8Array.of(0xaa) }, { kind: "sha256" }], [{ kind: "bitcoin", height: 1 }]],
  ];

  for (const [label, operations, attestations] of cases) {
    test(`emits byte-identical bytes for ${label}`, () => {
      const mine = serializeDetachedOtsProof(fileDigest, buildNode(fileDigest, operations, attestations));
      const reference = buildLinearOtsProof({ fileDigest, operations, attestations });
      expect(toHex(mine)).toBe(toHex(reference));
    });
  }

  test("orders two calendar promises by URI string, not by serialized payload length", () => {
    // The kit's two URIs differ in length; a serialized-byte sort would order them by length
    // first and emit the pair in the wrong order.
    const shortFirst: readonly OtsAttestation[] = [
      { kind: "pending", uri: KIT_SECOND_CALENDAR_URI },
      { kind: "pending", uri: KIT_CALENDAR_URI },
    ];
    const operations: readonly OtsOperation[] = [{ kind: "append", argument: Uint8Array.of(0, 1, 2, 3) }, { kind: "sha256" }];
    expect(toHex(serializeDetachedOtsProof(fileDigest, buildNode(fileDigest, operations, shortFirst))))
      .toBe(toHex(buildLinearOtsProof({ fileDigest, operations, attestations: shortFirst })));
    // The caller's order is never load-bearing: the reversed input emits the same bytes.
    expect(toHex(serializeDetachedOtsProof(fileDigest, buildNode(fileDigest, operations, [...shortFirst].reverse()))))
      .toBe(toHex(buildLinearOtsProof({ fileDigest, operations, attestations: shortFirst })));
  });

  test("orders two Bitcoin heights numerically, not by varuint bytes", () => {
    // 300 encodes as `ac02` and 200 as `c801`: a byte sort puts 300 first, a numeric sort 200.
    const attestations: readonly OtsAttestation[] = [{ kind: "bitcoin", height: 300 }, { kind: "bitcoin", height: 200 }];
    const operations: readonly OtsOperation[] = [{ kind: "sha256" }];
    expect(toHex(serializeDetachedOtsProof(fileDigest, buildNode(fileDigest, operations, attestations))))
      .toBe(toHex(buildLinearOtsProof({ fileDigest, operations, attestations })));
  });

  test("emits a fork byte-identically to the reference", () => {
    const left: readonly OtsOperation[] = [{ kind: "append", argument: Uint8Array.of(0x6a, 0x69, 0x6e, 0x6e) }, { kind: "sha256" }];
    const right: readonly OtsOperation[] = [{ kind: "append", argument: Uint8Array.of(0, 1, 2, 3) }, { kind: "sha256" }];
    const mine = serializeDetachedOtsProof(fileDigest, forkOtsBranches(fileDigest, [
      buildNode(fileDigest, left, [{ kind: "bitcoin", height: KIT_BITCOIN_BLOCK_HEIGHT }]),
      buildNode(fileDigest, right, [{ kind: "pending", uri: KIT_SECOND_CALENDAR_URI }]),
    ]));
    const reference = kitSerialize({
      fileDigest,
      timestamp: otsFork(
        otsBranch(left, [{ kind: "bitcoin", height: KIT_BITCOIN_BLOCK_HEIGHT }]),
        otsBranch(right, [{ kind: "pending", uri: KIT_SECOND_CALENDAR_URI }]),
      ),
    });
    expect(toHex(mine)).toBe(toHex(reference));
  });

  test("refuses a fork whose branches begin with the same operation", () => {
    const same: readonly OtsOperation[] = [{ kind: "sha256" }];
    expect(() => forkOtsBranches(fileDigest, [
      buildNode(fileDigest, same, [{ kind: "pending", uri: KIT_CALENDAR_URI }]),
      buildNode(fileDigest, same, [{ kind: "pending", uri: KIT_SECOND_CALENDAR_URI }]),
    ])).toThrow(OpenTimestampsFormatError);
  });

  test("refuses a file digest that is not 32 bytes", () => {
    expect(() => serializeDetachedOtsProof(
      new Uint8Array(16),
      buildNode(new Uint8Array(16), [{ kind: "sha256" }], [{ kind: "bitcoin", height: 1 }]),
    )).toThrow(OpenTimestampsFormatError);
  });
});

describe("round-tripping the kit's every fixture shape", () => {
  const fixtures = createOpenTimestampsKitFixtures(fileDigest);

  for (const name of [
    "completeProof", "pendingProof", "fabricatedCompleteProof", "forkedProof",
    "twoPendingProof", "unknownHeightCompleteProof",
  ] as const) {
    test(`parses and re-serializes ${name} to identical bytes`, () => {
      const original = fixtures[name];
      const parsed = parseDetachedOtsProof(original);
      expect(toHex(parsed.fileDigest)).toBe(SUBJECT);
      expect(toHex(serializeDetachedOtsProof(parsed.fileDigest, parsed.root))).toBe(toHex(original));
    });
  }

  test("finds every calendar promise, and none where there is none", () => {
    expect(parseDetachedOtsProof(fixtures.twoPendingProof).pendingSites).toHaveLength(2);
    expect(parseDetachedOtsProof(fixtures.completeProof).pendingSites).toHaveLength(0);
    // A forked proof's pending branch is found even though a complete branch sits beside it.
    expect(parseDetachedOtsProof(fixtures.forkedProof).pendingSites).toHaveLength(1);
  });

  test("reports the commitment at the pending node, not the file digest", () => {
    const [site] = parseDetachedOtsProof(fixtures.pendingProof).pendingSites;
    expect(site).toBeDefined();
    expect(site!.commitmentHex).not.toBe(SUBJECT);
    expect(site!.uri).toBe(KIT_CALENDAR_URI);
  });

  test("hasBitcoinAttestation sees a completed branch beside a pending one", () => {
    expect(hasBitcoinAttestation(parseDetachedOtsProof(fixtures.forkedProof).root)).toBe(true);
    expect(hasBitcoinAttestation(parseDetachedOtsProof(fixtures.pendingProof).root)).toBe(false);
  });
});

describe("the kit's committed real-calendar capture", () => {
  test("re-serializes the real pending proof to its exact committed 530 bytes", () => {
    const committed = kitFixture("real-stamp-v1-pending.ots");
    const parsed = parseDetachedOtsProof(committed);
    const reserialized = serializeDetachedOtsProof(parsed.fileDigest, parsed.root);
    expect(reserialized.length).toBe(committed.length);
    expect(sha256Hex(reserialized)).toBe(sha256Hex(committed));
  });

  test("re-serializes the real chain-complete proof to its exact committed bytes", () => {
    const committed = kitFixture("real-stamp-v1-complete.ots");
    const parsed = parseDetachedOtsProof(committed);
    expect(sha256Hex(serializeDetachedOtsProof(parsed.fileDigest, parsed.root))).toBe(sha256Hex(committed));
  });

  test("the real pending commitments are 44 bytes, not the 32-byte file digest", () => {
    // The calendar's promise covers the message as it stands after a 4-byte prepend and an 8-byte
    // append with no hash after them. Assuming a 32-byte hash makes every upgrade query 404.
    const sites = parseDetachedOtsProof(kitFixture("real-stamp-v1-pending.ots")).pendingSites;
    expect(sites).toHaveLength(3);
    for (const site of sites) {
      expect(site.commitmentHex).toHaveLength(88);
      expect(site.commitmentHex).not.toBe(SUBJECT);
    }
  });
});

describe("replay", () => {
  test("agrees with the reference on a mixed operation path", () => {
    const operations: readonly OtsOperation[] = [
      { kind: "append", argument: Uint8Array.of(0x6a, 0x69, 0x6e, 0x6e) },
      { kind: "sha256" },
      { kind: "prepend", argument: Uint8Array.of(0x61, 0x6e, 0x63, 0x68, 0x6f, 0x72) },
      { kind: "sha256" },
    ];
    expect(toHex(replayOtsOperations(fileDigest, operations)))
      .toBe(toHex(kitReplay(fileDigest, operations)));
  });
});

describe("splicing an upgrade", () => {
  const fixtures = createOpenTimestampsKitFixtures(fileDigest);

  test("keeps the promise, adopts the completed path, and verifies as present", () => {
    const pending = parseDetachedOtsProof(fixtures.pendingProof);
    const [site] = pending.pendingSites;
    expect(site).toBeDefined();

    // What a calendar would answer for that commitment: a bare node, no magic, no version.
    const upgradeBody = calendarBody([{ kind: "sha256" }], [{ kind: "bitcoin", height: KIT_BITCOIN_BLOCK_HEIGHT }]);
    spliceOtsUpgrade(site!, parseOtsCalendarResponse(upgradeBody, site!.node.message).root);

    const upgraded = serializeDetachedOtsProof(pending.fileDigest, pending.root);
    const result = createOpenTimestampsProofVerifier().verifyProof({ subjectSha256: SUBJECT, proofBytes: upgraded });
    expect(result.status).toBe("present");
    if (result.status !== "present") return;
    expect(result.facts.blockHeight).toBe(KIT_BITCOIN_BLOCK_HEIGHT);

    // The promise survives beside the new attestation: an upgrade appends, it never rewrites.
    const reparsed = parseDetachedOtsProof(upgraded);
    expect(reparsed.pendingSites).toHaveLength(1);
    expect(hasBitcoinAttestation(reparsed.root)).toBe(true);
  });

  test("refuses to splice onto a node that already carries operations", () => {
    const forked = parseDetachedOtsProof(fixtures.forkedProof);
    const [site] = forked.pendingSites;
    expect(site).toBeDefined();
    site!.node.operations.push({ operation: { kind: "sha256" }, next: site!.node });
    expect(() => spliceOtsUpgrade(site!, parseOtsCalendarResponse(
      calendarBody([{ kind: "sha256" }], [{ kind: "bitcoin", height: 1 }]),
      site!.node.message,
    ).root)).toThrow(OpenTimestampsFormatError);
  });

  test("does not duplicate an attestation the node already carries", () => {
    const pending = parseDetachedOtsProof(fixtures.pendingProof);
    const [site] = pending.pendingSites;
    const body = calendarBody([], [{ kind: "pending", uri: KIT_CALENDAR_URI }, { kind: "bitcoin", height: 5 }]);
    spliceOtsUpgrade(site!, parseOtsCalendarResponse(body, site!.node.message).root);
    expect(site!.node.attestations).toHaveLength(2);
  });
});

describe("reading refusals", () => {
  test("refuses bytes that are not this format, this version, or a SHA-256 file digest", () => {
    expect(() => parseDetachedOtsProof(new Uint8Array(64))).toThrow(OpenTimestampsFormatError);
  });

  test("refuses trailing bytes after the timestamp", () => {
    const proof = createOpenTimestampsKitFixtures(fileDigest).completeProof;
    const padded = new Uint8Array(proof.length + 1);
    padded.set(proof);
    expect(() => parseDetachedOtsProof(padded)).toThrow(OpenTimestampsFormatError);
  });

  test("refuses an attestation class this producer could not re-serialize", () => {
    // A well-formed proof carrying an unknown class is something the VERIFIER reads without
    // accusing it; a producer that cannot round-trip it must not write a record over it.
    const unknownClass = Uint8Array.of(
      0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x00,
    );
    expect(() => parseOtsCalendarResponse(unknownClass, fileDigest)).toThrow(OpenTimestampsFormatError);
  });
});

// --- helpers ---------------------------------------------------------------

/** The linear-branch shape the parser produces, built by hand so the tests never depend on the
 * module under test for their own input. */
function buildNode(
  message: Uint8Array,
  operations: readonly OtsOperation[],
  attestations: readonly OtsAttestation[],
): import("./opentimestamps.js").OtsNode {
  if (operations.length === 0) return { message, attestations: [...attestations], operations: [] };
  const [head, ...rest] = operations;
  return {
    message,
    attestations: [],
    operations: [{
      operation: head!,
      next: buildNode(replayOtsOperations(message, [head!]), rest, attestations),
    }],
  };
}

/** A bare timestamp node, as a calendar returns one — the kit's full-proof serializer minus its
 * 36-byte header, so the framing under test is still the reference's. */
function calendarBody(
  operations: readonly OtsOperation[],
  attestations: readonly OtsAttestation[],
): Uint8Array {
  const full = buildLinearOtsProof({ fileDigest, operations, attestations });
  return full.subarray(31 + 1 + 1 + 32);
}
