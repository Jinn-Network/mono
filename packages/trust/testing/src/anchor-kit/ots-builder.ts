// SPDX-License-Identifier: Apache-2.0

/**
 * OpenTimestamps detached-proof builders for the conformance kit
 * (anchor-evidence design §6.2, §11 families 6, 9, 10).
 *
 * The `.ots` serialization is adopted as published, not reinvented: the header
 * magic, the varint/varbytes encoding, the operation tags, and the attestation
 * tags below are the format's own constants, so a kit-built proof is readable by
 * the reference tooling and a reference-built proof is readable here. What the
 * kit adds is determinism and the ability to build proofs that are *wrong* in
 * one named way.
 *
 * Two facts about this profile shape everything here:
 *
 * - **A complete proof is not a checked proof.** Replaying the commitment
 *   operations is pure hashing over bytes the proof itself supplies, so a
 *   fabricated attestation -- an invented height with a self-consistent path --
 *   replays perfectly. Only evaluating the commitment against a block header the
 *   *verifier* supplies distinguishes the two, which is why the kit supplies
 *   synthetic headers as trust material and builds both a genuine and a
 *   fabricated complete proof (§11 family 10).
 * - **The proof carries no time.** The extracted byte-fact is the attested block
 *   height; block time lives in the header and is verifier-report content
 *   (§6.2, §7.4).
 *
 * The synthetic headers are 80-byte Bitcoin block headers whose merkle root is
 * the kit's own commitment. They are not real blocks and are never presented as
 * such: they exist so the kit can exercise the header-evaluation path without a
 * chain, exactly as the RFC 3161 leg exercises the certificate path without a
 * real authority.
 */

import { sha256 } from "@noble/hashes/sha2.js";

import { concatenateBytes } from "./der-encoder.js";

/** `\x00OpenTimestamps\x00\x00Proof\x00\xbf\x89\xe2\xe8\x84\xe8\x92\x94`. */
export const OTS_HEADER_MAGIC = concatenateBytes([
  Uint8Array.of(0x00),
  new TextEncoder().encode("OpenTimestamps"),
  Uint8Array.of(0x00, 0x00),
  new TextEncoder().encode("Proof"),
  Uint8Array.of(0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94),
]);

export const OTS_MAJOR_VERSION = 1;

export const OTS_OP_SHA256 = 0x08;
export const OTS_OP_APPEND = 0xf0;
export const OTS_OP_PREPEND = 0xf1;

export const OTS_PENDING_ATTESTATION_TAG = Uint8Array.of(
  0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e,
);
export const OTS_BITCOIN_ATTESTATION_TAG = Uint8Array.of(
  0x05, 0x88, 0x96, 0x0d, 0x73, 0xd7, 0x19, 0x01,
);

// --- Model ------------------------------------------------------------------

export type OtsOperation =
  | { readonly kind: "sha256" }
  | { readonly kind: "append"; readonly argument: Uint8Array }
  | { readonly kind: "prepend"; readonly argument: Uint8Array };

export type OtsAttestation =
  | { readonly kind: "pending"; readonly uri: string }
  | { readonly kind: "bitcoin"; readonly height: number };

/** One node of the commitment tree: the attestations that hold at this message,
 * and the operations that carry it onward. */
export interface OtsTimestamp {
  readonly attestations: readonly OtsAttestation[];
  readonly operations: readonly { readonly operation: OtsOperation; readonly next: OtsTimestamp }[];
}

// --- Varint / varbytes ------------------------------------------------------

export function encodeVaruint(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`A varuint encodes a non-negative integer, not ${value}.`);
  }
  const octets: number[] = [];
  let rest = value;
  for (;;) {
    const septet = rest & 0x7f;
    rest = Math.floor(rest / 128);
    if (rest === 0) {
      octets.push(septet);
      break;
    }
    octets.push(septet | 0x80);
  }
  return Uint8Array.from(octets);
}

export function encodeVarbytes(bytes: Uint8Array): Uint8Array {
  return concatenateBytes([encodeVaruint(bytes.length), bytes]);
}

// --- Serialization ----------------------------------------------------------

function serializeOperation(operation: OtsOperation): Uint8Array {
  switch (operation.kind) {
    case "sha256":
      return Uint8Array.of(OTS_OP_SHA256);
    case "append":
      return concatenateBytes([Uint8Array.of(OTS_OP_APPEND), encodeVarbytes(operation.argument)]);
    case "prepend":
      return concatenateBytes([Uint8Array.of(OTS_OP_PREPEND), encodeVarbytes(operation.argument)]);
  }
}

function serializeAttestation(attestation: OtsAttestation): Uint8Array {
  if (attestation.kind === "pending") {
    return concatenateBytes([
      OTS_PENDING_ATTESTATION_TAG,
      encodeVarbytes(encodeVarbytes(new TextEncoder().encode(attestation.uri))),
    ]);
  }
  return concatenateBytes([
    OTS_BITCOIN_ATTESTATION_TAG,
    encodeVarbytes(encodeVaruint(attestation.height)),
  ]);
}

function attestationTag(attestation: OtsAttestation): Uint8Array {
  return attestation.kind === "pending"
    ? OTS_PENDING_ATTESTATION_TAG
    : OTS_BITCOIN_ATTESTATION_TAG;
}

/** Lexicographic byte order, a shorter prefix first -- how the reference
 * implementation's host language compares byte strings. Deliberately *not* the
 * zero-padded X.690 rule the DER encoder uses for `SET OF`; two formats, two
 * orderings, and conflating them would silently reorder one of them. */
function compareBytesLexicographic(left: Uint8Array, right: Uint8Array): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    if (left[index] !== right[index]) return left[index]! < right[index]! ? -1 : 1;
  }
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1;
}

/**
 * Attestation order, matching the reference: **by class tag first**, then by the
 * class's own natural key -- a pending attestation by its URI *string*, a
 * Bitcoin attestation by its *numeric* height.
 *
 * Sorting the serialized bytes instead would agree on the cross-class order (the
 * tag is a prefix) and disagree within a class, because both payloads are
 * length-prefixed: two calendar URIs would order by length before content, and
 * two heights by varuint bytes rather than by value. Either disagreement
 * produces a proof the reference tooling reserializes differently -- which is
 * the whole property a byte-exact carried proof depends on (§5 rule 2).
 */
function compareAttestations(left: OtsAttestation, right: OtsAttestation): number {
  const byTag = compareBytesLexicographic(attestationTag(left), attestationTag(right));
  if (byTag !== 0) return byTag;
  if (left.kind === "pending" && right.kind === "pending") {
    // Code-unit order, which matches the reference's code-point order for the
    // ASCII URIs a calendar publishes. `localeCompare` is banned in this tree
    // and would be wrong here anyway: the order must not vary by host.
    return left.uri < right.uri ? -1 : left.uri > right.uri ? 1 : 0;
  }
  if (left.kind === "bitcoin" && right.kind === "bitcoin") {
    return left.height < right.height ? -1 : left.height > right.height ? 1 : 0;
  }
  return 0;
}

/** Operation order, matching the reference: by tag byte, then by argument bytes.
 * Crypto operations carry no argument, so their tag decides. */
function compareOperations(left: OtsOperation, right: OtsOperation): number {
  const leftTag = serializeOperation(left)[0]!;
  const rightTag = serializeOperation(right)[0]!;
  if (leftTag !== rightTag) return leftTag < rightTag ? -1 : 1;
  const leftArgument = left.kind === "sha256" ? new Uint8Array(0) : left.argument;
  const rightArgument = right.kind === "sha256" ? new Uint8Array(0) : right.argument;
  return compareBytesLexicographic(leftArgument, rightArgument);
}

/**
 * Serializes one timestamp node, following the reference implementation's own
 * algorithm: attestations sorted and emitted first, then the operation forks in
 * sorted order; every item but the last is introduced by `0xff`, an attestation
 * item is introduced by `0x00`, and an operation item is its tag followed by the
 * subtree it carries.
 *
 * A node with several operations is a **fork**, and forks are the normal shape,
 * not an edge case: `ots stamp` appends a distinct nonce per calendar, so a real
 * pending proof already branches at the file digest, and an upgraded one keeps
 * one branch per calendar. Both branches are walked; a pending branch beside a
 * complete one neither blocks it nor is erased by it.
 */
function serializeTimestamp(timestamp: OtsTimestamp): Uint8Array {
  const attestations = [...timestamp.attestations].sort(compareAttestations);
  const operations = [...timestamp.operations]
    .sort((left, right) => compareOperations(left.operation, right.operation));
  const parts: Uint8Array[] = [];
  for (const attestation of attestations.slice(0, -1)) {
    parts.push(Uint8Array.of(0xff, 0x00), serializeAttestation(attestation));
  }
  const last = attestations.at(-1);
  if (operations.length === 0) {
    if (last === undefined) {
      throw new Error("A terminal timestamp node must carry at least one attestation.");
    }
    parts.push(Uint8Array.of(0x00), serializeAttestation(last));
    return concatenateBytes(parts);
  }
  if (last !== undefined) {
    parts.push(Uint8Array.of(0xff, 0x00), serializeAttestation(last));
  }
  for (const step of operations.slice(0, -1)) {
    parts.push(
      Uint8Array.of(0xff),
      serializeOperation(step.operation),
      serializeTimestamp(step.next),
    );
  }
  const lastStep = operations.at(-1)!;
  parts.push(serializeOperation(lastStep.operation), serializeTimestamp(lastStep.next));
  return concatenateBytes(parts);
}

export interface DetachedOtsProof {
  /** The digest the proof is detached from -- 32 bytes. */
  readonly fileDigest: Uint8Array;
  readonly timestamp: OtsTimestamp;
}

export function serializeDetachedOtsProof(proof: DetachedOtsProof): Uint8Array {
  if (proof.fileDigest.length !== 32) {
    throw new Error(`A SHA-256 file digest is 32 bytes, not ${proof.fileDigest.length}.`);
  }
  return concatenateBytes([
    OTS_HEADER_MAGIC,
    encodeVaruint(OTS_MAJOR_VERSION),
    Uint8Array.of(OTS_OP_SHA256),
    proof.fileDigest,
    serializeTimestamp(proof.timestamp),
  ]);
}

// --- Replay -----------------------------------------------------------------

export function applyOtsOperation(message: Uint8Array, operation: OtsOperation): Uint8Array {
  switch (operation.kind) {
    case "sha256":
      return sha256(message);
    case "append":
      return concatenateBytes([message, operation.argument]);
    case "prepend":
      return concatenateBytes([operation.argument, message]);
  }
}

/** Replays a linear operation sequence by pure hashing -- what a verifier does
 * to reach the attested commitment, and what the builder uses to know which
 * commitment its synthetic header must carry. */
export function replayOtsOperations(
  message: Uint8Array,
  operations: readonly OtsOperation[],
): Uint8Array {
  return operations.reduce(applyOtsOperation, message);
}

// --- Linear-chain builders --------------------------------------------------

/**
 * One unbranched path: the operations applied in order, with the attestations
 * at the end of it. Exported because a fork is built by giving one node several
 * of these -- which is what a real multi-calendar proof is.
 */
export function otsBranch(
  operations: readonly OtsOperation[],
  attestations: readonly OtsAttestation[],
): OtsTimestamp {
  if (operations.length === 0) return { attestations, operations: [] };
  const [head, ...rest] = operations;
  return {
    attestations: [],
    operations: [{ operation: head!, next: otsBranch(rest, attestations) }],
  };
}

/** A node that forks into several branches. The serializer orders them; the
 * caller's order is never load-bearing. */
export function otsFork(...branches: readonly OtsTimestamp[]): OtsTimestamp {
  const operations = branches.flatMap((branch) => branch.operations);
  if (operations.length !== branches.length) {
    throw new Error("Each branch of a fork must begin with exactly one operation.");
  }
  return { attestations: branches.flatMap((branch) => branch.attestations), operations };
}

const linearTimestamp = otsBranch;

export interface LinearOtsProofOptions {
  readonly fileDigest: Uint8Array;
  readonly operations: readonly OtsOperation[];
  readonly attestations: readonly OtsAttestation[];
}

export function buildLinearOtsProof(options: LinearOtsProofOptions): Uint8Array {
  return serializeDetachedOtsProof({
    fileDigest: options.fileDigest,
    timestamp: linearTimestamp(options.operations, options.attestations),
  });
}

// --- Synthetic Bitcoin block headers ---------------------------------------

export const KIT_CALENDAR_URI = "https://calendar.invalid/anchor-kit";
/** A second calendar. Stamping through several calendars is the standard
 * mitigation for the availability caveat §6.2 names, so a multi-calendar proof
 * is the normal shape and the kit carries one. */
export const KIT_SECOND_CALENDAR_URI = "https://second-calendar.invalid/anchor-kit";
export const KIT_BITCOIN_BLOCK_HEIGHT = 880_017;
/** A height the kit deliberately supplies **no** header for: the "material not
 * supplied for this height" case, which is `present`, not `invalid` (§6.2). */
export const KIT_UNKNOWN_BITCOIN_BLOCK_HEIGHT = 880_019;
/** The synthetic block's own time -- verifier-report content, never a sealed
 * byte-fact (§6.2). */
export const KIT_BITCOIN_BLOCK_TIME = "2026-08-17T12:00:00Z";

function uint32Le(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

export interface SyntheticBlockHeaderOptions {
  readonly merkleRoot: Uint8Array;
  readonly time?: string;
  readonly previousBlockHash?: Uint8Array;
}

/**
 * An 80-byte Bitcoin block header carrying `merkleRoot` in its merkle-root
 * field, in the internal byte order an OpenTimestamps commitment is compared
 * against. Nothing else about it is meaningful -- the proof-of-work is not
 * satisfied and is not meant to be; header *chain* validation is the verifier's
 * own trust material problem (§6.2), and the kit only needs the one field the
 * commitment is checked against.
 */
export function buildSyntheticBlockHeader(options: SyntheticBlockHeaderOptions): Uint8Array {
  if (options.merkleRoot.length !== 32) {
    throw new Error(`A merkle root is 32 bytes, not ${options.merkleRoot.length}.`);
  }
  const time = Math.floor(Date.parse(options.time ?? KIT_BITCOIN_BLOCK_TIME) / 1000);
  return concatenateBytes([
    uint32Le(0x2000_0000),
    options.previousBlockHash ?? new Uint8Array(32),
    options.merkleRoot,
    uint32Le(time),
    uint32Le(0x1703_1abe),
    uint32Le(0x0000_0001),
  ]);
}

export interface KitBlockHeader {
  readonly height: number;
  readonly header: Uint8Array;
  /** The header's time as RFC 3339 UTC -- what a header-supplied verifier
   * reports, and what the contract suite expects on the `verified` path. */
  readonly time: string;
}

export interface OpenTimestampsKitFixtures {
  /** A structurally complete proof whose commitment matches `blockHeaders[0]`. */
  readonly completeProof: Uint8Array;
  /** A proof whose only attestation is a calendar promise. */
  readonly pendingProof: Uint8Array;
  /** Structurally complete, self-consistent replay, invented commitment: the
   * attested height is one the kit supplies a header for, and the commitment is
   * not that header's merkle root. */
  readonly fabricatedCompleteProof: Uint8Array;
  /**
   * The shape a real upgraded multi-calendar proof has: the file digest forks,
   * one branch reaching a Bitcoin attestation that matches `blockHeaders[0]`,
   * the other still a calendar promise. The complete branch governs and the
   * pending branch neither blocks it nor disappears.
   */
  readonly forkedProof: Uint8Array;
  /** One node carrying two calendar promises -- the merged shape `ots stamp`
   * produces when several calendars answer about one message. */
  readonly twoPendingProof: Uint8Array;
  /** Structurally complete and genuine, attesting to a height the kit supplies
   * no header for. */
  readonly unknownHeightCompleteProof: Uint8Array;
  /** The verifier-side trust material: synthetic headers by height. */
  readonly blockHeaders: readonly KitBlockHeader[];
  readonly blockHeight: number;
  readonly unknownBlockHeight: number;
}

/**
 * The kit's OpenTimestamps fixture set over one subject digest. The pending and
 * complete proofs are the §11 family-9 upgraded pair: same digest, two records,
 * each reported on its own bytes.
 */
export function createOpenTimestampsKitFixtures(fileDigest: Uint8Array): OpenTimestampsKitFixtures {
  const genuineOperations: readonly OtsOperation[] = [
    { kind: "append", argument: Uint8Array.of(0x6a, 0x69, 0x6e, 0x6e) },
    { kind: "sha256" },
    { kind: "prepend", argument: Uint8Array.of(0x61, 0x6e, 0x63, 0x68, 0x6f, 0x72) },
    { kind: "sha256" },
  ];
  const fabricatedOperations: readonly OtsOperation[] = [
    { kind: "append", argument: Uint8Array.of(0xde, 0xad, 0xbe, 0xef) },
    { kind: "sha256" },
  ];
  // The second calendar's branch: its own nonce, exactly as `ots stamp`
  // produces one append per calendar from the same file digest.
  const secondCalendarOperations: readonly OtsOperation[] = [
    { kind: "append", argument: Uint8Array.of(0x00, 0x01, 0x02, 0x03) },
    { kind: "sha256" },
  ];
  const commitment = replayOtsOperations(fileDigest, genuineOperations);
  const header = buildSyntheticBlockHeader({ merkleRoot: commitment });

  return {
    completeProof: buildLinearOtsProof({
      fileDigest,
      operations: genuineOperations,
      attestations: [{ kind: "bitcoin", height: KIT_BITCOIN_BLOCK_HEIGHT }],
    }),
    pendingProof: buildLinearOtsProof({
      fileDigest,
      operations: [
        { kind: "append", argument: Uint8Array.of(0x6a, 0x69, 0x6e, 0x6e) },
        { kind: "sha256" },
      ],
      attestations: [{ kind: "pending", uri: KIT_CALENDAR_URI }],
    }),
    fabricatedCompleteProof: buildLinearOtsProof({
      fileDigest,
      operations: fabricatedOperations,
      attestations: [{ kind: "bitcoin", height: KIT_BITCOIN_BLOCK_HEIGHT }],
    }),
    forkedProof: serializeDetachedOtsProof({
      fileDigest,
      timestamp: otsFork(
        // The upgraded branch: the same commitment the standalone complete
        // proof reaches, so one synthetic header serves both.
        otsBranch(genuineOperations, [{ kind: "bitcoin", height: KIT_BITCOIN_BLOCK_HEIGHT }]),
        otsBranch(secondCalendarOperations, [{ kind: "pending", uri: KIT_SECOND_CALENDAR_URI }]),
      ),
    }),
    twoPendingProof: serializeDetachedOtsProof({
      fileDigest,
      timestamp: otsBranch(secondCalendarOperations, [
        { kind: "pending", uri: KIT_CALENDAR_URI },
        { kind: "pending", uri: KIT_SECOND_CALENDAR_URI },
      ]),
    }),
    unknownHeightCompleteProof: buildLinearOtsProof({
      fileDigest,
      operations: genuineOperations,
      attestations: [{ kind: "bitcoin", height: KIT_UNKNOWN_BITCOIN_BLOCK_HEIGHT }],
    }),
    blockHeaders: [
      { height: KIT_BITCOIN_BLOCK_HEIGHT, header, time: KIT_BITCOIN_BLOCK_TIME },
    ],
    blockHeight: KIT_BITCOIN_BLOCK_HEIGHT,
    unknownBlockHeight: KIT_UNKNOWN_BITCOIN_BLOCK_HEIGHT,
  };
}
