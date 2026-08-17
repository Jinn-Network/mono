// SPDX-License-Identifier: Apache-2.0

/**
 * OpenTimestamps detached-proof verification (anchor-evidence design §6.2).
 *
 * The pure half of the §4.3 contract for
 * `https://spec.jinn.network/trust/anchor-profiles/opentimestamps/v1`: it parses
 * one detached `.ots` proof, replays its commitment operations by hashing, and
 * reports one of the four §4.3 statuses. No I/O of any kind happens here --
 * acquiring a proof and upgrading a pending one are producer-side operations
 * that append a new record, never something a verifier reaches for mid-check.
 *
 * Four properties of this profile shape the implementation, and each of them is
 * a place where the obvious code would be wrong:
 *
 * - **A proof is a tree, not a chain.** `ots stamp` appends a distinct nonce per
 *   calendar, so a real proof forks at the file digest and keeps one branch per
 *   calendar; an upgraded multi-calendar proof has a chain-complete branch
 *   sitting beside branches that are still calendar promises. The walk below
 *   visits **every** branch and collects every attestation it meets. A verifier
 *   that folded the operations linearly, or stopped at the first branch, would
 *   answer `pending` for a proof that is chain-complete -- the single most
 *   likely way to get this profile wrong, and the reason the kit ships a forked
 *   fixture whose pending branch serializes first.
 * - **Replaying a proof is not checking it.** Replay is pure hashing over bytes
 *   the proof itself supplies, so a fabricated attestation -- an invented height
 *   with a self-consistent path -- replays perfectly. Only comparing the
 *   replayed commitment against a block header the *verifier* supplied
 *   distinguishes a real anchor from an invented one, which is why a complete
 *   proof with no headers supplied is `present` and never `verified`.
 * - **Missing material is not a lie.** Headers supplied for other heights, or no
 *   headers at all, both mean this proof's time basis was not evaluated:
 *   `present`. Only a header that *contradicts* the replayed commitment at the
 *   attested height is `invalid`. Turning an incomplete header set into an
 *   accusation would make a refusal depend on the verifier operator's
 *   configuration, which §11 rules out.
 * - **The proof carries no time.** The extracted byte-fact is the block height.
 *   A `verified` result reports the block time because the verifier read it out
 *   of the header it itself supplied -- verifier-report content, at block
 *   precision, never a sealed byte-fact (§6.2, §7.4).
 *
 * The `.ots` serialization is read as published rather than reinvented: the
 * header magic, varuint/varbytes encoding, operation tags, and attestation tags
 * are the format's own constants, and the item framing (`0xff` before every item
 * but the last, `0x00` before an attestation) is the reference implementation's
 * own. Serialized order is never load-bearing here: canonical ordering is
 * builder-side discipline, and refusing a differently-ordered-but-well-formed
 * proof would refuse valid production bytes.
 */

import { sha256 } from "@noble/hashes/sha2.js";

import { conformanceFailure } from "../errors.js";
import { isCalendarStrictRfc3339 } from "../rfc3339.js";
import { OPENTIMESTAMPS_ANCHOR_PROFILE } from "../anchor-provider.js";
import type {
  AnchorProofResult,
  AnchorProofVerificationInput,
  AnchorProofVerifier,
} from "../anchor-provider.js";

// ---------------------------------------------------------------------------
// Format constants
// ---------------------------------------------------------------------------

/** `\x00OpenTimestamps\x00\x00Proof\x00\xbf\x89\xe2\xe8\x84\xe8\x92\x94`. */
const HEADER_MAGIC = Uint8Array.of(
  0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x73,
  0x00, 0x00, 0x50, 0x72, 0x6f, 0x6f, 0x66, 0x00,
  0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94,
);

const SUPPORTED_MAJOR_VERSION = 1;

const OP_SHA1 = 0x02;
const OP_RIPEMD160 = 0x03;
const OP_SHA256 = 0x08;
const OP_KECCAK256 = 0x67;
const OP_APPEND = 0xf0;
const OP_PREPEND = 0xf1;

const ATTESTATION_ITEM_TAG = 0x00;
const ITEM_SEPARATOR_TAG = 0xff;

const PENDING_ATTESTATION_TAG = Uint8Array.of(0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e);
const BITCOIN_ATTESTATION_TAG = Uint8Array.of(0x05, 0x88, 0x96, 0x0d, 0x73, 0xd7, 0x19, 0x01);
const ATTESTATION_TAG_BYTES = 8;

/** The reference implementation's own bounds: a message never exceeds 4096
 * bytes, and neither does an operation argument. Adopted rather than invented --
 * a proof this reader accepts must be one the reference tooling accepts too. */
const MAX_MESSAGE_BYTES = 4096;

/**
 * Bound on branch depth. A real proof's deepest path -- calendar aggregation
 * plus a Bitcoin merkle path -- runs well under a hundred operations, so 256
 * leaves generous headroom while keeping a hostile proof (two bytes per level)
 * from exhausting the stack. The reference implementation carries the same
 * bound.
 */
const MAX_DEPTH = 256;

/** A varuint is read septet by septet; nine septets already exceed the safe
 * integer range, so the bound refuses an over-long encoding before any value
 * silently loses precision. */
const MAX_VARUINT_SEPTETS = 9;

/** version(4) previousBlock(32) merkleRoot(32) time(4) bits(4) nonce(4). */
const BLOCK_HEADER_BYTES = 80;
const MERKLE_ROOT_OFFSET = 36;
const BLOCK_TIME_OFFSET = 68;

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/**
 * One block header the verifier's operator supplied, keyed by the height it
 * belongs to. Height is the key because that is what the proof attests to:
 * searching by merkle root instead would report `verified` for a proof that
 * attested to an entirely different block whose commitment happened to be one
 * the operator held.
 *
 * Where those 80 bytes came from, and whether they belong to the chain with the
 * most work, is the verifier operator's own problem (§6.2). This module checks
 * one thing about them: whether the header for the attested height carries the
 * commitment this proof replays to.
 */
export interface OpenTimestampsBlockHeader {
  readonly height: number;
  /** The 80-byte Bitcoin block header, exactly as it appears on the wire. */
  readonly header: Uint8Array;
}

/** Verifier-side trust material for this profile. Never bundle-supplied, and
 * absent by default: an operator who configured no headers gets `present` for
 * every structurally complete proof (§4.3, §8 step 3). */
export interface OpenTimestampsTrustMaterial {
  readonly blockHeaders: readonly OpenTimestampsBlockHeader[];
}

/** The byte-fact this profile extracts (§6.2). The proof contains no time. */
export interface OpenTimestampsProofFacts {
  readonly blockHeight: number;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface Cursor {
  readonly bytes: Uint8Array;
  offset: number;
}

function readOctet(cursor: Cursor): number {
  if (cursor.offset >= cursor.bytes.length) {
    conformanceFailure(`The proof ends at offset ${cursor.offset}, mid-structure.`);
  }
  const octet = cursor.bytes[cursor.offset]!;
  cursor.offset += 1;
  return octet;
}

function readBytes(cursor: Cursor, count: number): Uint8Array {
  if (cursor.offset + count > cursor.bytes.length) {
    conformanceFailure(
      `The proof ends after ${cursor.bytes.length - cursor.offset} of ${count} expected bytes at offset ${cursor.offset}.`,
    );
  }
  const slice = cursor.bytes.subarray(cursor.offset, cursor.offset + count);
  cursor.offset += count;
  return slice;
}

/**
 * Base-128, least-significant septet first, high bit as the continuation flag.
 *
 * Non-minimal encodings are accepted, matching the reference implementation:
 * nothing in this profile compares two proofs for byte equality, so a longer
 * spelling of the same height is an interoperability question rather than an
 * evasion, and refusing it would refuse bytes `ots` itself accepts. The septet
 * bound is not optional, though -- without it a hostile varuint runs past the
 * safe integer range and a height silently stops meaning what it says.
 */
function readVaruint(cursor: Cursor): number {
  let value = 0;
  let scale = 1;
  for (let septet = 0; septet < MAX_VARUINT_SEPTETS; septet += 1) {
    const octet = readOctet(cursor);
    value += (octet & 0x7f) * scale;
    if ((octet & 0x80) === 0) {
      if (!Number.isSafeInteger(value)) {
        conformanceFailure(`A varuint at offset ${cursor.offset} exceeds the safe integer range.`);
      }
      return value;
    }
    scale *= 128;
  }
  conformanceFailure(`A varuint at offset ${cursor.offset} runs past ${MAX_VARUINT_SEPTETS} septets.`);
}

function readVarbytes(cursor: Cursor): Uint8Array {
  return readBytes(cursor, readVaruint(cursor));
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const octet of bytes) hex += octet.toString(16).padStart(2, "0");
  return hex;
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

type ParsedAttestation =
  | { readonly kind: "pending" }
  | { readonly kind: "bitcoin"; readonly height: number }
  | { readonly kind: "unknown"; readonly tag: string };

/** One attestation and the message that holds at the node carrying it -- the
 * commitment that attestation is about. */
interface AttestationSite {
  readonly attestation: ParsedAttestation;
  readonly commitment: Uint8Array;
}

/**
 * Reads one attestation: an 8-byte class tag, then a length-prefixed payload
 * that the class reads within.
 *
 * A tag this profile does not know is **read, not refused**. Other chains'
 * attestation classes exist in the wild, and a proof carrying one is
 * well-formed; calling it `invalid` would be an accusation against a proof whose
 * only fault is being about a chain this profile does not evaluate. It
 * contributes nothing to the outcome, which is the honest consequence.
 */
function readAttestation(cursor: Cursor): ParsedAttestation {
  const tag = readBytes(cursor, ATTESTATION_TAG_BYTES);
  const payload = readVarbytes(cursor);
  const payloadCursor: Cursor = { bytes: payload, offset: 0 };

  if (bytesEqual(tag, PENDING_ATTESTATION_TAG)) {
    // The calendar URI, which this verifier reads for framing only: which
    // calendar promised is an acquisition concern, and a status reason is no
    // place for unvalidated foreign text.
    readVarbytes(payloadCursor);
    if (payloadCursor.offset !== payload.length) {
      conformanceFailure("A pending attestation payload carries trailing bytes after its URI.");
    }
    return { kind: "pending" };
  }

  if (bytesEqual(tag, BITCOIN_ATTESTATION_TAG)) {
    const height = readVaruint(payloadCursor);
    if (payloadCursor.offset !== payload.length) {
      conformanceFailure("A Bitcoin attestation payload carries trailing bytes after its height.");
    }
    return { kind: "bitcoin", height };
  }

  return { kind: "unknown", tag: toHex(tag) };
}

function applyOperation(cursor: Cursor, message: Uint8Array, tag: number): Uint8Array {
  if (tag === OP_SHA256) return sha256(message);

  if (tag === OP_APPEND || tag === OP_PREPEND) {
    const argument = readVarbytes(cursor);
    if (argument.length === 0) {
      conformanceFailure(`An ${tag === OP_APPEND ? "append" : "prepend"} argument is empty.`);
    }
    if (argument.length > MAX_MESSAGE_BYTES || message.length + argument.length > MAX_MESSAGE_BYTES) {
      conformanceFailure(`An operation at offset ${cursor.offset} exceeds the ${MAX_MESSAGE_BYTES}-byte message bound.`);
    }
    const combined = new Uint8Array(message.length + argument.length);
    combined.set(tag === OP_APPEND ? message : argument, 0);
    combined.set(tag === OP_APPEND ? argument : message, tag === OP_APPEND ? message.length : argument.length);
    return combined;
  }

  // §11 family 7's algorithm floor, stated over the operations too: a path that
  // passes through SHA-1 or RIPEMD-160 is no stronger than the weakest hash it
  // uses, whatever the file digest was.
  if (tag === OP_SHA1 || tag === OP_RIPEMD160) {
    conformanceFailure(
      `Operation 0x${tag.toString(16).padStart(2, "0")} is below this profile's SHA-256 algorithm floor.`,
    );
  }
  if (tag === OP_KECCAK256) {
    conformanceFailure("Keccak-256 commitment operations are outside this profile's Bitcoin scope.");
  }
  conformanceFailure(`Unknown operation tag 0x${tag.toString(16).padStart(2, "0")}.`);
}

/**
 * Reads one timestamp node and everything below it, applying each operation to
 * the message on the way down and recording every attestation it meets with the
 * message that held where it was found.
 *
 * The framing is the reference's: every item but the last is introduced by
 * `0xff`; an attestation item is introduced by `0x00`; an operation item is its
 * tag, its argument, and the subtree it carries. Every branch is walked --
 * there is no first-match short circuit, because the branch that matters is
 * routinely not the first one serialized.
 */
function readTimestamp(
  cursor: Cursor,
  message: Uint8Array,
  depth: number,
  sites: AttestationSite[],
): void {
  if (depth > MAX_DEPTH) {
    conformanceFailure(`The proof nests beyond ${MAX_DEPTH} levels.`);
  }
  let tag = readOctet(cursor);
  while (tag === ITEM_SEPARATOR_TAG) {
    readItem(cursor, message, depth, sites, readOctet(cursor));
    tag = readOctet(cursor);
  }
  readItem(cursor, message, depth, sites, tag);
}

function readItem(
  cursor: Cursor,
  message: Uint8Array,
  depth: number,
  sites: AttestationSite[],
  tag: number,
): void {
  if (tag === ATTESTATION_ITEM_TAG) {
    sites.push({ attestation: readAttestation(cursor), commitment: message });
    return;
  }
  readTimestamp(cursor, applyOperation(cursor, message, tag), depth + 1, sites);
}

/** Reads the detached-proof header, refusing anything that is not this format,
 * this version, and a SHA-256 file digest. */
function readFileDigest(cursor: Cursor): Uint8Array {
  if (!bytesEqual(readBytes(cursor, HEADER_MAGIC.length), HEADER_MAGIC)) {
    conformanceFailure("The proof does not begin with the OpenTimestamps detached-proof magic.");
  }
  const majorVersion = readVaruint(cursor);
  if (majorVersion !== SUPPORTED_MAJOR_VERSION) {
    conformanceFailure(`Proof major version ${majorVersion} is not version ${SUPPORTED_MAJOR_VERSION}.`);
  }
  const digestOperation = readOctet(cursor);
  if (digestOperation !== OP_SHA256) {
    conformanceFailure(
      `The file digest operation is 0x${digestOperation.toString(16).padStart(2, "0")}; this profile admits SHA-256 (0x08) only.`,
    );
  }
  return readBytes(cursor, 32);
}

// ---------------------------------------------------------------------------
// Header evaluation
// ---------------------------------------------------------------------------

/** Renders a Bitcoin header's uint32 time field as calendar-strict RFC 3339 UTC
 * at second precision, without the host's date library: the days-from-civil
 * inverse, so the rendering is identical on every host and carries no
 * millisecond tail the block never had. */
function renderUnixSecondsAsRfc3339(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const secondOfDay = seconds - days * 86_400;
  const shifted = days + 719_468;
  const era = Math.floor(shifted / 146_097);
  const dayOfEra = shifted - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1_460) + Math.floor(dayOfEra / 36_524)
      - Math.floor(dayOfEra / 146_096)) / 365,
  );
  const dayOfYear = dayOfEra
    - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPosition = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPosition + 2) / 5) + 1;
  const month = monthPosition + (monthPosition < 10 ? 3 : -9);
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  const pad = (value: number, width: number): string => String(value).padStart(width, "0");
  const rendered = `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`
    + `T${pad(Math.floor(secondOfDay / 3_600), 2)}:${pad(Math.floor(secondOfDay / 60) % 60, 2)}`
    + `:${pad(secondOfDay % 60, 2)}Z`;
  if (!isCalendarStrictRfc3339(rendered)) {
    conformanceFailure(`Block time ${seconds} does not render to a calendar-strict instant.`);
  }
  return rendered;
}

type HeightEvaluation =
  | { readonly outcome: "unsupplied" }
  | { readonly outcome: "matched"; readonly time: string }
  | { readonly outcome: "contradicted" };

/**
 * Evaluates one attested commitment against whatever headers the operator
 * supplied for that height.
 *
 * A supplied header that is not 80 bytes is treated as material the operator did
 * not supply, never as evidence against the proof: malformed trust material is
 * an operator problem, and letting it produce `invalid` would make a refusal
 * depend on configuration. Several headers for one height are answered by any
 * match -- an operator holding a stale fork tip beside the real one gets the
 * honest answer rather than a contradiction.
 */
function evaluateAgainstHeaders(
  headers: readonly OpenTimestampsBlockHeader[],
  height: number,
  commitment: Uint8Array,
): HeightEvaluation {
  const forHeight = headers.filter(
    (candidate) => candidate.height === height
      && candidate.header instanceof Uint8Array
      && candidate.header.length === BLOCK_HEADER_BYTES,
  );
  if (forHeight.length === 0) return { outcome: "unsupplied" };
  for (const candidate of forHeight) {
    const merkleRoot = candidate.header.subarray(MERKLE_ROOT_OFFSET, MERKLE_ROOT_OFFSET + 32);
    if (bytesEqual(merkleRoot, commitment)) {
      const view = new DataView(
        candidate.header.buffer,
        candidate.header.byteOffset + BLOCK_TIME_OFFSET,
        4,
      );
      return { outcome: "matched", time: renderUnixSecondsAsRfc3339(view.getUint32(0, true)) };
    }
  }
  return { outcome: "contradicted" };
}

// ---------------------------------------------------------------------------
// The verifier
// ---------------------------------------------------------------------------

const SUBJECT_PATTERN = /^[0-9a-fA-F]{64}$/;

function invalid(reason: string): AnchorProofResult<OpenTimestampsProofFacts> {
  return { status: "invalid", profile: OPENTIMESTAMPS_ANCHOR_PROFILE, reason };
}

function decide(
  sites: readonly AttestationSite[],
  headers: readonly OpenTimestampsBlockHeader[],
): AnchorProofResult<OpenTimestampsProofFacts> {
  const complete = sites.flatMap((site) =>
    site.attestation.kind === "bitcoin"
      ? [{ height: site.attestation.height, commitment: site.commitment }]
      : []);
  // Earliest governs (§4.2): a later block never improves a time claim, so the
  // lowest attested height is the one reported wherever several are eligible.
  const byHeight = [...complete].sort((left, right) => left.height - right.height);

  const evaluated = byHeight.map((attestation) => ({
    ...attestation,
    evaluation: evaluateAgainstHeaders(headers, attestation.height, attestation.commitment),
  }));

  // A contradicted attestation is the whole proof's problem, even if a sibling
  // branch would have verified: a proof that carries an invented chain
  // commitment is not a proof one branch of which happens to hold.
  const contradicted = evaluated.find((entry) => entry.evaluation.outcome === "contradicted");
  if (contradicted !== undefined) {
    return invalid(
      `The commitment attested at block ${contradicted.height} is not the merkle root of the supplied header for that height.`,
    );
  }

  const matched = evaluated.find((entry) => entry.evaluation.outcome === "matched");
  if (matched !== undefined && matched.evaluation.outcome === "matched") {
    return {
      status: "verified",
      profile: OPENTIMESTAMPS_ANCHOR_PROFILE,
      timeBasis: "chain-time",
      time: matched.evaluation.time,
      facts: { blockHeight: matched.height },
    };
  }

  const first = byHeight[0];
  if (first !== undefined) {
    return {
      status: "present",
      profile: OPENTIMESTAMPS_ANCHOR_PROFILE,
      timeBasis: "chain-time",
      facts: { blockHeight: first.height },
    };
  }

  const pending = sites.filter((site) => site.attestation.kind === "pending").length;
  if (pending > 0) {
    return {
      status: "pending",
      profile: OPENTIMESTAMPS_ANCHOR_PROFILE,
      // A calendar's promise is a party's assertion, not a consensus
      // commitment: while a proof is pending, its basis is authority-time, and
      // it becomes chain-time only when a Bitcoin attestation is spliced in.
      timeBasis: "authority-time",
      reason: `The proof carries ${pending} calendar promise${pending === 1 ? "" : "s"} and no Bitcoin attestation.`,
    };
  }

  return {
    status: "pending",
    profile: OPENTIMESTAMPS_ANCHOR_PROFILE,
    timeBasis: "authority-time",
    reason: `The proof carries no attestation this profile evaluates (${sites.length} attestation${sites.length === 1 ? "" : "s"}, none Bitcoin or calendar).`,
  };
}

/**
 * The `opentimestamps/v1` proof verifier. Stateless, pure, and safe to reuse.
 *
 * Every rule failure is a returned `invalid` carrying a reason, never a thrown
 * error: the consuming check (§8) must be able to report on every anchor a
 * bundle carries, and one unreadable proof must not take the report down with
 * it. The catch below is deliberately total for that reason.
 */
export function createOpenTimestampsProofVerifier(): AnchorProofVerifier<
  OpenTimestampsProofFacts,
  OpenTimestampsTrustMaterial
> {
  return {
    profile: OPENTIMESTAMPS_ANCHOR_PROFILE,
    timeBasis: "chain-time",
    posture: "offline-with-external-data",
    verifyProof(
      input: AnchorProofVerificationInput<OpenTimestampsTrustMaterial>,
    ): AnchorProofResult<OpenTimestampsProofFacts> {
      try {
        if (!(input.proofBytes instanceof Uint8Array)) {
          return invalid("The proof bytes are not a Uint8Array.");
        }
        if (typeof input.subjectSha256 !== "string" || !SUBJECT_PATTERN.test(input.subjectSha256)) {
          return invalid("The subject digest is not 64 hex characters.");
        }

        const cursor: Cursor = { bytes: input.proofBytes, offset: 0 };
        const fileDigest = readFileDigest(cursor);
        if (toHex(fileDigest) !== input.subjectSha256.toLowerCase()) {
          return invalid(
            `The proof is detached from ${toHex(fileDigest)}, not from the subject ${input.subjectSha256.toLowerCase()}.`,
          );
        }

        const sites: AttestationSite[] = [];
        readTimestamp(cursor, fileDigest, 0, sites);
        if (cursor.offset !== input.proofBytes.length) {
          return invalid(
            `The proof carries ${input.proofBytes.length - cursor.offset} trailing bytes after its timestamp.`,
          );
        }

        return decide(sites, input.trust?.blockHeaders ?? []);
      } catch (cause) {
        return invalid(cause instanceof Error ? cause.message : String(cause));
      }
    },
  };
}
