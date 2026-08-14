/**
 * Report signing (BP-13 deliverable 1, spec §7.1/§12.1): a WORKSPACE-HELD Ed25519 key, separate
 * from `../venue/signing.ts`'s verdict-signing key.
 *
 * Role separation is the reason for two keys, not two files by accident: the verdict key signs
 * the venue's evaluation statements (an evaluator act — "this cell's outcome is X"); the report
 * key signs the product's interpretation of the sealed record set, as report author (an author
 * act — "this is what the results say, computed this way, with these disclosures and
 * limitations"). Separate key material means rotating one never invalidates the other, and the
 * structural claim "the verdict signer key is not the report signer key" is true by construction,
 * not by convention. That said — on THIS self-run local venue, both keys are still held by the
 * same operator (this workspace). Two keys prove role separation, not independent custody; the
 * `../report/trust.ts` module that resolves this key's binding says so plainly, and the claim
 * package's `venueHonesty` block (`../report/claim.ts`) discloses it again downstream. Two keys
 * are not two parties.
 *
 * The keyId is a genuine `did:key` for Ed25519 (multicodec prefix `0xed 0x01` + the raw 32-byte
 * public key, base58btc-encoded, `did:key:z`-prefixed) — satisfying `@jinn-network/trust-core`'s
 * `DidKeySchema`, which the workspace-local trust binding (`./trust.ts`) requires for its
 * `KeyBinding.key.didKey` field. `@jinn-network/trust-core` deliberately validates `did:key`
 * strings by format only (no multicodec decode) — see its `spellings.ts` — so this module owns a
 * small local base58btc encoder (Bitcoin alphabet) rather than reaching for an external
 * dependency neither `trust-core` nor this product's dependency allow-list carries.
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dssePreAuthEncoding, parseDsseEnvelope, type DsseSigner } from "@jinn-network/trust-core";
import { atomicWriteFileSync } from "../fs/atomic.js";
import { acquireRunPublicationGuard } from "../run/finalization-lock.js";

const PEM_FILE_NAME = "report-signing-key.pem";
const SIDECAR_FILE_NAME = "report-signing-key.json";

/** Bitcoin base58 alphabet — matches `@jinn-network/trust-core`'s `DidKeySchema` character class
 * exactly (excludes `0`, `O`, `I`, `l`). */
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Multicodec prefix for an Ed25519 public key (`ed25519-pub`, varint `0xed01`), per the
 * `did:key` spec's Ed25519 method. */
const ED25519_MULTICODEC_PREFIX = Uint8Array.of(0xed, 0x01);

function base58btcEncode(bytes: Uint8Array): string {
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) leadingZeros += 1;

  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);

  let digits = "";
  while (value > 0n) {
    const remainder = value % 58n;
    value /= 58n;
    digits = BASE58_ALPHABET[Number(remainder)] + digits;
  }
  return "1".repeat(leadingZeros) + digits;
}

/** Ed25519 raw public key bytes, extracted via JWK export (`x` is the base64url-encoded 32-byte
 * point) — avoids hand-parsing the SPKI DER's ASN.1 structure for the 32 trailing bytes. */
function rawEd25519PublicKeyBytes(publicKey: KeyObject): Uint8Array {
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
  if (typeof jwk.x !== "string" || jwk.x.length === 0) {
    throw new Error("Ed25519 public key JWK export is missing its x-coordinate");
  }
  const raw = Buffer.from(jwk.x, "base64url");
  if (raw.length !== 32) {
    throw new Error(`Ed25519 public key raw bytes must be 32 bytes, got ${raw.length}`);
  }
  return new Uint8Array(raw);
}

/** `did:key:z<base58btc(0xed 0x01 || raw 32-byte Ed25519 public key)>` — satisfies
 * `@jinn-network/trust-core`'s `DidKeySchema`. */
export function didKeyFromEd25519PublicKey(publicKey: KeyObject): string {
  const raw = rawEd25519PublicKeyBytes(publicKey);
  const multicodecPrefixed = new Uint8Array(ED25519_MULTICODEC_PREFIX.length + raw.length);
  multicodecPrefixed.set(ED25519_MULTICODEC_PREFIX, 0);
  multicodecPrefixed.set(raw, ED25519_MULTICODEC_PREFIX.length);
  return `did:key:z${base58btcEncode(multicodecPrefixed)}`;
}

export interface ReportSigningKey {
  readonly keyId: string;
  readonly publicKey: KeyObject;
  sign(bytes: Uint8Array): Uint8Array;
}

interface ReportSigningKeySidecar {
  readonly keyId: string;
}

function toReportSigningKey(privateKey: KeyObject, publicKey: KeyObject, keyId: string): ReportSigningKey {
  return {
    keyId,
    publicKey,
    sign(bytes: Uint8Array): Uint8Array {
      return new Uint8Array(edSign(null, Buffer.from(bytes), privateKey));
    },
  };
}

/**
 * Loads the workspace's Ed25519 report-signing key, generating it on first use. Mirrors
 * `../venue/signing.ts`'s `loadOrCreateVerdictSigningKey` load-or-generate shape, but under its
 * own file basenames so the two keys never collide on disk:
 * `<workspaceDir>/venue/report-signing-key.pem` (PKCS8 PEM, mode 0600) with a JSON sidecar
 * carrying the derived `did:key` keyId.
 */
export function loadOrCreateReportSigningKey(workspaceDir: string): ReportSigningKey {
  const venueDir = join(workspaceDir, "venue");
  mkdirSync(venueDir, { recursive: true });
  const pemPath = join(venueDir, PEM_FILE_NAME);
  const sidecarPath = join(venueDir, SIDECAR_FILE_NAME);

  const loadPersisted = (): ReportSigningKey | undefined => {
    const hasPem = existsSync(pemPath);
    const hasSidecar = existsSync(sidecarPath);
    if (!hasPem && !hasSidecar) return undefined;
    if (hasPem !== hasSidecar) throw new Error("report signing key PEM/sidecar pair is incomplete");
    const pem = readFileSync(pemPath, "utf8");
    const privateKey = createPrivateKey({ key: pem, format: "pem", type: "pkcs8" });
    const publicKey = createPublicKey(privateKey);
    const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8")) as ReportSigningKeySidecar;
    const derived = didKeyFromEd25519PublicKey(publicKey);
    if (sidecar.keyId !== derived) throw new Error("report signing key sidecar does not match the persisted Ed25519 public key");
    return toReportSigningKey(privateKey, publicKey, sidecar.keyId);
  };

  const present = loadPersisted();
  if (present !== undefined) return present;

  // The fenced workspace-global lock prevents two fresh processes from independently creating
  // a PEM/sidecar pair. Recheck after acquisition because another process may have won.
  const started = Date.now();
  let lock: ReturnType<typeof acquireRunPublicationGuard>;
  do {
    lock = acquireRunPublicationGuard(workspaceDir, "__workspace-report-signing-key__");
    if (lock.acquired) break;
    if (lock.reason !== "contended") throw new Error(`report signing key lock is ${lock.reason}: ${lock.detail}`);
    if (Date.now() - started >= 30_000) throw new Error("timed out waiting for report signing key lock");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  } while (!lock.acquired);

  try {
    const raced = loadPersisted();
    if (raced !== undefined) return raced;

    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const keyId = didKeyFromEd25519PublicKey(publicKey);
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    atomicWriteFileSync(pemPath, pem, 0o600);
    atomicWriteFileSync(sidecarPath, `${JSON.stringify({ keyId } satisfies ReportSigningKeySidecar, null, 2)}\n`, 0o600);
    return loadPersisted()!;
  } finally {
    if (lock.acquired) lock.release();
  }
}

/** Adapts a `ReportSigningKey` to `@jinn-network/trust-core`'s injected `DsseSigner` port. */
export function createReportDsseSigner(key: ReportSigningKey): DsseSigner {
  return async ({ preAuthEncoding }) => [{ keyid: key.keyId, signature: key.sign(preAuthEncoding) }];
}

export interface DsseChainVerificationResult {
  readonly validSignerKeyids: readonly string[];
}

/**
 * A real envelope verifier over exactly one known public key (this workspace's own report key):
 * parses `envelopeBytes`, recomputes the DSSE pre-authentication encoding, and Ed25519-verifies
 * every signature whose declared `keyid` names this key. Returns the `DsseChainVerifier` shape
 * `@jinn-network/trust-core`'s `verifyEnvelopeBinding` expects (`(envelopeBytes) =>
 * {validSignerKeyids}`) when partially applied over `key` — see `./trust.ts`'s
 * `buildWorkspaceTrustDeps`. Never throws: a malformed envelope or a non-matching/invalid
 * signature both resolve to an empty `validSignerKeyids`, matching `DsseChainVerifier`'s
 * fail-closed contract.
 */
export function verifyReportEnvelopeSignatures(
  envelopeBytes: Uint8Array,
  key: Pick<ReportSigningKey, "keyId" | "publicKey">,
): DsseChainVerificationResult {
  let parsed: ReturnType<typeof parseDsseEnvelope>;
  try {
    parsed = parseDsseEnvelope(envelopeBytes);
  } catch {
    return { validSignerKeyids: [] };
  }

  const preAuthEncoding = dssePreAuthEncoding(parsed.payloadType, parsed.payloadBytes);
  const validSignerKeyids: string[] = [];
  for (const signature of parsed.signatures) {
    if (signature.keyid !== key.keyId) continue;
    let decodedSignature: Buffer;
    try {
      decodedSignature = Buffer.from(signature.sig, "base64");
    } catch {
      continue;
    }
    if (decodedSignature.length === 0) continue;
    let valid: boolean;
    try {
      valid = edVerify(null, Buffer.from(preAuthEncoding), key.publicKey, decodedSignature);
    } catch {
      valid = false;
    }
    if (valid) validSignerKeyids.push(key.keyId);
  }
  return { validSignerKeyids };
}
