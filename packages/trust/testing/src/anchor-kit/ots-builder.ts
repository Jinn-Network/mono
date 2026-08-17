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

import { bytesToHex, concatenateBytes } from "./der-encoder.js";

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

function attestationSortKey(attestation: OtsAttestation): string {
  return bytesToHex(serializeAttestation(attestation));
}

/**
 * Serializes one timestamp node, following the reference implementation's own
 * algorithm: every item but the last is introduced by `0xff`, an attestation
 * item is introduced by `0x00`, and an operation item is its tag followed by the
 * subtree it carries.
 */
function serializeTimestamp(timestamp: OtsTimestamp): Uint8Array {
  const attestations = [...timestamp.attestations]
    .sort((left, right) => (attestationSortKey(left) < attestationSortKey(right) ? -1 : 1));
  const parts: Uint8Array[] = [];
  for (const attestation of attestations.slice(0, -1)) {
    parts.push(Uint8Array.of(0xff, 0x00), serializeAttestation(attestation));
  }
  const last = attestations.at(-1);
  if (timestamp.operations.length === 0) {
    if (last === undefined) {
      throw new Error("A terminal timestamp node must carry at least one attestation.");
    }
    parts.push(Uint8Array.of(0x00), serializeAttestation(last));
    return concatenateBytes(parts);
  }
  if (last !== undefined) {
    parts.push(Uint8Array.of(0xff, 0x00), serializeAttestation(last));
  }
  for (const step of timestamp.operations.slice(0, -1)) {
    parts.push(
      Uint8Array.of(0xff),
      serializeOperation(step.operation),
      serializeTimestamp(step.next),
    );
  }
  const lastStep = timestamp.operations.at(-1)!;
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

function linearTimestamp(
  operations: readonly OtsOperation[],
  attestations: readonly OtsAttestation[],
): OtsTimestamp {
  if (operations.length === 0) return { attestations, operations: [] };
  const [head, ...rest] = operations;
  return {
    attestations: [],
    operations: [{ operation: head!, next: linearTimestamp(rest, attestations) }],
  };
}

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
export const KIT_BITCOIN_BLOCK_HEIGHT = 880_017;
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
  /** The verifier-side trust material: synthetic headers by height. */
  readonly blockHeaders: readonly KitBlockHeader[];
  readonly blockHeight: number;
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
    blockHeaders: [
      { height: KIT_BITCOIN_BLOCK_HEIGHT, header, time: KIT_BITCOIN_BLOCK_TIME },
    ],
    blockHeight: KIT_BITCOIN_BLOCK_HEIGHT,
  };
}
