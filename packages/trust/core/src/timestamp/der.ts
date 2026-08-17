// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal definite-length DER reader.
 *
 * Anchor-evidence design §6.1, "Parsing discipline": the reader is minimal and
 * definite-length only; indefinite-length BER is refused, not tolerated -- CMS
 * in DER is definite-length, and accepting BER widens the attack surface for no
 * interoperability gain. Everything here is structural: it decodes tag, length,
 * and content octets, and refuses encodings DER does not permit. It assigns no
 * meaning to any tag -- the RFC 3161 rule set (a later packet) reads meaning
 * out of the elements this module hands it.
 *
 * Deliberate narrowings, each of them a loud refusal rather than a silent
 * tolerance:
 *
 * - **Indefinite length (`0x80`)** and the reserved length octet `0xff`.
 * - **Non-minimal lengths** -- the long form used below 128, or a leading zero
 *   length octet. DER admits exactly one encoding of a length.
 * - **High-tag-number form** (`tagNumber === 0x1f`). No tag above 30 occurs in
 *   CMS or X.509, so supporting the multi-octet form would only add a
 *   canonicalization question with no reachable caller.
 * - **Universal-tag shape** -- SEQUENCE and SET must be constructed, and the
 *   universal types DER pins as primitive must not be (a constructed OCTET
 *   STRING is BER); NULL carries no content and BOOLEAN carries exactly one
 *   octet; universal tag 0 (end-of-contents, a BER-only construct) never
 *   appears.
 *
 * `content` and `bytes` are views over the caller's buffer, never copies:
 * `bytes` is the exact TLV slice that signedAttrs re-encoding and any
 * digest-over-exact-bytes rule needs, at its true offset.
 */

import { conformanceFailure, invalidInput } from "../errors.js";

/** Identifier octets for the tags this profile meets. SEQUENCE and SET carry
 * the constructed bit; the rest are primitive. */
export const DER_TAG = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OBJECT_IDENTIFIER: 0x06,
  UTC_TIME: 0x17,
  GENERALIZED_TIME: 0x18,
  SEQUENCE: 0x30,
  SET: 0x31,
} as const;

/** Default bound on constructed nesting. CMS timestamp tokens nest around ten
 * levels deep; 32 leaves headroom without admitting a stack-exhausting
 * adversarial encoding. */
export const DER_MAX_DEPTH = 32;

export type DerTagClass = "universal" | "application" | "context" | "private";

export interface DerElement {
  /** The single identifier octet, exactly as encoded. */
  readonly identifier: number;
  readonly tagClass: DerTagClass;
  readonly tagNumber: number;
  readonly constructed: boolean;
  /** 0 for a document element; one more than the parent for a child. */
  readonly depth: number;
  /** View over the content octets. */
  readonly content: Uint8Array;
  /** View over the exact TLV octets (identifier, length, content). */
  readonly bytes: Uint8Array;
}

export interface DerReadOptions {
  /** Defaults to `DER_MAX_DEPTH`. The bound is checked per call against the
   * parent element's own `depth`, so a traversal that descends through several
   * `decodeDerChildren` calls must pass the same bound to each. */
  readonly maxDepth?: number;
}

const TAG_CLASSES: readonly DerTagClass[] = ["universal", "application", "context", "private"];

/** Universal tags that DER encodes as primitive. */
const PRIMITIVE_UNIVERSAL_TAGS: readonly number[] = [1, 2, 3, 4, 5, 6, 23, 24];
/** Universal tags that DER encodes as constructed. */
const CONSTRUCTED_UNIVERSAL_TAGS: readonly number[] = [16, 17];

/** Long-form length octet count. Four octets already exceed any admissible
 * proof size (design §5 rule 2 caps a carried proof at 64 KiB). */
const MAX_LENGTH_OCTETS = 4;

function assertBytes(value: unknown, label: string): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array)) invalidInput(`${label} must be a Uint8Array.`);
}

function readLength(
  source: Uint8Array,
  lengthOffset: number,
): { readonly length: number; readonly contentOffset: number } {
  const first = source[lengthOffset]!;
  if (first === 0x80) {
    conformanceFailure(
      `Indefinite-length encoding at offset ${lengthOffset} is BER, not DER, and is refused.`,
    );
  }
  if (first === 0xff) {
    conformanceFailure(`Reserved length octet 0xff at offset ${lengthOffset}.`);
  }
  if (first < 0x80) return { length: first, contentOffset: lengthOffset + 1 };

  const octetCount = first & 0x7f;
  if (octetCount > MAX_LENGTH_OCTETS) {
    conformanceFailure(
      `Length at offset ${lengthOffset} spans ${octetCount} octets, beyond the ${MAX_LENGTH_OCTETS}-octet bound.`,
    );
  }
  if (lengthOffset + 1 + octetCount > source.length) {
    conformanceFailure(`Length at offset ${lengthOffset} is truncated.`);
  }
  if (source[lengthOffset + 1] === 0x00) {
    conformanceFailure(
      `Length at offset ${lengthOffset} has a leading zero octet; DER lengths are minimal.`,
    );
  }
  let length = 0;
  for (let index = 0; index < octetCount; index += 1) {
    length = length * 256 + source[lengthOffset + 1 + index]!;
  }
  if (length < 0x80) {
    conformanceFailure(
      `Length ${length} at offset ${lengthOffset} uses the long form below 128; DER lengths are minimal.`,
    );
  }
  return { length, contentOffset: lengthOffset + 1 + octetCount };
}

function assertUniversalShape(element: DerElement, offset: number): void {
  if (element.tagClass !== "universal") return;
  const { tagNumber, constructed, content } = element;
  if (tagNumber === 0) {
    conformanceFailure(`Reserved universal tag 0 at offset ${offset} (end-of-contents is BER).`);
  }
  if (constructed && PRIMITIVE_UNIVERSAL_TAGS.includes(tagNumber)) {
    conformanceFailure(`Universal tag ${tagNumber} at offset ${offset} must be primitive in DER.`);
  }
  if (!constructed && CONSTRUCTED_UNIVERSAL_TAGS.includes(tagNumber)) {
    conformanceFailure(
      `Universal tag ${tagNumber} at offset ${offset} must be constructed in DER.`,
    );
  }
  if (tagNumber === 5 && content.length !== 0) {
    conformanceFailure(`NULL at offset ${offset} carries ${content.length} content octet(s).`);
  }
  if (tagNumber === 1 && content.length !== 1) {
    conformanceFailure(
      `BOOLEAN at offset ${offset} carries ${content.length} content octets; DER encodes exactly one.`,
    );
  }
}

function readElement(
  source: Uint8Array,
  offset: number,
  depth: number,
): { readonly element: DerElement; readonly end: number } {
  if (offset + 2 > source.length) {
    conformanceFailure(
      `DER element at offset ${offset} is truncated: an identifier and a length octet are required.`,
    );
  }
  const identifier = source[offset]!;
  const tagNumber = identifier & 0x1f;
  if (tagNumber === 0x1f) {
    conformanceFailure(
      `High-tag-number form at offset ${offset} is not supported by this minimal reader.`,
    );
  }
  const { length, contentOffset } = readLength(source, offset + 1);
  const end = contentOffset + length;
  if (end > source.length) {
    conformanceFailure(
      `DER element at offset ${offset} is truncated: it declares ${length} content octets but only ${source.length - contentOffset} remain.`,
    );
  }
  const element: DerElement = {
    identifier,
    tagClass: TAG_CLASSES[(identifier >> 6) & 0x03]!,
    tagNumber,
    constructed: (identifier & 0x20) !== 0,
    depth,
    content: source.subarray(contentOffset, end),
    bytes: source.subarray(offset, end),
  };
  assertUniversalShape(element, offset);
  return { element, end };
}

/**
 * Decodes the single DER element that spans the whole input. Trailing bytes
 * after the element are a refusal, never ignored remainder.
 */
export function decodeDer(source: Uint8Array): DerElement {
  assertBytes(source, "DER input");
  const { element, end } = readElement(source, 0, 0);
  if (end !== source.length) {
    conformanceFailure(`${source.length - end} trailing byte(s) follow the DER element.`);
  }
  return element;
}

/**
 * Decodes the elements tiling a constructed element's content. The children
 * must consume the content exactly; a partial tail is a refusal.
 */
export function decodeDerChildren(
  element: DerElement,
  options?: DerReadOptions,
): readonly DerElement[] {
  const maxDepth = options?.maxDepth ?? DER_MAX_DEPTH;
  if (!Number.isInteger(maxDepth) || maxDepth < 1) {
    invalidInput("maxDepth must be a positive integer.");
  }
  if (!element.constructed) {
    conformanceFailure(
      `Only constructed elements have children; tag ${element.tagNumber} is primitive.`,
    );
  }
  const depth = element.depth + 1;
  if (depth > maxDepth) {
    conformanceFailure(`DER nesting depth ${depth} exceeds the bound of ${maxDepth}.`);
  }
  const children: DerElement[] = [];
  let offset = 0;
  while (offset < element.content.length) {
    const { element: child, end } = readElement(element.content, offset, depth);
    children.push(child);
    offset = end;
  }
  return children;
}

/** Encodes one DER element from an identifier octet and its content octets. */
export function encodeDerElement(identifier: number, content: Uint8Array): Uint8Array {
  if (!Number.isInteger(identifier) || identifier < 0 || identifier > 0xff) {
    invalidInput("A DER identifier octet must be an integer in 0..255.");
  }
  if ((identifier & 0x1f) === 0x1f) {
    invalidInput("High-tag-number form is not supported by this minimal encoder.");
  }
  assertBytes(content, "DER content");
  const header = encodeLength(content.length);
  const output = new Uint8Array(1 + header.length + content.length);
  output[0] = identifier;
  output.set(header, 1);
  output.set(content, 1 + header.length);
  return output;
}

/**
 * Re-encodes an element's content octets under a different identifier octet.
 *
 * This is the structural half of design §6.1 rule 8: the signature covers the
 * DER re-encoding of `signedAttrs` with an explicit SET OF tag, and the token
 * carries those same attributes under an IMPLICIT `[0]` tag. Re-tagging is
 * purely mechanical -- the content octets are the element's own, unread.
 */
export function retagDerElement(element: DerElement, identifier: number): Uint8Array {
  return encodeDerElement(identifier, element.content);
}

function encodeLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.from([length]);
  const octets: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) {
    octets.unshift(rest % 256);
  }
  if (octets.length > MAX_LENGTH_OCTETS) {
    invalidInput(`Content of ${length} octets exceeds the ${MAX_LENGTH_OCTETS}-octet length bound.`);
  }
  return Uint8Array.from([0x80 | octets.length, ...octets]);
}
