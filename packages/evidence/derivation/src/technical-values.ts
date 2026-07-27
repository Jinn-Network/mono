// SPDX-License-Identifier: Apache-2.0

import {
  DETERMINISTIC_PUBLIC_RECIPE,
  type RegexRecipe,
} from "./detectors/recipe.js";
import { snapshotInertData } from "./inert.js";

export type TechnicalValueClass =
  | "digest"
  | "transaction-digest"
  | "cid"
  | "dsse-material"
  | "public-key"
  | "version"
  | "model-id";

export interface TechnicalValueContext {
  readonly field?: string;
  readonly structuralRole?: "dsse-payload" | "dsse-signature";
}

function recipeRegex(recipe: RegexRecipe): RegExp {
  return new RegExp(recipe.source, recipe.flags);
}

function hasCredentialPrecedence(value: string): boolean {
  const recipe =
    DETERMINISTIC_PUBLIC_RECIPE.technicalClassifier.credentialPrecedence;
  return (
    DETERMINISTIC_PUBLIC_RECIPE.gitleaks.pack.rules.some((rule) =>
      new RegExp(rule.regex, recipe.gitleaksRuleFlags).test(value),
    ) ||
    recipe.additional.some((entry) =>
      recipeRegex(entry.regex).test(value),
    )
  );
}

function decodeBase32(value: string): Uint8Array | null {
  const alphabet =
    DETERMINISTIC_PUBLIC_RECIPE.technicalClassifier.cid.base32Alphabet;
  let accumulator = 0;
  let bits = 0;
  const bytes: number[] = [];
  for (const character of value) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) return null;
    accumulator = accumulator * alphabet.length + digit;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push(Math.floor(accumulator / 2 ** bits) & 0xff);
      accumulator %= 2 ** bits;
    }
  }
  if (bits > 0 && accumulator !== 0) return null;
  return Uint8Array.from(bytes);
}

function readVarint(
  bytes: Uint8Array,
  offset: number,
): { readonly value: number; readonly next: number } | null {
  const recipe = DETERMINISTIC_PUBLIC_RECIPE.technicalClassifier.cid;
  let value = 0;
  let multiplier = 1;
  for (
    let index = offset;
    index < bytes.length && index < offset + recipe.maximumVarintBytes;
    index += 1
  ) {
    const byte = bytes[index]!;
    value += (byte & 0x7f) * multiplier;
    if (!Number.isSafeInteger(value)) return null;
    if ((byte & 0x80) === 0) {
      if (
        recipe.rejectNonMinimalVarint &&
        index > offset &&
        byte === 0
      ) {
        return null;
      }
      return { value, next: index + 1 };
    }
    multiplier *= recipe.varintRadix;
  }
  return null;
}

function isCidV1(value: string): boolean {
  const recipe = DETERMINISTIC_PUBLIC_RECIPE.technicalClassifier.cid;
  if (!recipeRegex(recipe.text).test(value)) return false;
  const bytes = decodeBase32(value.slice(1));
  if (!bytes) return false;
  const version = readVarint(bytes, 0);
  const codec = version && readVarint(bytes, version.next);
  const multihash = codec && readVarint(bytes, codec.next);
  const length = multihash && readVarint(bytes, multihash.next);
  return Boolean(
    version?.value === recipe.version &&
      codec &&
      codec.value >= recipe.minimumCodec &&
      multihash &&
      multihash.value >= recipe.minimumMultihashCode &&
      length &&
      length.value >= recipe.minimumDigestLength &&
      length.next + length.value === bytes.length,
  );
}

function base64Sextet(character: string, urlSafe: boolean): number {
  if (character >= "A" && character <= "Z") {
    return character.charCodeAt(0) - 65;
  }
  if (character >= "a" && character <= "z") {
    return character.charCodeAt(0) - 71;
  }
  if (character >= "0" && character <= "9") {
    return character.charCodeAt(0) + 4;
  }
  if (character === (urlSafe ? "-" : "+")) return 62;
  if (character === (urlSafe ? "_" : "/")) return 63;
  return -1;
}

function decodeCanonicalBase64(value: string): Uint8Array | null {
  const recipe = DETERMINISTIC_PUBLIC_RECIPE.technicalClassifier.dsse;
  if (value.length === 0) {
    return recipe.acceptEmptyByteString ? new Uint8Array() : null;
  }
  const padding = value.match(/=+$/u)?.[0].length ?? 0;
  if (padding > 2 || value.slice(0, -padding || undefined).includes("=")) {
    return null;
  }
  if (padding > 0 && !recipe.acceptPadded) return null;
  if (padding === 0 && !recipe.acceptUnpadded) return null;
  const body = padding === 0 ? value : value.slice(0, -padding);
  const hasStandard = /[+/]/u.test(body);
  const hasUrlSafe = /[-_]/u.test(body);
  if (hasStandard && hasUrlSafe) return null;
  if (hasStandard && !recipe.acceptStandardAlphabet) return null;
  if (hasUrlSafe && !recipe.acceptUrlSafeAlphabet) return null;
  const urlSafe = hasUrlSafe;
  const remainder = body.length % 4;
  if (remainder === 1) return null;
  if (
    padding > 0 &&
    (value.length % 4 !== 0 ||
      padding !== (remainder === 2 ? 2 : remainder === 3 ? 1 : 0))
  ) {
    return null;
  }
  const sextets = [...body].map((character) =>
    base64Sextet(character, urlSafe),
  );
  if (sextets.some((valuePart) => valuePart < 0)) return null;
  if (
    recipe.requireCanonicalTrailingBits &&
    ((remainder === 2 && (sextets.at(-1)! & 0x0f) !== 0) ||
      (remainder === 3 && (sextets.at(-1)! & 0x03) !== 0))
  ) {
    return null;
  }
  const bytes: number[] = [];
  for (let index = 0; index < sextets.length; index += 4) {
    const a = sextets[index]!;
    const b = sextets[index + 1]!;
    const c = sextets[index + 2];
    const d = sextets[index + 3];
    bytes.push((a << 2) | (b >> 4));
    if (c !== undefined) bytes.push(((b & 0x0f) << 4) | (c >> 2));
    if (d !== undefined) bytes.push(((c! & 0x03) << 6) | d);
  }
  return Uint8Array.from(bytes);
}

interface DerElement {
  readonly tag: number;
  readonly contentStart: number;
  readonly contentEnd: number;
  readonly next: number;
}

function readDerElement(
  bytes: Uint8Array,
  offset: number,
): DerElement | null {
  if (offset + 2 > bytes.length) return null;
  const tag = bytes[offset]!;
  const firstLength = bytes[offset + 1]!;
  let contentStart = offset + 2;
  let length: number;
  if ((firstLength & 0x80) === 0) {
    length = firstLength;
  } else {
    const lengthBytes = firstLength & 0x7f;
    if (
      lengthBytes === 0 ||
      lengthBytes > 4 ||
      contentStart + lengthBytes > bytes.length ||
      bytes[contentStart] === 0
    ) {
      return null;
    }
    length = 0;
    for (let index = 0; index < lengthBytes; index += 1) {
      length = length * 256 + bytes[contentStart + index]!;
    }
    if (length < 128 || !Number.isSafeInteger(length)) return null;
    contentStart += lengthBytes;
  }
  const contentEnd = contentStart + length;
  if (contentEnd > bytes.length) return null;
  return { tag, contentStart, contentEnd, next: contentEnd };
}

function bytesHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isCanonicalPositiveDerInteger(
  bytes: Uint8Array,
  element: DerElement,
): boolean {
  const recipe =
    DETERMINISTIC_PUBLIC_RECIPE.technicalClassifier.publicKey;
  const constraints = recipe.rsaSubject;
  if (
    element.tag !== recipe.derTags.integer ||
    element.contentStart === element.contentEnd
  ) {
    return false;
  }
  const content = bytes.slice(element.contentStart, element.contentEnd);
  const first = content[0]!;
  if (
    constraints.requireCanonicalPositiveIntegers &&
    ((first & 0x80) !== 0 ||
      (first === 0 &&
        (content.length === 1 || (content[1]! & 0x80) === 0)))
  ) {
    return false;
  }
  return !constraints.rejectZero || content.some((byte) => byte !== 0);
}

function isRsaPublicKeySubject(keyBytes: Uint8Array): boolean {
  const recipe =
    DETERMINISTIC_PUBLIC_RECIPE.technicalClassifier.publicKey;
  const sequence = readDerElement(keyBytes, 0);
  if (
    !sequence ||
    sequence.tag !== recipe.derTags.sequence ||
    sequence.next !== keyBytes.length
  ) {
    return false;
  }
  let cursor = sequence.contentStart;
  for (let index = 0; index < recipe.rsaSubject.fields.length; index += 1) {
    const integer = readDerElement(keyBytes, cursor);
    if (
      !integer ||
      integer.next > sequence.contentEnd ||
      !isCanonicalPositiveDerInteger(keyBytes, integer)
    ) {
      return false;
    }
    cursor = integer.next;
  }
  return cursor === sequence.contentEnd;
}

function isEcPublicKeySubject(
  keyBytes: Uint8Array,
  curveOidHex: string,
): boolean {
  const recipe =
    DETERMINISTIC_PUBLIC_RECIPE.technicalClassifier.publicKey;
  const point = recipe.ecPoint;
  const curve = point.namedCurves.find(
    (candidate) => candidate.oidHex === curveOidHex,
  );
  if (!curve) return false;
  const prefix = keyBytes[0];
  if (point.compressedPrefixes.some((candidate) => candidate === prefix)) {
    return keyBytes.length === curve.coordinateBytes + 1;
  }
  return (
    prefix === point.uncompressedPrefix &&
    keyBytes.length === curve.coordinateBytes * 2 + 1
  );
}

function isSupportedSpkiDer(bytes: Uint8Array): boolean {
  const recipe =
    DETERMINISTIC_PUBLIC_RECIPE.technicalClassifier.publicKey;
  const tags = recipe.derTags;
  const outer = readDerElement(bytes, 0);
  if (
    !outer ||
    outer.tag !== tags.sequence ||
    outer.next !== bytes.length
  ) {
    return false;
  }
  const algorithm = readDerElement(bytes, outer.contentStart);
  if (
    !algorithm ||
    algorithm.tag !== tags.sequence ||
    algorithm.next >= outer.contentEnd
  ) {
    return false;
  }
  const oid = readDerElement(bytes, algorithm.contentStart);
  const oidHex = oid
    ? bytesHex(bytes.slice(oid.contentStart, oid.contentEnd))
    : "";
  const supported = recipe.supportedSpkiAlgorithms.find(
    (candidate) => candidate.oidHex === oidHex,
  );
  if (
    !oid ||
    oid.tag !== tags.objectIdentifier ||
    oid.contentEnd > algorithm.contentEnd ||
    !supported
  ) {
    return false;
  }
  const parameter =
    oid.next < algorithm.contentEnd
      ? readDerElement(bytes, oid.next)
      : undefined;
  if (
    (supported.parameters === "absent" &&
      oid.next !== algorithm.contentEnd) ||
    (supported.parameters === "null" &&
      (!parameter ||
        parameter.tag !== tags.null ||
        parameter.contentStart !== parameter.contentEnd ||
        parameter.next !== algorithm.contentEnd)) ||
    (supported.parameters === "object-identifier" &&
      (!parameter ||
        parameter.tag !== tags.objectIdentifier ||
        parameter.contentStart === parameter.contentEnd ||
        parameter.next !== algorithm.contentEnd))
  ) {
    return false;
  }
  const parameterOidHex =
    parameter?.tag === tags.objectIdentifier
      ? bytesHex(bytes.slice(parameter.contentStart, parameter.contentEnd))
      : "";
  const publicKey = readDerElement(bytes, algorithm.next);
  if (
    !publicKey ||
    publicKey.tag !== tags.bitString ||
    publicKey.next !== outer.contentEnd ||
    publicKey.contentEnd - publicKey.contentStart < 2
  ) {
    return false;
  }
  const unusedBits = bytes[publicKey.contentStart]!;
  if (unusedBits > 7) return false;
  if (recipe.requireZeroUnusedBits && unusedBits !== 0) return false;
  const keyBytes = bytes.slice(publicKey.contentStart + 1, publicKey.contentEnd);
  if (
    recipe.requireNonemptySubjectPublicKey &&
    keyBytes.length === 0
  ) {
    return false;
  }
  if (
    unusedBits !== 0 &&
    (keyBytes.at(-1)! & ((1 << unusedBits) - 1)) !== 0
  ) {
    return false;
  }
  if (
    supported.subject === "fixed-bytes" &&
    keyBytes.length !== supported.subjectBytes
  ) {
    return false;
  }
  if (
    supported.subject === "rsa-public-key" &&
    !isRsaPublicKeySubject(keyBytes)
  ) {
    return false;
  }
  if (
    supported.subject === "ec-point" &&
    !isEcPublicKeySubject(keyBytes, parameterOidHex)
  ) {
    return false;
  }
  return true;
}

function isSpkiPublicKey(value: string): boolean {
  const recipe =
    DETERMINISTIC_PUBLIC_RECIPE.technicalClassifier.publicKey;
  const match = value.match(recipeRegex(recipe.pem));
  if (!match) return false;
  const bytes = decodeCanonicalBase64(match[1]!.replace(/\r?\n/gu, ""));
  return bytes !== null && isSupportedSpkiDer(bytes);
}

function hasOwnDataField(
  value: Record<string, unknown>,
  field: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

export function isStructurallyValidDsseEnvelope(
  value: unknown,
): value is {
  readonly payloadType: string;
  readonly payload: string;
  readonly signatures: readonly {
    readonly keyid?: string;
    readonly sig: string;
  }[];
} {
  const recipe = DETERMINISTIC_PUBLIC_RECIPE.technicalClassifier.dsse;
  let envelope: Record<string, unknown>;
  try {
    const snapshot = snapshotInertData(value, "DSSE envelope");
    if (
      !snapshot ||
      typeof snapshot !== "object" ||
      Array.isArray(snapshot)
    ) {
      return false;
    }
    envelope = snapshot as Record<string, unknown>;
  } catch {
    return false;
  }
  if (
    !recipe.requiredEnvelopeFields.every((field) =>
      hasOwnDataField(envelope, field),
    ) ||
    envelope.payloadType !== recipe.payloadType ||
    typeof envelope.payload !== "string" ||
    decodeCanonicalBase64(envelope.payload) === null ||
    !Array.isArray(envelope.signatures) ||
    (recipe.requireNonemptySignatures &&
      envelope.signatures.length === 0)
  ) {
    return false;
  }
  return envelope.signatures.every((candidate) => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      return false;
    }
    const signature = candidate as Record<string, unknown>;
    if (
      !recipe.requiredSignatureFields.every((field) =>
        hasOwnDataField(signature, field),
      ) ||
      typeof signature.sig !== "string" ||
      decodeCanonicalBase64(signature.sig) === null
    ) {
      return false;
    }
    return (
      recipe.extensions === "inert-own-data-allowed" &&
      recipe.optionalKeyId === "string-including-empty" &&
      recipe.optionalSignatureFields.every(
        (field) =>
          !hasOwnDataField(signature, field) ||
          typeof signature[field] === "string",
      )
    );
  });
}

export function classifyTechnicalValue(
  value: string,
  context: TechnicalValueContext,
): TechnicalValueClass | null {
  const recipe = DETERMINISTIC_PUBLIC_RECIPE.technicalClassifier;
  if (hasCredentialPrecedence(value)) return null;
  if (recipeRegex(recipe.sha256Digest).test(value)) return "digest";
  if (recipeRegex(recipe.transactionDigest).test(value)) {
    return "transaction-digest";
  }
  if (isCidV1(value)) return "cid";
  if (isSpkiPublicKey(value)) return "public-key";
  if (
    context.structuralRole &&
    recipe.dsse.structuralRoles.includes(context.structuralRole)
  ) {
    return decodeCanonicalBase64(value) !== null ? "dsse-material" : null;
  }
  if (
    context.field !== undefined &&
    (recipe.version.fields.includes(context.field as never) ||
      context.field.includes(recipe.version.fieldSubstring)) &&
    recipeRegex(recipe.version.regex).test(value)
  ) {
    return "version";
  }
  if (
    context.field !== undefined &&
    recipe.modelId.fields.includes(context.field as never) &&
    recipeRegex(recipe.modelId.regex).test(value)
  ) {
    return "model-id";
  }
  return null;
}
