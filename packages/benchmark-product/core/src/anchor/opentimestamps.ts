/**
 * The `.ots` detached-proof format, producer side (anchor-evidence design §6.2).
 *
 * `trust-core` reads `.ots` proofs and never writes one: its `ots-verify.ts` keeps every format
 * constant module-private, because a verifier has no business emitting proofs. A producer does —
 * stamping assembles a detached proof out of what the calendars answered, and upgrading splices a
 * completed path into one — so the writing half lives here, in the application tier, beside the
 * source that performs the I/O.
 *
 * **This is a deliberate mirror, not a copy of record.** The byte-verified reference is the
 * conformance kit's builder (`@jinn-network/trust-testing`'s `anchor-kit/ots-builder.ts`), which
 * this package may import only from `*.test.ts` (the TEST_ONLY_JINN boundary). The tests beside
 * this module therefore pin the mirror against that reference *and* against the kit's committed
 * real-calendar capture, so a divergence fails loudly rather than producing bytes the reference
 * tooling reserializes differently.
 *
 * Three properties of the format are where the obvious code goes wrong:
 *
 * - **A proof is a tree.** One branch per calendar, forking at the file digest. Every branch is
 *   read; none is folded away. A pending branch beside a complete one neither blocks it nor is
 *   erased by it.
 * - **Serialized order is builder-side discipline and it is load-bearing.** Attestations sort by
 *   class tag, then by the class's own natural key — a calendar URI as a *string*, a block height
 *   as a *number*. Sorting the serialized bytes instead agrees cross-class and disagrees within a
 *   class, because both payloads are length-prefixed; the result is a proof `ots` reserializes
 *   differently, which is exactly the property a byte-exact carried proof depends on (§5 rule 2).
 * - **The commitment a calendar is asked to upgrade is the message at the pending node, not the
 *   file digest.** In the program's real capture that message is 44 bytes (a 4-byte prepend, a
 *   32-byte aggregation tip, an 8-byte append, with no hash after them): the calendar's promise
 *   covers the message as it stands at that point in the path. Assuming a 32-byte hash there
 *   makes every upgrade query 404 forever.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Format constants — the format's own, adopted as published
// ---------------------------------------------------------------------------

/** `\x00OpenTimestamps\x00\x00Proof\x00\xbf\x89\xe2\xe8\x84\xe8\x92\x94`. */
const HEADER_MAGIC = Uint8Array.of(
  0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x73,
  0x00, 0x00, 0x50, 0x72, 0x6f, 0x6f, 0x66, 0x00,
  0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94,
);

const MAJOR_VERSION = 1;

const OP_SHA256 = 0x08;
const OP_APPEND = 0xf0;
const OP_PREPEND = 0xf1;

const ATTESTATION_ITEM_TAG = 0x00;
const ITEM_SEPARATOR_TAG = 0xff;

const PENDING_ATTESTATION_TAG = Uint8Array.of(0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e);
const BITCOIN_ATTESTATION_TAG = Uint8Array.of(0x05, 0x88, 0x96, 0x0d, 0x73, 0xd7, 0x19, 0x01);
const ATTESTATION_TAG_BYTES = 8;

/** The reference implementation's own bounds, adopted rather than invented so a proof this
 * module builds is one the reference tooling accepts. */
const MAX_MESSAGE_BYTES = 4096;
const MAX_DEPTH = 256;
const MAX_VARUINT_SEPTETS = 9;

/** Thrown by every read path here. The caller (`sources.ts`) turns it into a typed product
 * refusal; nothing in this module knows about product error codes. */
export class OpenTimestampsFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenTimestampsFormatError";
  }
}

function fail(message: string): never {
  throw new OpenTimestampsFormatError(message);
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type OtsOperation =
  | { readonly kind: "sha256" }
  | { readonly kind: "append"; readonly argument: Uint8Array }
  | { readonly kind: "prepend"; readonly argument: Uint8Array };

export type OtsAttestation =
  | { readonly kind: "pending"; readonly uri: string }
  | { readonly kind: "bitcoin"; readonly height: number };

/** One node of the commitment tree. Mutable by construction: the splice adopts a calendar's
 * completed path onto a node already inside a parsed tree, exactly as the kit's own real-proof
 * assembly does, and re-serializing the tree then emits the upgraded proof. */
export interface OtsNode {
  /** The replayed message that holds at this node — what any attestation here is about. */
  readonly message: Uint8Array;
  attestations: OtsAttestation[];
  operations: { readonly operation: OtsOperation; readonly next: OtsNode }[];
}

/** A node carrying a calendar promise, with the calendar that made it. The upgrade query needs
 * exactly this pair. */
export interface OtsPendingSite {
  readonly node: OtsNode;
  readonly uri: string;
  /** The commitment to ask the calendar about — `node.message`, hex-encoded. */
  readonly commitmentHex: string;
}

export interface ParsedOtsProof {
  readonly fileDigest: Uint8Array;
  readonly root: OtsNode;
  readonly pendingSites: readonly OtsPendingSite[];
}

// ---------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const octet of bytes) hex += octet.toString(16).padStart(2, "0");
  return hex;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

/** Base-128, least-significant septet first, continuation bit `0x80`. `Math.floor(rest / 128)`
 * rather than `>>> 7`, which would truncate above 2^31. */
export function encodeVaruint(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`A varuint encodes a non-negative safe integer, not ${value}.`);
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
  return concatenate([encodeVaruint(bytes.length), bytes]);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface Cursor {
  readonly bytes: Uint8Array;
  offset: number;
}

function readOctet(cursor: Cursor): number {
  if (cursor.offset >= cursor.bytes.length) fail(`The serialization ends at offset ${cursor.offset}, mid-structure.`);
  const octet = cursor.bytes[cursor.offset]!;
  cursor.offset += 1;
  return octet;
}

function readBytes(cursor: Cursor, count: number): Uint8Array {
  if (cursor.offset + count > cursor.bytes.length) {
    fail(`The serialization ends after ${cursor.bytes.length - cursor.offset} of ${count} expected bytes.`);
  }
  const slice = cursor.bytes.subarray(cursor.offset, cursor.offset + count);
  cursor.offset += count;
  return slice;
}

function readVaruint(cursor: Cursor): number {
  let value = 0;
  let scale = 1;
  for (let septet = 0; septet < MAX_VARUINT_SEPTETS; septet += 1) {
    const octet = readOctet(cursor);
    value += (octet & 0x7f) * scale;
    if ((octet & 0x80) === 0) {
      if (!Number.isSafeInteger(value)) fail("A varuint exceeds the safe integer range.");
      return value;
    }
    scale *= 128;
  }
  return fail(`A varuint runs past ${MAX_VARUINT_SEPTETS} septets.`);
}

function readVarbytes(cursor: Cursor): Uint8Array {
  return readBytes(cursor, readVaruint(cursor));
}

/**
 * Reads one attestation. Unlike the verifier — which reads an unknown class rather than accusing
 * a well-formed proof of being invalid — a *producer* refuses what it cannot re-serialize. Writing
 * a record whose bytes this module cannot round-trip would produce an anchor the reference tooling
 * disagrees with, which is worse than declining the stamp.
 */
function readAttestation(cursor: Cursor): OtsAttestation {
  const tag = readBytes(cursor, ATTESTATION_TAG_BYTES);
  const payload = readVarbytes(cursor);
  const inner: Cursor = { bytes: payload, offset: 0 };

  if (bytesEqual(tag, PENDING_ATTESTATION_TAG)) {
    const uri = new TextDecoder("utf-8", { fatal: true }).decode(readVarbytes(inner));
    if (inner.offset !== payload.length) fail("A pending attestation payload carries trailing bytes after its URI.");
    return { kind: "pending", uri };
  }
  if (bytesEqual(tag, BITCOIN_ATTESTATION_TAG)) {
    const height = readVaruint(inner);
    if (inner.offset !== payload.length) fail("A Bitcoin attestation payload carries trailing bytes after its height.");
    return { kind: "bitcoin", height };
  }
  return fail(`Attestation class ${toHex(tag)} is one this producer cannot re-serialize.`);
}

export function applyOtsOperation(message: Uint8Array, operation: OtsOperation): Uint8Array {
  if (operation.kind === "sha256") return sha256(message);
  if (operation.argument.length === 0) fail(`An ${operation.kind} argument is empty.`);
  if (message.length + operation.argument.length > MAX_MESSAGE_BYTES) {
    fail(`An operation exceeds the ${MAX_MESSAGE_BYTES}-byte message bound.`);
  }
  return operation.kind === "append"
    ? concatenate([message, operation.argument])
    : concatenate([operation.argument, message]);
}

export function replayOtsOperations(message: Uint8Array, operations: readonly OtsOperation[]): Uint8Array {
  return operations.reduce(applyOtsOperation, message);
}

function readOperation(cursor: Cursor, tag: number): OtsOperation {
  if (tag === OP_SHA256) return { kind: "sha256" };
  if (tag === OP_APPEND) return { kind: "append", argument: readVarbytes(cursor) };
  if (tag === OP_PREPEND) return { kind: "prepend", argument: readVarbytes(cursor) };
  return fail(`Operation tag 0x${tag.toString(16).padStart(2, "0")} is not one this producer serializes.`);
}

/**
 * Reads one timestamp node and everything below it, carrying the message down. Framing is the
 * reference's: every item but the last is introduced by `0xff`; an attestation item is introduced
 * by `0x00`; an operation item is its tag, its argument, and the subtree it carries.
 */
function readNode(cursor: Cursor, message: Uint8Array, depth: number, sites: OtsPendingSite[]): OtsNode {
  if (depth > MAX_DEPTH) fail(`The proof nests beyond ${MAX_DEPTH} levels.`);
  const node: OtsNode = { message, attestations: [], operations: [] };
  const item = (tag: number): void => {
    if (tag === ATTESTATION_ITEM_TAG) {
      const attestation = readAttestation(cursor);
      node.attestations.push(attestation);
      if (attestation.kind === "pending") {
        sites.push({ node, uri: attestation.uri, commitmentHex: toHex(message) });
      }
      return;
    }
    const operation = readOperation(cursor, tag);
    node.operations.push({
      operation,
      next: readNode(cursor, applyOtsOperation(message, operation), depth + 1, sites),
    });
  };
  let tag = readOctet(cursor);
  while (tag === ITEM_SEPARATOR_TAG) {
    item(readOctet(cursor));
    tag = readOctet(cursor);
  }
  item(tag);
  return node;
}

/**
 * Parses a **bare timestamp node** — no magic, no version, no file-digest prefix. This is the
 * shape a calendar's `/digest` and `/timestamp/<commitment>` responses take: an operation path
 * starting from the message the caller submitted.
 */
export function parseOtsCalendarResponse(bytes: Uint8Array, message: Uint8Array): ParsedOtsProof {
  const cursor: Cursor = { bytes, offset: 0 };
  const sites: OtsPendingSite[] = [];
  const root = readNode(cursor, message, 0, sites);
  if (cursor.offset !== bytes.length) {
    fail(`The calendar response carries ${bytes.length - cursor.offset} trailing bytes.`);
  }
  return { fileDigest: message, root, pendingSites: sites };
}

/** Parses one complete detached `.ots` proof. */
export function parseDetachedOtsProof(bytes: Uint8Array): ParsedOtsProof {
  const cursor: Cursor = { bytes, offset: 0 };
  if (!bytesEqual(readBytes(cursor, HEADER_MAGIC.length), HEADER_MAGIC)) {
    fail("The proof does not begin with the OpenTimestamps detached-proof magic.");
  }
  const major = readVaruint(cursor);
  if (major !== MAJOR_VERSION) fail(`Proof major version ${major} is not version ${MAJOR_VERSION}.`);
  const digestOperation = readOctet(cursor);
  if (digestOperation !== OP_SHA256) {
    fail(`The file digest operation is 0x${digestOperation.toString(16).padStart(2, "0")}; only SHA-256 (0x08) is admitted.`);
  }
  const fileDigest = readBytes(cursor, 32);
  const sites: OtsPendingSite[] = [];
  const root = readNode(cursor, fileDigest, 0, sites);
  if (cursor.offset !== bytes.length) {
    fail(`The proof carries ${bytes.length - cursor.offset} trailing bytes after its timestamp.`);
  }
  return { fileDigest, root, pendingSites: sites };
}

// ---------------------------------------------------------------------------
// Ordering — reference ordering, and it decides the bytes
// ---------------------------------------------------------------------------

/** Lexicographic byte order, a shorter prefix first. Deliberately *not* the zero-padded X.690
 * `SET OF` rule the DER side uses; two formats, two orderings. */
function compareBytesLexicographic(left: Uint8Array, right: Uint8Array): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    if (left[index] !== right[index]) return left[index]! < right[index]! ? -1 : 1;
  }
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1;
}

function attestationTag(attestation: OtsAttestation): Uint8Array {
  return attestation.kind === "pending" ? PENDING_ATTESTATION_TAG : BITCOIN_ATTESTATION_TAG;
}

/**
 * By class tag first, then by the class's own natural key: a calendar URI as a *string*, a block
 * height as a *number*. Sorting the serialized payloads instead would order two URIs by length
 * before content and two heights by varuint bytes rather than by value.
 */
function compareAttestations(left: OtsAttestation, right: OtsAttestation): number {
  const byTag = compareBytesLexicographic(attestationTag(left), attestationTag(right));
  if (byTag !== 0) return byTag;
  if (left.kind === "pending" && right.kind === "pending") {
    // Code-unit order; never `localeCompare`, whose result varies by host.
    return left.uri < right.uri ? -1 : left.uri > right.uri ? 1 : 0;
  }
  if (left.kind === "bitcoin" && right.kind === "bitcoin") {
    return left.height < right.height ? -1 : left.height > right.height ? 1 : 0;
  }
  return 0;
}

function operationTag(operation: OtsOperation): number {
  return operation.kind === "sha256" ? OP_SHA256 : operation.kind === "append" ? OP_APPEND : OP_PREPEND;
}

/** By tag byte, then by argument bytes. Crypto operations carry no argument, so their tag decides. */
function compareOperations(left: OtsOperation, right: OtsOperation): number {
  const leftTag = operationTag(left);
  const rightTag = operationTag(right);
  if (leftTag !== rightTag) return leftTag < rightTag ? -1 : 1;
  return compareBytesLexicographic(
    left.kind === "sha256" ? new Uint8Array(0) : left.argument,
    right.kind === "sha256" ? new Uint8Array(0) : right.argument,
  );
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function serializeOperation(operation: OtsOperation): Uint8Array {
  if (operation.kind === "sha256") return Uint8Array.of(OP_SHA256);
  return concatenate([Uint8Array.of(operationTag(operation)), encodeVarbytes(operation.argument)]);
}

function serializeAttestation(attestation: OtsAttestation): Uint8Array {
  if (attestation.kind === "pending") {
    // The URI is doubly length-prefixed: the outer varbytes is the attestation payload, the
    // inner one is the UTF-8 URI within it.
    return concatenate([
      PENDING_ATTESTATION_TAG,
      encodeVarbytes(encodeVarbytes(new TextEncoder().encode(attestation.uri))),
    ]);
  }
  // The height is a varuint wrapped in varbytes, not a bare varuint.
  return concatenate([BITCOIN_ATTESTATION_TAG, encodeVarbytes(encodeVaruint(attestation.height))]);
}

function serializeNode(node: OtsNode, depth = 0): Uint8Array {
  if (depth > MAX_DEPTH) fail(`The proof nests beyond ${MAX_DEPTH} levels.`);
  const attestations = [...node.attestations].sort(compareAttestations);
  const operations = [...node.operations].sort((left, right) => compareOperations(left.operation, right.operation));
  const parts: Uint8Array[] = [];
  for (const attestation of attestations.slice(0, -1)) {
    parts.push(Uint8Array.of(ITEM_SEPARATOR_TAG, ATTESTATION_ITEM_TAG), serializeAttestation(attestation));
  }
  const last = attestations.at(-1);
  if (operations.length === 0) {
    if (last === undefined) fail("A terminal timestamp node must carry at least one attestation.");
    parts.push(Uint8Array.of(ATTESTATION_ITEM_TAG), serializeAttestation(last));
    return concatenate(parts);
  }
  if (last !== undefined) {
    parts.push(Uint8Array.of(ITEM_SEPARATOR_TAG, ATTESTATION_ITEM_TAG), serializeAttestation(last));
  }
  for (const step of operations.slice(0, -1)) {
    parts.push(Uint8Array.of(ITEM_SEPARATOR_TAG), serializeOperation(step.operation), serializeNode(step.next, depth + 1));
  }
  const lastStep = operations.at(-1)!;
  parts.push(serializeOperation(lastStep.operation), serializeNode(lastStep.next, depth + 1));
  return concatenate(parts);
}

export function serializeDetachedOtsProof(fileDigest: Uint8Array, root: OtsNode): Uint8Array {
  if (fileDigest.length !== 32) fail(`A SHA-256 file digest is 32 bytes, not ${fileDigest.length}.`);
  return concatenate([
    HEADER_MAGIC,
    encodeVaruint(MAJOR_VERSION),
    Uint8Array.of(OP_SHA256),
    fileDigest,
    serializeNode(root),
  ]);
}

// ---------------------------------------------------------------------------
// Fork and splice
// ---------------------------------------------------------------------------

/**
 * Merges one branch per calendar into the fork `ots stamp` itself produces.
 *
 * Two calendars whose paths begin with the same operation would merge into one branch in any
 * reference-shaped model, so the fork written here would not be the fork the tooling
 * reserializes. That is refused loudly rather than silently emitted.
 */
export function forkOtsBranches(message: Uint8Array, branches: readonly OtsNode[]): OtsNode {
  if (branches.length === 0) fail("A fork needs at least one branch.");
  if (branches.length === 1) return branches[0]!;
  const operations: OtsNode["operations"] = [];
  const attestations: OtsAttestation[] = [];
  const seen = new Set<string>();
  for (const branch of branches) {
    for (const attestation of branch.attestations) attestations.push(attestation);
    for (const step of branch.operations) {
      const key = `${operationTag(step.operation)}:${step.operation.kind === "sha256" ? "" : toHex(step.operation.argument)}`;
      if (seen.has(key)) fail("Two calendar responses begin with the same operation; the fork would not round-trip.");
      seen.add(key);
      operations.push(step);
    }
  }
  return { message, attestations, operations };
}

function attestationKey(attestation: OtsAttestation): string {
  return attestation.kind === "pending" ? `pending:${attestation.uri}` : `bitcoin:${attestation.height}`;
}

/**
 * Splices a calendar's completed path onto the node that carried its promise: the promise is
 * kept and the upgrade's attestations are unioned beside it, then the upgrade's operations are
 * adopted. Nothing is replaced — an upgrade appends, it never rewrites (§5 rule 6, §6.2).
 *
 * The promised node must still be a leaf. A node that already carries operations would need a
 * real tree merge, and guessing at one is how a producer emits a proof nobody else agrees with.
 */
export function spliceOtsUpgrade(site: OtsPendingSite, upgrade: OtsNode): void {
  if (site.node.operations.length > 0) {
    fail("The promised node already carries operations; splicing would need a tree merge.");
  }
  const carried = new Set(site.node.attestations.map(attestationKey));
  for (const attestation of upgrade.attestations) {
    if (!carried.has(attestationKey(attestation))) site.node.attestations.push(attestation);
  }
  site.node.operations.push(...upgrade.operations);
}

/** True when any branch of the proof reaches a Bitcoin attestation. */
export function hasBitcoinAttestation(node: OtsNode): boolean {
  if (node.attestations.some((attestation) => attestation.kind === "bitcoin")) return true;
  return node.operations.some((step) => hasBitcoinAttestation(step.next));
}
