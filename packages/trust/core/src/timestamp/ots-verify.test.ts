// SPDX-License-Identifier: Apache-2.0

/**
 * Unit coverage for the OpenTimestamps proof verifier.
 *
 * The conformance kit's seventeen cases live in `@jinn-network/trust-testing`
 * and are the gate; this file is the implementation's own bench, and it builds
 * its proofs from the format constants directly rather than importing the kit --
 * trust-core's boundary forbids the import, and an independently written builder
 * is a better witness anyway. Where the kit exercises the profile's rules, this
 * file exercises the shapes the kit does not carry: several Bitcoin
 * attestations, an attestation class this profile does not know, a contradicted
 * branch beside a matching one, the algorithm floor on the operations, and the
 * bounds that keep a hostile proof from taking the process with it.
 */

import { describe, expect, test } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";

import { createOpenTimestampsProofVerifier } from "./ots-verify.js";
import type { OpenTimestampsBlockHeader, OpenTimestampsTrustMaterial } from "./ots-verify.js";
import { OPENTIMESTAMPS_ANCHOR_PROFILE } from "../anchor-provider.js";
import type { AnchorProofResult } from "../anchor-provider.js";

// --- Byte builders ----------------------------------------------------------

const MAGIC = Uint8Array.of(
  0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x73,
  0x00, 0x00, 0x50, 0x72, 0x6f, 0x6f, 0x66, 0x00,
  0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94,
);

const PENDING_TAG = Uint8Array.of(0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e);
const BITCOIN_TAG = Uint8Array.of(0x05, 0x88, 0x96, 0x0d, 0x73, 0xd7, 0x19, 0x01);
const LITECOIN_TAG = Uint8Array.of(0x06, 0x86, 0x9a, 0x0d, 0x73, 0xd7, 0x1b, 0x45);
/** A second attestation class this profile does not evaluate -- the terminal an
 * Ethereum-anchored branch carries. Only its distinctness matters here. */
const FOREIGN_CHAIN_TAG = Uint8Array.of(0x30, 0xfe, 0x80, 0x87, 0xb5, 0xc7, 0xea, 0xd7);

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function varuint(value: number): Uint8Array {
  const octets: number[] = [];
  let rest = value;
  for (;;) {
    const septet = rest & 0x7f;
    rest = Math.floor(rest / 128);
    if (rest === 0) {
      octets.push(septet);
      return Uint8Array.from(octets);
    }
    octets.push(septet | 0x80);
  }
}

function varbytes(bytes: Uint8Array): Uint8Array {
  return concat([varuint(bytes.length), bytes]);
}

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

const pendingAttestation = (uri = "https://calendar.invalid/p"): Uint8Array =>
  concat([PENDING_TAG, varbytes(varbytes(utf8(uri)))]);

const bitcoinAttestation = (height: number): Uint8Array =>
  concat([BITCOIN_TAG, varbytes(varuint(height))]);

const unknownAttestation = (payload: Uint8Array): Uint8Array =>
  concat([LITECOIN_TAG, varbytes(payload)]);

const foreignChainAttestation = (payload: Uint8Array): Uint8Array =>
  concat([FOREIGN_CHAIN_TAG, varbytes(payload)]);

/** One serialized timestamp node: attestations and operation subtrees, framed
 * the way the reference does it -- `0xff` before every item but the last, `0x00`
 * before an attestation. Order is the caller's, deliberately: this reader must
 * accept a proof however its producer ordered the items. */
function node(
  attestations: readonly Uint8Array[],
  branches: readonly { readonly operation: Uint8Array; readonly next: Uint8Array }[],
): Uint8Array {
  const items = [
    ...attestations.map((attestation) => concat([Uint8Array.of(0x00), attestation])),
    ...branches.map((branch) => concat([branch.operation, branch.next])),
  ];
  if (items.length === 0) throw new Error("A node carries at least one item.");
  return concat(items.map((item, index) =>
    index === items.length - 1 ? item : concat([Uint8Array.of(0xff), item])));
}

const SHA256_OP = Uint8Array.of(0x08);
const KECCAK256_OP = Uint8Array.of(0x67);
const appendOp = (argument: Uint8Array): Uint8Array => concat([Uint8Array.of(0xf0), varbytes(argument)]);
const prependOp = (argument: Uint8Array): Uint8Array => concat([Uint8Array.of(0xf1), varbytes(argument)]);

/** A linear path: the operations in order, the attestations at the end. */
function path(
  operations: readonly Uint8Array[],
  attestations: readonly Uint8Array[],
): Uint8Array {
  return operations.reduceRight(
    (next, operation) => node([], [{ operation, next }]),
    node(attestations, []),
  );
}

function detached(fileDigest: Uint8Array, timestamp: Uint8Array): Uint8Array {
  return concat([MAGIC, varuint(1), SHA256_OP, fileDigest, timestamp]);
}

// --- Replay, mirrored on the builder side -----------------------------------

const NONCE = Uint8Array.of(0x6a, 0x69, 0x6e, 0x6e);
const OTHER_NONCE = Uint8Array.of(0x00, 0x01, 0x02, 0x03);

const SUBJECT = "47fe3768e164b8663dd4da743c8f416fa09658c652f21617f45eea8a5a8a705c";

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

const DIGEST = hexToBytes(SUBJECT);

/** append(nonce) then sha256 -- the shape `ots stamp` produces per calendar. */
function commitmentFor(nonce: Uint8Array, message = DIGEST): Uint8Array {
  return sha256(concat([message, nonce]));
}

const OPERATIONS = [appendOp(NONCE), SHA256_OP] as const;
const COMMITMENT = commitmentFor(NONCE);

const BLOCK_TIME_SECONDS = 1_700_000_000;
const BLOCK_TIME_RFC3339 = "2023-11-14T22:13:20Z";
const HEIGHT = 880_017;

function blockHeader(merkleRoot: Uint8Array, timeSeconds = BLOCK_TIME_SECONDS): Uint8Array {
  const header = new Uint8Array(80);
  header.set(Uint8Array.of(0x00, 0x00, 0x00, 0x20), 0);
  header.set(merkleRoot, 36);
  new DataView(header.buffer).setUint32(68, timeSeconds, true);
  return header;
}

const verifier = createOpenTimestampsProofVerifier();

function verify(
  proofBytes: Uint8Array,
  blockHeaders?: readonly OpenTimestampsBlockHeader[],
  subjectSha256 = SUBJECT,
): AnchorProofResult {
  return verifier.verifyProof({
    subjectSha256,
    proofBytes,
    ...(blockHeaders === undefined ? {} : { trust: { blockHeaders } }),
  });
}

const completeProof = detached(DIGEST, path([...OPERATIONS], [bitcoinAttestation(HEIGHT)]));
const pendingProof = detached(DIGEST, path([...OPERATIONS], [pendingAttestation()]));
const KIT_HEADERS: readonly OpenTimestampsBlockHeader[] = [
  { height: HEIGHT, header: blockHeader(COMMITMENT) },
];

// --- The verifier's own declarations ----------------------------------------

describe("the verifier declares what §4.1 requires a profile to declare", () => {
  test("profile, time basis, and verification posture", () => {
    expect(verifier.profile).toBe(OPENTIMESTAMPS_ANCHOR_PROFILE);
    expect(verifier.timeBasis).toBe("chain-time");
    expect(verifier.posture).toBe("offline-with-external-data");
  });
});

// --- Structure --------------------------------------------------------------

describe("proof structure", () => {
  test("empty bytes are invalid", () => {
    expect(verify(new Uint8Array(0)).status).toBe("invalid");
  });

  test("a proof that does not begin with the detached-proof magic is invalid", () => {
    const wrong = completeProof.slice();
    wrong[3] = (wrong[3]! ^ 0xff) & 0xff;
    const result = verify(wrong);
    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.reason).toContain("magic");
  });

  test("a major version this reader does not implement is invalid", () => {
    const proof = concat([MAGIC, varuint(2), SHA256_OP, DIGEST, path([...OPERATIONS], [bitcoinAttestation(HEIGHT)])]);
    expect(verify(proof).status).toBe("invalid");
  });

  test("a file digest under an operation below the SHA-256 floor is invalid", () => {
    const proof = concat([
      MAGIC, varuint(1), Uint8Array.of(0x02), DIGEST.subarray(0, 20),
      path([...OPERATIONS], [bitcoinAttestation(HEIGHT)]),
    ]);
    const result = verify(proof);
    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.reason).toContain("SHA-256");
  });

  test("trailing bytes after the timestamp are invalid", () => {
    const result = verify(concat([completeProof, Uint8Array.of(0x00)]));
    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.reason).toContain("trailing");
  });

  test("every truncation of a complete proof is answered, never thrown", () => {
    for (let length = 0; length < completeProof.length; length += 1) {
      const result = verify(completeProof.subarray(0, length));
      expect(["invalid", "pending", "present", "verified"]).toContain(result.status);
      // Only the full proof carries the attestation; every prefix is short.
      expect(result.status).toBe("invalid");
    }
  });

  test("a node nested beyond the depth bound is invalid, not a stack overflow", () => {
    const deep = detached(
      DIGEST,
      Array.from({ length: 300 }).reduce<Uint8Array>(
        (next) => node([], [{ operation: SHA256_OP, next }]),
        node([pendingAttestation()], []),
      ),
    );
    const result = verify(deep);
    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.reason).toContain("nests beyond");
  });

  test("an over-long varuint is invalid rather than silently imprecise", () => {
    const overlong = concat([
      BITCOIN_TAG,
      varbytes(concat([Uint8Array.of(
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
      )])),
    ]);
    expect(verify(detached(DIGEST, path([...OPERATIONS], [overlong]))).status).toBe("invalid");
  });

  test("an empty append argument is invalid", () => {
    const proof = detached(DIGEST, path(
      [concat([Uint8Array.of(0xf0), varuint(0)]), SHA256_OP],
      [bitcoinAttestation(HEIGHT)],
    ));
    expect(verify(proof).status).toBe("invalid");
  });

  test("an attestation payload with trailing bytes is invalid", () => {
    const padded = concat([BITCOIN_TAG, varbytes(concat([varuint(HEIGHT), Uint8Array.of(0x00)]))]);
    expect(verify(detached(DIGEST, path([...OPERATIONS], [padded]))).status).toBe("invalid");
  });
});

describe("the algorithm floor on commitment operations", () => {
  test.each([
    ["SHA-1", 0x02],
    ["RIPEMD-160", 0x03],
  ])("a %s operation on the path is invalid", (_name, tag) => {
    const proof = detached(DIGEST, path([Uint8Array.of(tag)], [bitcoinAttestation(HEIGHT)]));
    const result = verify(proof);
    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.reason).toContain("floor");
  });

  test("a Keccak-256 operation is walked, not refused", () => {
    // Keccak is how an Ethereum branch commits. This profile evaluates no
    // Ethereum attestation, but walking the branch and evaluating it are
    // different acts -- refusing the operation would fail the whole proof over a
    // branch this profile simply has no opinion about.
    const proof = detached(DIGEST, path(
      [Uint8Array.of(0x67)],
      [unknownAttestation(Uint8Array.of(0x00))],
    ));
    const result = verify(proof, KIT_HEADERS);
    expect(result.status).toBe("pending");
    expect(result.status === "pending" && result.reason).toContain("no attestation this profile evaluates");
  });

  test("an operation tag the format does not define is invalid", () => {
    const proof = detached(DIGEST, path([Uint8Array.of(0x42)], [bitcoinAttestation(HEIGHT)]));
    const result = verify(proof);
    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.reason).toContain("Unknown operation tag");
  });
});

// --- Subject binding --------------------------------------------------------

describe("subject binding", () => {
  test("a proof detached from another digest is invalid", () => {
    const other = `${"0".repeat(63)}1`;
    expect(verify(completeProof, undefined, other).status).toBe("invalid");
  });

  test("a subject that is not 64 hex characters is invalid, never thrown", () => {
    for (const subject of ["", "zz", SUBJECT.slice(0, 63), `${SUBJECT}00`]) {
      expect(verify(completeProof, undefined, subject).status).toBe("invalid");
    }
  });

  test("an upper-case subject spelling names the same digest", () => {
    expect(verify(completeProof, undefined, SUBJECT.toUpperCase()).status).toBe("present");
  });
});

// --- Statuses ---------------------------------------------------------------

describe("a calendar-only proof", () => {
  test("is pending on authority-time, with or without headers", () => {
    for (const headers of [undefined, KIT_HEADERS]) {
      const result = verify(pendingProof, headers);
      expect(result.status).toBe("pending");
      expect(result.status === "pending" && result.timeBasis).toBe("authority-time");
      expect(result.status === "pending" && result.reason).toContain("calendar promise");
    }
  });

  test("reports every promise it carries, not just the first", () => {
    const proof = detached(DIGEST, path(
      [...OPERATIONS],
      [pendingAttestation("https://a.invalid/x"), pendingAttestation("https://b.invalid/y")],
    ));
    const result = verify(proof);
    expect(result.status === "pending" && result.reason).toContain("2 calendar promises");
  });
});

describe("a structurally complete proof", () => {
  test("is present with no headers supplied, and reports the height", () => {
    const result = verify(completeProof);
    expect(result.status).toBe("present");
    expect(result.status === "present" && result.timeBasis).toBe("chain-time");
    expect(result.status === "present" && result.facts).toEqual({ blockHeight: HEIGHT });
    expect("time" in result).toBe(false);
  });

  test("is present when headers are supplied for other heights only", () => {
    const result = verify(completeProof, [{ height: HEIGHT + 1, header: blockHeader(COMMITMENT) }]);
    expect(result.status).toBe("present");
    expect(result.status === "present" && result.facts).toEqual({ blockHeight: HEIGHT });
  });

  test("is verified when the header for its height carries the replayed commitment", () => {
    const result = verify(completeProof, KIT_HEADERS);
    expect(result.status).toBe("verified");
    expect(result.status === "verified" && result.timeBasis).toBe("chain-time");
    expect(result.status === "verified" && result.facts).toEqual({ blockHeight: HEIGHT });
  });

  test("reports the block time read out of the supplied header, at block precision", () => {
    const result = verify(completeProof, KIT_HEADERS);
    expect(result.status === "verified" && result.time).toBe(BLOCK_TIME_RFC3339);
  });

  test("renders each supplied header's own time, not a fixed one", () => {
    const result = verify(completeProof, [
      { height: HEIGHT, header: blockHeader(COMMITMENT, 1_231_006_505) },
    ]);
    expect(result.status === "verified" && result.time).toBe("2009-01-03T18:15:05Z");
  });

  test("is invalid when the header for its height carries another commitment", () => {
    const result = verify(completeProof, [{ height: HEIGHT, header: blockHeader(sha256(DIGEST)) }]);
    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.reason).toContain(String(HEIGHT));
  });

  test("is present, not invalid, when a supplied header is malformed", () => {
    // Malformed trust material is the operator's problem. Letting it produce
    // `invalid` would make a refusal depend on configuration.
    const result = verify(completeProof, [{ height: HEIGHT, header: new Uint8Array(64) }]);
    expect(result.status).toBe("present");
  });

  test("is present when the trust container itself is mis-shaped", () => {
    // The same judgment one level up: a caller that hands over something that is
    // not a header list has supplied no material, and the proof is not at fault
    // for it. Reaching the catch instead would report `invalid` with an internal
    // message attached.
    const containers = [
      {},
      { blockHeaders: null },
      { blockHeaders: {} },
      { blockHeaders: "0000" },
      { blockHeaders: [null, undefined, { height: HEIGHT }] },
    ];
    for (const container of containers) {
      const result = verifier.verifyProof({
        subjectSha256: SUBJECT,
        proofBytes: completeProof,
        trust: container as unknown as OpenTimestampsTrustMaterial,
      });
      expect(result.status).toBe("present");
      expect(result.status === "present" && result.facts).toEqual({ blockHeight: HEIGHT });
    }
  });

  test("is verified when one of several headers at that height matches", () => {
    const result = verify(completeProof, [
      { height: HEIGHT, header: blockHeader(sha256(DIGEST)) },
      { height: HEIGHT, header: blockHeader(COMMITMENT) },
    ]);
    expect(result.status).toBe("verified");
  });
});

// --- The forked walk --------------------------------------------------------

describe("a forked proof", () => {
  const forked = (first: Uint8Array, second: Uint8Array): Uint8Array =>
    detached(DIGEST, node([], [
      { operation: appendOp(OTHER_NONCE), next: node([], [{ operation: SHA256_OP, next: node([first], []) }]) },
      { operation: appendOp(NONCE), next: node([], [{ operation: SHA256_OP, next: node([second], []) }]) },
    ]));

  // The pending branch is serialized first here on purpose: a walker that
  // stopped at the first branch, or folded the operations into one chain, would
  // answer `pending` for a proof that is chain-complete.
  const pendingFirst = forked(pendingAttestation(), bitcoinAttestation(HEIGHT));

  test("is present on its complete branch even when a pending branch comes first", () => {
    const result = verify(pendingFirst);
    expect(result.status).toBe("present");
    expect(result.status === "present" && result.facts).toEqual({ blockHeight: HEIGHT });
  });

  test("is verified on its complete branch, against that branch's own commitment", () => {
    const result = verify(pendingFirst, KIT_HEADERS);
    expect(result.status).toBe("verified");
    expect(result.status === "verified" && result.time).toBe(BLOCK_TIME_RFC3339);
  });

  test("answers the same however its branches were serialized", () => {
    // The same tree, the two branches emitted the other way round. Canonical
    // ordering is builder-side discipline; a reader that made it load-bearing
    // would refuse well-formed production bytes.
    const completeFirst = detached(DIGEST, node([], [
      { operation: appendOp(NONCE), next: node([], [{ operation: SHA256_OP, next: node([bitcoinAttestation(HEIGHT)], []) }]) },
      { operation: appendOp(OTHER_NONCE), next: node([], [{ operation: SHA256_OP, next: node([pendingAttestation()], []) }]) },
    ]));
    expect(verify(completeFirst, KIT_HEADERS)).toEqual(verify(pendingFirst, KIT_HEADERS));
    expect(verify(completeFirst)).toEqual(verify(pendingFirst));
  });

  test("evaluates each attestation against its own branch's commitment", () => {
    // The Bitcoin attestation sits on the branch the kit header is *not* about,
    // so the supplied header contradicts it. A reader that compared the header
    // against any commitment in the proof would call this verified.
    const misplaced = forked(bitcoinAttestation(HEIGHT), pendingAttestation());
    expect(verify(misplaced, KIT_HEADERS).status).toBe("invalid");
    expect(verify(misplaced).status).toBe("present");
  });

  test("is invalid when any branch's attestation contradicts a supplied header", () => {
    // One branch verifies; the other attests the same height with an invented
    // commitment. A proof carrying an invented chain commitment is not a proof
    // one branch of which happens to hold.
    const proof = detached(DIGEST, node([], [
      { operation: appendOp(NONCE), next: node([], [{ operation: SHA256_OP, next: node([bitcoinAttestation(HEIGHT)], []) }]) },
      { operation: appendOp(OTHER_NONCE), next: node([], [{ operation: SHA256_OP, next: node([bitcoinAttestation(HEIGHT)], []) }]) },
    ]));
    expect(verify(proof, KIT_HEADERS).status).toBe("invalid");
  });
});

describe("several Bitcoin attestations", () => {
  const twoHeights = detached(DIGEST, node([], [
    { operation: appendOp(NONCE), next: node([], [{ operation: SHA256_OP, next: node([bitcoinAttestation(HEIGHT)], []) }]) },
    {
      operation: appendOp(OTHER_NONCE),
      next: node([], [{ operation: SHA256_OP, next: node([bitcoinAttestation(HEIGHT - 5)], []) }]),
    },
  ]));

  test("report the earliest height when none was evaluated (§4.2)", () => {
    const result = verify(twoHeights);
    expect(result.status).toBe("present");
    expect(result.status === "present" && result.facts).toEqual({ blockHeight: HEIGHT - 5 });
  });

  test("report the evaluated one when only the later height has a header", () => {
    // Earliest governs among *verified* anchors; an unevaluated earlier
    // attestation is not one.
    const result = verify(twoHeights, KIT_HEADERS);
    expect(result.status).toBe("verified");
    expect(result.status === "verified" && result.facts).toEqual({ blockHeight: HEIGHT });
  });

  test("report the earliest evaluated height when both have headers", () => {
    const result = verify(twoHeights, [
      ...KIT_HEADERS,
      { height: HEIGHT - 5, header: blockHeader(commitmentFor(OTHER_NONCE), 1_699_999_000) },
    ]);
    expect(result.status).toBe("verified");
    expect(result.status === "verified" && result.facts).toEqual({ blockHeight: HEIGHT - 5 });
    expect(result.status === "verified" && result.time).toBe("2023-11-14T21:56:40Z");
  });
});

describe("an attestation class this profile does not evaluate", () => {
  test("is read rather than refused, and decides nothing on its own", () => {
    const proof = detached(DIGEST, path([...OPERATIONS], [unknownAttestation(Uint8Array.of(1, 2, 3))]));
    const result = verify(proof, KIT_HEADERS);
    expect(result.status).toBe("pending");
    expect(result.status === "pending" && result.reason).toContain("no attestation this profile evaluates");
  });

  test("never displaces a Bitcoin attestation carried beside it", () => {
    const proof = detached(DIGEST, path(
      [...OPERATIONS],
      [unknownAttestation(Uint8Array.of(1, 2, 3)), bitcoinAttestation(HEIGHT)],
    ));
    expect(verify(proof, KIT_HEADERS).status).toBe("verified");
  });

  test("is counted in the reason beside the calendar promises it sits with", () => {
    const proof = detached(DIGEST, path(
      [...OPERATIONS],
      [pendingAttestation(), unknownAttestation(Uint8Array.of(1, 2, 3))],
    ));
    const result = verify(proof);
    expect(result.status === "pending" && result.reason).toContain("1 calendar promise");
    expect(result.status === "pending" && result.reason).toContain("1 attestation of a class this profile does not know");
  });
});

describe("a dual-anchored proof", () => {
  // One branch commits through Keccak-256 to a chain this profile does not
  // evaluate; the other is the ordinary Bitcoin path. Both are real shapes, and
  // a proof carrying the first must not be refused for carrying it.
  const dualAnchored = detached(DIGEST, node([], [
    {
      operation: appendOp(OTHER_NONCE),
      next: node([], [{
        operation: KECCAK256_OP,
        next: node([foreignChainAttestation(Uint8Array.of(0x2a))], []),
      }]),
    },
    {
      operation: appendOp(NONCE),
      next: node([], [{ operation: SHA256_OP, next: node([bitcoinAttestation(HEIGHT)], []) }]),
    },
  ]));

  test("is verified on its Bitcoin branch when the header is supplied", () => {
    const result = verify(dualAnchored, KIT_HEADERS);
    expect(result.status).toBe("verified");
    expect(result.status === "verified" && result.facts).toEqual({ blockHeight: HEIGHT });
    expect(result.status === "verified" && result.time).toBe(BLOCK_TIME_RFC3339);
  });

  test("is present on that branch when no header is supplied", () => {
    const result = verify(dualAnchored);
    expect(result.status).toBe("present");
    expect(result.status === "present" && result.facts).toEqual({ blockHeight: HEIGHT });
  });

  test("answers exactly as the same proof without the foreign branch", () => {
    // What "contributes nothing" means, stated as an equality rather than an
    // adjective: the branch is walked, and the outcome is unchanged by it.
    expect(verify(dualAnchored, KIT_HEADERS)).toEqual(verify(completeProof, KIT_HEADERS));
    expect(verify(dualAnchored)).toEqual(verify(completeProof));
  });
});

describe("the verifier is a pure function of its inputs", () => {
  test("the same proof answers the same way twice, and never mutates its input", () => {
    const bytes = completeProof.slice();
    const first = verify(bytes, KIT_HEADERS);
    const second = verify(bytes, KIT_HEADERS);
    expect(second).toEqual(first);
    expect([...bytes]).toEqual([...completeProof]);
  });

  test("no input shape throws", () => {
    const shapes: readonly Uint8Array[] = [
      new Uint8Array(0),
      Uint8Array.of(0xff),
      MAGIC,
      concat([MAGIC, varuint(1)]),
      concat([MAGIC, varuint(1), SHA256_OP, DIGEST]),
      concat([MAGIC, varuint(1), SHA256_OP, DIGEST, Uint8Array.of(0xff, 0xff, 0xff)]),
      concat([MAGIC, varuint(1), SHA256_OP, DIGEST, Uint8Array.of(0x00)]),
      concat([MAGIC, varuint(1), SHA256_OP, DIGEST, Uint8Array.of(0x00), BITCOIN_TAG]),
    ];
    for (const bytes of shapes) {
      expect(() => verify(bytes, KIT_HEADERS)).not.toThrow();
      expect(verify(bytes, KIT_HEADERS).status).toBe("invalid");
    }
  });
});
