// SPDX-License-Identifier: Apache-2.0

import { keccak_256 } from "@noble/hashes/sha3.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";

import { canonicalJsonBytes } from "./canonical-json.js";
import { compareCodeUnitStrings } from "./order.js";
import { invalidInput } from "./errors.js";
import { recordDigest } from "./hashing.js";
import { toChecksumAddress } from "./spellings.js";
import type { AuthorizationStatement } from "./authorization.js";
import type { KeyBinding } from "./key-binding.js";
import type { Sha256Digest } from "./types.js";

// ---------------------------------------------------------------------------
// EIP-191 `personal_sign` recovery (design §7.2: EOA ceremonies are
// offline-verifiable forever from the message bytes + EIP-191 signature).
// The identical recovery routine backs ReCap ceremonies (§8.1) -- SIWE +
// ReCap is the same secp256k1 EIP-191 signature over a different
// human-readable message; only the transcribed content differs.
// ---------------------------------------------------------------------------

function ascii(value: string): Uint8Array {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

/** EIP-191 `personal_sign` digest: `keccak256("\x19Ethereum Signed
 * Message:\n" + byteLength + message)`. */
function personalSignDigest(messageBytes: Uint8Array): Uint8Array {
  const prefix = ascii(`\x19Ethereum Signed Message:\n${messageBytes.length}`);
  return keccak_256(concatenate([prefix, messageBytes]));
}

const EIP191_SIGNATURE_LENGTH = 65;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/**
 * Recovers the EIP-55 checksummed address that produced an `r || s || v`
 * (65-byte, `v` ∈ {27, 28, 0, 1}) EIP-191 signature over `messageBytes`.
 * Throws `TrustCoreError` on a structurally malformed signature; a
 * well-formed signature that simply recovers to an unexpected address is
 * not an error here -- callers compare the returned address themselves.
 */
export function recoverEip191Address(
  messageBytes: Uint8Array,
  signature: Uint8Array,
): `0x${string}` {
  if (signature.length !== EIP191_SIGNATURE_LENGTH) {
    invalidInput(
      `EIP-191 signature must be ${EIP191_SIGNATURE_LENGTH} bytes (r || s || v), got ${signature.length}.`,
    );
  }
  const r = signature.slice(0, 32);
  const s = signature.slice(32, 64);
  const rawV = signature[64]!;
  const recovery = rawV >= 27 ? rawV - 27 : rawV;
  if (recovery !== 0 && recovery !== 1) {
    invalidInput(`EIP-191 signature recovery byte "${rawV}" is not 27/28 or 0/1.`);
  }
  // noble's "recovered" signature format is recoveryByte || r || s (recovery
  // byte first) -- the inverse ordering from Ethereum's conventional r || s
  // || v wire format, which this function accepts.
  const recoveredFormat = concatenate([Uint8Array.of(recovery), r, s]);
  const digest = personalSignDigest(messageBytes);
  let publicKeyUncompressed: Uint8Array;
  try {
    const point = secp256k1.Signature.fromBytes(recoveredFormat, "recovered").recoverPublicKey(digest);
    publicKeyUncompressed = point.toBytes(false);
  } catch (cause) {
    return invalidInput("EIP-191 signature does not recover to a valid public key.", cause);
  }
  const addressBytes = keccak_256(publicKeyUncompressed.slice(1)).slice(-20);
  return toChecksumAddress(`0x${bytesToHex(addressBytes)}`);
}

// ---------------------------------------------------------------------------
// Ceremony evidence shapes (design §7.2/§8.1). A key-binding record only
// carries a digest-referenced `CeremonyReference` (key-binding.ts); the
// actual evidence -- the SIWE message content, its exact signed bytes, and
// the signature -- is supplied to these functions directly by the caller
// (the party that resolved the ceremony evidence the digest names).
// ---------------------------------------------------------------------------

/** The profiled SIWE message fields relevant to ceremony verification
 * (design §7.2: a dedicated ceremony `domain`/`uri` so a binding ceremony
 * can never be cross-replayed as a web login or vice versa). */
export interface SiweCeremonyMessage {
  readonly domain: string;
  readonly address: `0x${string}`;
  readonly uri: string;
  readonly version: "1";
  readonly chainId: number;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expirationTime?: string;
  /**
   * §7.2's mandatory content-match payload: for an EOA key-binding
   * ceremony, `[Agent IRI, did:key URI]`; for a ReCap authorization
   * ceremony (§8.1), the transcribed capability strings.
   */
  readonly resources: readonly string[];
}

interface CeremonyEvidenceBase {
  readonly message: SiweCeremonyMessage;
  /** The exact bytes that were EIP-191-signed. */
  readonly messageBytes: Uint8Array;
  /** 65-byte `r || s || v` EIP-191 signature. */
  readonly signature: Uint8Array;
}

export interface EoaCeremonyEvidence extends CeremonyEvidenceBase {
  readonly type: "eoa";
}

export interface ReCapCeremonyEvidence extends CeremonyEvidenceBase {
  readonly type: "recap";
}

export interface CeremonyResult {
  readonly verified: boolean;
  readonly recoveredAddress?: `0x${string}`;
  readonly reason?: string;
}

export interface CeremonyContentMatchResult {
  readonly matches: boolean;
  readonly mismatch?: string;
}

// ---------------------------------------------------------------------------
// §7.2's profiled EIP-4361 (SIWE) message text -- the canonical
// re-serialization the mandatory content match binds to (below). Without
// this, `matchCeremonyContent` would trust the attacker-controllable
// structured `message` object independent of what was actually
// EIP-191-signed (`messageBytes`): a genuine signature over ANY message,
// paired with a fabricated `message` claiming a binding for an arbitrary
// (key, agent) or capability set, would content-match successfully. The
// statement line is fixed per ceremony type (the "profile"); it is not a
// producer-supplied field, so it cannot itself be forged independent of
// `resources`/`domain`/`uri`/etc, all of which ARE bound by this
// byte-equality check.
// ---------------------------------------------------------------------------

const EOA_CEREMONY_STATEMENT = "Bind this working key to the named Agent IRI.";
const RECAP_CEREMONY_STATEMENT = "Authorize the listed capabilities.";

function ceremonyStatement(type: "eoa" | "recap"): string {
  return type === "eoa" ? EOA_CEREMONY_STATEMENT : RECAP_CEREMONY_STATEMENT;
}

/**
 * Canonically re-serializes a structured ceremony `message` to its EIP-4361
 * message text -- the exact bytes a genuine ceremony EIP-191-signs. This is
 * a pure function of `(type, message)`: two callers presented with the same
 * structured fields always produce identical bytes, which is what makes
 * byte-equality against `messageBytes` a meaningful binding check rather
 * than a check with wiggle room.
 */
export function serializeCeremonyMessage(
  type: "eoa" | "recap",
  message: SiweCeremonyMessage,
): Uint8Array {
  const lines = [
    `${message.domain} wants you to sign in with your Ethereum account:`,
    message.address,
    "",
    ceremonyStatement(type),
    "",
    `URI: ${message.uri}`,
    `Version: ${message.version}`,
    `Chain ID: ${message.chainId}`,
    `Nonce: ${message.nonce}`,
    `Issued At: ${message.issuedAt}`,
  ];
  if (message.expirationTime !== undefined) {
    lines.push(`Expiration Time: ${message.expirationTime}`);
  }
  lines.push("Resources:");
  for (const resource of message.resources) {
    lines.push(`- ${resource}`);
  }
  return new TextEncoder().encode(lines.join("\n"));
}

/**
 * §7.1's digest-referenced ceremony evidence: the sha256 digest a
 * key-binding record's `ceremony.digest` commits to. Computed over the
 * full evidence -- `type`, the structured `message`, and the hex-encoded
 * `messageBytes`/`signature` -- so the record's commitment pins exactly
 * which evidence blob a verifier must be shown, not merely its message
 * content.
 */
export function ceremonyEvidenceDigest(
  ceremony: EoaCeremonyEvidence | ReCapCeremonyEvidence,
): Sha256Digest {
  return recordDigest(canonicalJsonBytes({
    type: ceremony.type,
    message: ceremony.message,
    messageBytes: bytesToHex(ceremony.messageBytes),
    signature: bytesToHex(ceremony.signature),
  }));
}

/**
 * §7.2's mandatory field-for-field ceremony<->record content match: the
 * SIWE `resources` Agent IRI must equal `record.agent`, and the
 * `resources` `did:key` must equal `record.key.didKey`; for a ReCap
 * ceremony the transcribed capabilities must equal the statement's. A
 * mismatch means the ceremony binds nothing -- this is what stops a
 * victim's genuine ceremony from being lifted into a binding (or
 * authorization) for a different key, Agent, or capability set.
 *
 * Before any `message.*` field is trusted, the structured `message` is
 * canonically re-serialized and checked for BYTE-EQUALITY against the
 * actually-signed `messageBytes` (§7.2 mandatory content match -- this is
 * what ties the content match to the signature, not just to whatever the
 * evidence supplier claims `message` says). Without this, `message` is an
 * independent, attacker-controllable field: a genuine EIP-191 signature by
 * voucher V over ANY message could be paired with a fabricated `message`
 * naming an arbitrary (key, agent) or capability set and would otherwise
 * content-match successfully.
 */
export function matchCeremonyContent(
  ceremony: EoaCeremonyEvidence,
  record: KeyBinding,
): CeremonyContentMatchResult;
export function matchCeremonyContent(
  ceremony: ReCapCeremonyEvidence,
  record: AuthorizationStatement,
): CeremonyContentMatchResult;
export function matchCeremonyContent(
  ceremony: EoaCeremonyEvidence | ReCapCeremonyEvidence,
  record: KeyBinding | AuthorizationStatement,
): CeremonyContentMatchResult {
  const reserialized = serializeCeremonyMessage(ceremony.type, ceremony.message);
  if (!bytesEqual(reserialized, ceremony.messageBytes)) {
    return {
      matches: false,
      mismatch: "ceremony message does not re-serialize to the signed messageBytes -- the "
        + "structured message and the EIP-191-signed bytes disagree, so no message.* field "
        + "can be trusted (§7.2 mandatory content match).",
    };
  }

  if (ceremony.type === "recap") {
    const statement = record as AuthorizationStatement;
    const transcribed = [...ceremony.message.resources].sort(compareCodeUnitStrings);
    const declared = [...statement.predicate.capabilities].sort(compareCodeUnitStrings);
    const equal = transcribed.length === declared.length
      && transcribed.every((capability, index) => capability === declared[index]);
    if (!equal) {
      return {
        matches: false,
        mismatch: `ReCap ceremony capabilities [${transcribed.join(", ")}] do not equal the `
          + `statement's capabilities [${declared.join(", ")}].`,
      };
    }
    return { matches: true };
  }

  const binding = record as KeyBinding;
  const [agentResource, keyResource] = ceremony.message.resources;
  if (agentResource !== binding.agent) {
    return {
      matches: false,
      mismatch: `SIWE resources Agent IRI "${agentResource ?? ""}" does not equal `
        + `record.agent "${binding.agent}".`,
    };
  }
  if (keyResource !== binding.key.didKey) {
    return {
      matches: false,
      mismatch: `SIWE resources did:key "${keyResource ?? ""}" does not equal `
        + `record.key.didKey "${binding.key.didKey}".`,
    };
  }
  return { matches: true };
}

function accountAddressFromVoucher(binding: KeyBinding): `0x${string}` | undefined {
  if (binding.voucher.kind !== "account") return undefined;
  const match = /^did:pkh:eip155:[0-9]+:(0x[0-9a-fA-F]{40})$/.exec(binding.voucher.did);
  return match ? (match[1] as `0x${string}`) : undefined;
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * §7.5 step 3's offline EOA leg: recovers the EIP-191 signer of the
 * ceremony evidence, checks it against the key-binding's voucher account,
 * and applies the mandatory ceremony<->record content match (§7.2).
 * Cryptographic validity alone never grants binding authority -- a
 * genuinely signed but mismatched (lifted) ceremony still fails. This is
 * what a binding "accepted on its envelope signature alone" (the negative
 * fixture, §16) is missing: ceremony authority, not envelope possession.
 */
export function verifyEoaCeremony(
  ceremony: EoaCeremonyEvidence,
  binding: KeyBinding,
): CeremonyResult {
  const voucherAddress = accountAddressFromVoucher(binding);
  if (voucherAddress === undefined) {
    return { verified: false, reason: "binding voucher is not an EOA account identity." };
  }

  let recoveredAddress: `0x${string}`;
  try {
    recoveredAddress = recoverEip191Address(ceremony.messageBytes, ceremony.signature);
  } catch (cause) {
    return { verified: false, reason: describeError(cause) };
  }

  if (recoveredAddress !== voucherAddress) {
    return {
      verified: false,
      recoveredAddress,
      reason: `recovered signer "${recoveredAddress}" does not match binding voucher `
        + `account "${voucherAddress}".`,
    };
  }

  const content = matchCeremonyContent(ceremony, binding);
  if (!content.matches) {
    return { verified: false, recoveredAddress, reason: content.mismatch };
  }

  return { verified: true, recoveredAddress };
}

/**
 * The ReCap counterpart (§8.1): recovers the EIP-191 signer, requires it to
 * be self-consistent with the ceremony's own declared `message.address`
 * (the ceremony evidence must not lie about who signed it), and applies
 * the transcribed-capabilities content match. Whether the recovered
 * address is *itself* bound to the statement's `issuer` Agent IRI is a
 * resolution-time question (§7.5 step 2, the injected `BindingResolver`)
 * -- out of this I/O-free function's scope; it returns `recoveredAddress`
 * precisely so a caller can perform that resolution.
 */
export function verifyReCapCeremony(
  ceremony: ReCapCeremonyEvidence,
  statement: AuthorizationStatement,
): CeremonyResult {
  let recoveredAddress: `0x${string}`;
  try {
    recoveredAddress = recoverEip191Address(ceremony.messageBytes, ceremony.signature);
  } catch (cause) {
    return { verified: false, reason: describeError(cause) };
  }

  if (recoveredAddress !== ceremony.message.address) {
    return {
      verified: false,
      recoveredAddress,
      reason: `recovered signer "${recoveredAddress}" does not match the ceremony's `
        + `declared message address "${ceremony.message.address}".`,
    };
  }

  const content = matchCeremonyContent(ceremony, statement);
  if (!content.matches) {
    return { verified: false, recoveredAddress, reason: content.mismatch };
  }

  return { verified: true, recoveredAddress };
}
