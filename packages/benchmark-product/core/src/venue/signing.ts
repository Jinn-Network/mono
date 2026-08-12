/**
 * Verdict signing (G2, spec `docs/superpowers/plans/2026-08-05-benchmark-product-m1-composition-dossier.md`
 * §2 G2): the evaluation harness writes an UNSIGNED in-toto Result Evaluation Statement to
 * `out/verdict`. No shipped platform path DSSE-signs it (`client/src/daemon/native-evaluator-
 * composition.ts:308-350` is the closest pattern, but it is marketplace-coupled and not reusable
 * directly). This module owns that missing step for the local venue: a workspace-held Ed25519
 * signing key, the DSSE wrap over the harness's own unsigned bytes, and a reader for the sealed
 * result.
 *
 * `@jinn-network/evidence-protocol` is deliberately never imported here (it is not on this
 * product's dependency allow-list) — the Result Evaluation Statement shape this module needs is
 * re-validated with a local, minimal zod schema instead of importing
 * `ResultEvaluationStatementSchema`.
 *
 * DIVERGENCE FROM `native-evaluator-composition.ts`'s PATTERN (recorded here, reported at
 * delivery): that reference used to wrap via `sealSignedRecord({record: JSON.parse(bytes), ...})`
 * and then assert `sealed.payloadBytes` byte-equals the original file bytes. Against a REAL
 * spawned evaluation harness that assertion could never succeed: the harness writes `out/verdict`
 * via `@jinn-network/attestation-issuer`'s `buildResultEvaluationPayload` →
 * `deterministicJsonBytes`, which pretty-prints (2-space indent, trailing newline, `Object.keys(
 * ).sort()` key order); `sealSignedRecord` re-canonicalizes via `@jinn-network/trust-core`'s
 * `canonicalJsonBytes`, which is COMPACT (no whitespace, `compareCodeUnitStrings` key order).
 * The two canonicalizers never produce the same bytes for any non-trivial object (confirmed
 * empirically by this module's own integration test against the real, compiled
 * evaluation-harness binary — see `./venue.integration.test.ts`). That reference has since been
 * repaired: it checks the harness bytes against `canonicalAttestationJsonBytes` and signs those
 * exact bytes via `sealSignedPayload`, so the two modules now differ only in WHICH exact spelling
 * they seal — both seal once, and neither re-derives the platform's judgment of the content.
 *
 * WHY THIS MODULE STILL RE-ENCODES (supersedes the earlier "BP-13 CORRECTION (F1)" note): the
 * aggregation boundary this module's output feeds — `@jinn-network/benchmarking-aggregate`'s
 * `resolveVerdictOutcome` (`resolved-inputs.ts`'s `parseCanonicalJson`) — re-derives every
 * referenced verdict's DSSE payload bytes at wilson-recompute time, not just at seal time. That
 * note claimed the boundary requires the trust-core compact spelling specifically; it does not.
 * `parseCanonicalJson` is handed `[canonicalJsonBytes, canonicalAttestationJsonBytes]` and accepts
 * a match against EITHER, so compact re-encoding here is this module's own choice rather than a
 * boundary requirement. The choice stands: after the evaluator-id and spec-digest validations
 * below, this module re-encodes the PARSED statement with trust-core's `canonicalJsonBytes` and
 * DSSE-wraps and signs THOSE bytes — a semantic-content-preserving re-encoding of the harness's
 * own statement (same fields, same values, canonical byte order/whitespace), signed once at seal
 * time. No field is added, dropped, or recomputed, only re-serialized.
 *
 * One consequence, deliberately fail-loud rather than silently reshaping data:
 * `canonicalJsonBytes` refuses any JSON number that is not an exact safe integer (program ruling
 * §7.14 — fractional/non-integer quantities must be encoded as decimal strings). A statement
 * whose harness wrote an inherently fractional `measurements[].value` as a JSON number, not a
 * string, cannot be canonicalized and is refused here as a typed `"execution"` error rather than
 * silently truncated or NaN-coerced. The real local venue is unaffected: the prediction evaluator
 * adapter (`@jinn-network/task-execution-evaluator-adapters`) declares every Brier measurement's
 * `type` as `"string"` and formats them with `toFixed`, so its harness output never carries this
 * shape — see `./venue.integration.test.ts` for the empirical proof against the real binary.
 */

import { generateKeyPairSync, randomUUID, sign as edSign, createPrivateKey, createPublicKey, createHash, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { canonicalJsonBytes, dssePreAuthEncoding, parseDsseEnvelope, sealDsseEnvelope, type DsseSigner } from "@jinn-network/trust-core";
import { VERDICT_DSSE_PAYLOAD_TYPE } from "@jinn-network/task-execution-profiles";
import { refuse } from "../errors.js";

const PEM_FILE_NAME = "verdict-signing-key.pem";
const SIDECAR_FILE_NAME = "verdict-signing-key.json";
const EVALUATORS_DIR_NAME = "evaluators";

/** The pre-BP-21 single-evaluator identity: the IRI the legacy top-level key pair
 * (`<workspaceDir>/venue/verdict-signing-key.pem`) signed under. `readEvaluatorPublicKeys` still
 * maps that pair to this IRI so verdicts sealed before the multi-evaluator layout stay
 * verifiable. */
export const LEGACY_VERDICT_EVALUATOR_ID = "urn:jinn:benchmark-product:local-venue:prediction-evaluator";

export interface VerdictSigningKey {
  readonly keyId: string;
  sign(bytes: Uint8Array): Uint8Array;
}

interface SigningKeySidecar {
  readonly keyId: string;
}

interface EvaluatorSigningKeySidecar extends SigningKeySidecar {
  readonly evaluatorId: string;
}

/** The one genuine evaluator key-id derivation, shared by key minting and portable verification. */
export function verdictKeyIdFromEd25519PublicKey(publicKey: KeyObject): string {
  const spkiDer = publicKey.export({ type: "spki", format: "der" });
  const digest = createHash("sha256").update(spkiDer).digest("hex");
  return `benchmark-product-verdict-${digest.slice(0, 16)}`;
}

function toVerdictSigningKey(privateKey: KeyObject, keyId: string): VerdictSigningKey {
  return {
    keyId,
    sign(bytes: Uint8Array): Uint8Array {
      return new Uint8Array(edSign(null, Buffer.from(bytes), privateKey));
    },
  };
}

/**
 * Atomically writes one key-material file: temp file (created 0600) + rename, so a crash can
 * never leave a torn half-written PEM or sidecar, and the file is never observable with a mode
 * looser than 0600 (the mode is set at temp-file creation and travels through the rename —
 * deliberately NOT `../fs/atomic.ts`'s `atomicWriteFileSync`, which does not set a mode and
 * would leave key material umask-readable). Crash-safety across the PAIR of files is handled by
 * the callers' write order plus their recovery branch, not by this helper.
 */
function writeKeyFileAtomicSync(path: string, data: string): void {
  const temporary = `${path}.tmp-${randomUUID()}`;
  writeFileSync(temporary, data, { mode: 0o600 });
  renameSync(temporary, path);
}

/**
 * Loads the workspace's Ed25519 verdict-signing key, generating it on first use. Never commits a
 * key, never places it under an attempt's `secrets/` — it lives at
 * `<workspaceDir>/venue/verdict-signing-key.pem` (PKCS8 PEM, mode 0600) with a small JSON sidecar
 * carrying the derived key id (`benchmark-product-verdict-<first16hex of sha256(SPKI DER)>`).
 */
export function loadOrCreateVerdictSigningKey(workspaceDir: string): VerdictSigningKey {
  const venueDir = join(workspaceDir, "venue");
  mkdirSync(venueDir, { recursive: true });
  const pemPath = join(venueDir, PEM_FILE_NAME);
  const sidecarPath = join(venueDir, SIDECAR_FILE_NAME);

  if (existsSync(pemPath)) {
    const privateKey = createPrivateKey({ key: readFileSync(pemPath, "utf8"), format: "pem", type: "pkcs8" });
    if (existsSync(sidecarPath)) {
      const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8")) as SigningKeySidecar;
      return toVerdictSigningKey(privateKey, sidecar.keyId);
    }
    // Crash recovery: the PEM landed but the sidecar write never did (the mint below writes the
    // PEM first). The key id is derivable from the PEM itself — complete the interrupted mint
    // rather than regenerate; the actual key material is never silently replaced.
    const keyId = verdictKeyIdFromEd25519PublicKey(createPublicKey(privateKey));
    writeKeyFileAtomicSync(sidecarPath, `${JSON.stringify({ keyId } satisfies SigningKeySidecar, null, 2)}\n`);
    return toVerdictSigningKey(privateKey, keyId);
  }
  if (existsSync(sidecarPath)) {
    // The PEM is the key material; without it there is nothing to recover, and minting a fresh
    // key where one was already recorded would be a silent key replacement — refuse instead.
    refuse(
      "execution",
      "venue/verdict-signing-key.pem",
      "verdict signing key PEM is missing but its sidecar exists — key material lost; refusing to silently mint a replacement key",
    );
  }

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyId = verdictKeyIdFromEd25519PublicKey(publicKey);
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  // Each file lands atomically (temp + rename), PEM before sidecar — the recovery branch above
  // understands exactly this order's one possible crash residue (PEM without sidecar).
  writeKeyFileAtomicSync(pemPath, pem);
  writeKeyFileAtomicSync(sidecarPath, `${JSON.stringify({ keyId } satisfies SigningKeySidecar, null, 2)}\n`);
  return toVerdictSigningKey(privateKey, keyId);
}

/**
 * Loads the workspace's per-evaluator Ed25519 verdict-signing keys, minting each on first use
 * (BP-21 multi-evaluator venue). One key per evaluator, at
 * `<workspaceDir>/venue/evaluators/<i>/verdict-signing-key.pem` (PKCS8 PEM, mode 0600, `i`
 * 1-based) with a JSON sidecar carrying `{ keyId, evaluatorId }`. Idempotent: re-loading with the
 * same evaluator list returns the same keys; a persisted slot whose sidecar names a different
 * evaluator id is refused rather than silently re-bound.
 *
 * HONESTY (product design spec §6): these distinct keys prove AGENT-DISTINCTNESS only — that N
 * separately-keyed evaluator agents each signed their own verdict. The same operator mints and
 * holds every one of them on a self-run venue; nothing here is third-party or party-independent
 * verification.
 */
export function loadOrCreateEvaluatorSigningKeys(
  workspaceDir: string,
  evaluators: readonly { readonly id: string }[],
): { readonly id: string; readonly key: VerdictSigningKey }[] {
  return evaluators.map((evaluator, index) => {
    const slotDir = join(workspaceDir, "venue", EVALUATORS_DIR_NAME, String(index + 1));
    mkdirSync(slotDir, { recursive: true });
    const pemPath = join(slotDir, PEM_FILE_NAME);
    const sidecarPath = join(slotDir, SIDECAR_FILE_NAME);

    if (existsSync(pemPath)) {
      const privateKey = createPrivateKey({ key: readFileSync(pemPath, "utf8"), format: "pem", type: "pkcs8" });
      if (existsSync(sidecarPath)) {
        const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8")) as EvaluatorSigningKeySidecar;
        if (sidecar.evaluatorId !== evaluator.id) {
          refuse(
            "execution",
            `venue/evaluators/${index + 1}/verdict-signing-key.json`,
            `persisted evaluator signing key ${index + 1} belongs to "${sidecar.evaluatorId}", not "${evaluator.id}"`,
          );
        }
        return { id: evaluator.id, key: toVerdictSigningKey(privateKey, sidecar.keyId) };
      }
      // Crash recovery: the PEM landed but the sidecar write never did (the mint below writes
      // the PEM first). No binding was ever recorded for this slot, so completing the
      // interrupted mint — same key, this slot's requested evaluator id — is exactly what the
      // crashed call was doing; the key material is never silently replaced.
      const keyId = verdictKeyIdFromEd25519PublicKey(createPublicKey(privateKey));
      writeKeyFileAtomicSync(
        sidecarPath,
        `${JSON.stringify({ keyId, evaluatorId: evaluator.id } satisfies EvaluatorSigningKeySidecar, null, 2)}\n`,
      );
      return { id: evaluator.id, key: toVerdictSigningKey(privateKey, keyId) };
    }
    if (existsSync(sidecarPath)) {
      // The PEM is the key material; without it there is nothing to recover, and minting a
      // fresh key under an already-recorded binding would be a silent key replacement — refuse.
      refuse(
        "execution",
        `venue/evaluators/${index + 1}/verdict-signing-key.pem`,
        `evaluator signing key ${index + 1} PEM is missing but its sidecar exists — key material lost; refusing to silently mint a replacement key`,
      );
    }

    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const keyId = verdictKeyIdFromEd25519PublicKey(publicKey);
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    // Each file lands atomically (temp + rename), PEM before sidecar — the recovery branch
    // above understands exactly this order's one possible crash residue (PEM without sidecar).
    writeKeyFileAtomicSync(pemPath, pem);
    writeKeyFileAtomicSync(
      sidecarPath,
      `${JSON.stringify({ keyId, evaluatorId: evaluator.id } satisfies EvaluatorSigningKeySidecar, null, 2)}\n`,
    );
    return { id: evaluator.id, key: toVerdictSigningKey(privateKey, keyId) };
  });
}

/**
 * The workspace's evaluator public-key registry (evaluatorId → public `KeyObject`), for verifying
 * verdict DSSE signatures fail-closed: a verdict whose signer key is not in this map (or whose
 * signature does not verify against its evaluator's entry) must be rejected by the caller. Scans
 * every `venue/evaluators/<i>/` slot and ALSO maps the legacy top-level pair to `LEGACY_VERDICT_EVALUATOR_ID`
 * when it exists. Public keys derive from the private PEMs via `createPublicKey` — no new files.
 */
export function readEvaluatorPublicKeys(workspaceDir: string): Map<string, KeyObject> {
  return new Map(
    [...readEvaluatorPublicKeyRecords(workspaceDir)].map(([evaluatorId, record]) => [evaluatorId, record.publicKey]),
  );
}

export interface EvaluatorPublicKeyRecord {
  readonly keyId: string;
  readonly publicKey: KeyObject;
}

/** Public-key registry with the signer key id retained for BP-40 portable trust export. The
 * publisher may derive these public keys from workspace-held private PEMs; only SPKI public
 * bytes and the cross-checked sidecar id enter the bundle. */
export function readEvaluatorPublicKeyRecords(workspaceDir: string): Map<string, EvaluatorPublicKeyRecord> {
  const registry = new Map<string, EvaluatorPublicKeyRecord>();
  const venueDir = join(workspaceDir, "venue");

  const legacyPemPath = join(venueDir, PEM_FILE_NAME);
  if (existsSync(legacyPemPath)) {
    const privateKey = createPrivateKey({ key: readFileSync(legacyPemPath, "utf8"), format: "pem", type: "pkcs8" });
    const sidecarPath = join(venueDir, SIDECAR_FILE_NAME);
    if (!existsSync(sidecarPath)) {
      refuse("execution", `venue/${SIDECAR_FILE_NAME}`, "legacy evaluator key is missing its sidecar");
    }
    const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8")) as SigningKeySidecar;
    registry.set(LEGACY_VERDICT_EVALUATOR_ID, { keyId: sidecar.keyId, publicKey: createPublicKey(privateKey) });
  }

  const evaluatorsDir = join(venueDir, EVALUATORS_DIR_NAME);
  if (!existsSync(evaluatorsDir)) return registry;
  for (const entry of readdirSync(evaluatorsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pemPath = join(evaluatorsDir, entry.name, PEM_FILE_NAME);
    const sidecarPath = join(evaluatorsDir, entry.name, SIDECAR_FILE_NAME);
    if (!existsSync(pemPath) && !existsSync(sidecarPath)) continue;
    if (!existsSync(pemPath) || !existsSync(sidecarPath)) {
      refuse(
        "execution",
        `venue/evaluators/${entry.name}`,
        `evaluator key slot "${entry.name}" is missing its ${existsSync(pemPath) ? "sidecar" : "PEM"} file`,
      );
    }
    const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8")) as EvaluatorSigningKeySidecar;
    const privateKey = createPrivateKey({ key: readFileSync(pemPath, "utf8"), format: "pem", type: "pkcs8" });
    registry.set(sidecar.evaluatorId, { keyId: sidecar.keyId, publicKey: createPublicKey(privateKey) });
  }
  return registry;
}

/** Adapts a `VerdictSigningKey` to `@jinn-network/trust-core`'s injected `DsseSigner` port. */
export function createVerdictDsseSigner(key: VerdictSigningKey): DsseSigner {
  return async ({ preAuthEncoding }) => [{ keyid: key.keyId, signature: key.sign(preAuthEncoding) }];
}

// --- minimal local schema for the harness's unsigned Result Evaluation Statement ------------

const MeasurementValueSchema = z.union([z.string(), z.number(), z.boolean()]);

const VerdictStatementSchema = z.looseObject({
  predicateType: z.string().min(1),
  predicate: z.looseObject({
    evaluator: z.looseObject({ id: z.string().min(1) }),
    verdict: z.enum(["pass", "fail", "inconclusive"]),
    evaluationSpecification: z.looseObject({
      digest: z.looseObject({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
    }),
    measurements: z.array(z.looseObject({ name: z.string().min(1), value: MeasurementValueSchema })).optional(),
    evaluatedAt: z.string().min(1),
  }),
});

export interface VerdictStatementView {
  readonly evaluatorId: string;
  readonly verdict: "pass" | "fail" | "inconclusive";
  readonly evaluationSpecificationSha256: string;
  readonly measurements: Record<string, boolean | number | string>;
  readonly evaluatedAt: string;
}

function decodeUtf8Json(bytes: Uint8Array, label: string): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    refuse("execution", label, `${label} is not valid UTF-8`);
  }
  try {
    return JSON.parse(text);
  } catch {
    refuse("execution", label, `${label} is not valid JSON`);
  }
}

/** Validates already-decoded JSON against the Result Evaluation Statement shape and projects the
 * product-scope view. Split out of `parseVerdictStatement` so a caller that already has the
 * decoded JSON (`sealVerdictStatement`, which also needs it for canonicalization) can validate
 * without decoding the same bytes a second time. */
function parseVerdictStatementJson(json: unknown, label: string): VerdictStatementView {
  const parsed = VerdictStatementSchema.safeParse(json);
  if (!parsed.success) {
    refuse("execution", label, `${label} does not conform to the expected Result Evaluation Statement shape`);
  }
  const { predicate } = parsed.data;
  const measurements: Record<string, boolean | number | string> = {};
  for (const measurement of predicate.measurements ?? []) measurements[measurement.name] = measurement.value;
  return {
    evaluatorId: predicate.evaluator.id,
    verdict: predicate.verdict,
    evaluationSpecificationSha256: predicate.evaluationSpecification.digest.sha256,
    measurements,
    evaluatedAt: predicate.evaluatedAt,
  };
}

function parseVerdictStatement(bytes: Uint8Array, label: string): VerdictStatementView {
  const json = decodeUtf8Json(bytes, label);
  return parseVerdictStatementJson(json, label);
}

export interface SealVerdictStatementInput {
  /** The harness's own unsigned `out/verdict` bytes, verbatim. */
  readonly statementBytes: Uint8Array;
  /** The venue's evaluator identity — must equal `predicate.evaluator.id`. */
  readonly evaluatorId: string;
  /** The evaluation cell's own EvaluationSpec digest (bare hex) — must equal
   * `predicate.evaluationSpecification.digest.sha256`. */
  readonly expectedEvaluationSpecificationSha256: string;
  readonly signer: DsseSigner;
}

/**
 * Validates the harness's unsigned statement against this evaluation cell's exact authority
 * (evaluator identity, EvaluationSpec digest — mirrors `native-evaluator-composition.ts`'s
 * checks), then re-encodes the PARSED statement as trust-core canonical bytes and DSSE-wraps and
 * signs THOSE bytes (see the module-level comment above, BP-13 correction F1: the aggregation
 * boundary this seals for requires the exact canonical encoding, not the harness's own
 * pretty-printed bytes). A statement that cannot be canonicalized — most commonly a
 * `measurements[].value` written as a non-safe-integer JSON number rather than a decimal string —
 * is refused as a typed `"execution"` error rather than silently reshaped.
 */
export async function sealVerdictStatement(input: SealVerdictStatementInput): Promise<Uint8Array> {
  // Decode once — the validation view and the canonicalization below both consume this same
  // parsed JSON, rather than each re-decoding `input.statementBytes` independently.
  const parsedStatement = decodeUtf8Json(input.statementBytes, "verdict statement");
  const view = parseVerdictStatementJson(parsedStatement, "verdict statement");
  if (view.evaluatorId !== input.evaluatorId) {
    refuse(
      "execution",
      "predicate.evaluator.id",
      "verdict statement evaluator id does not match the local venue's evaluator identity",
    );
  }
  if (view.evaluationSpecificationSha256 !== input.expectedEvaluationSpecificationSha256) {
    refuse(
      "execution",
      "predicate.evaluationSpecification.digest.sha256",
      "verdict statement evaluation specification digest does not match this evaluation cell's EvaluationSpec",
    );
  }

  let canonicalBytes: Uint8Array;
  try {
    canonicalBytes = canonicalJsonBytes(parsedStatement);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    refuse(
      "execution",
      "verdict statement",
      `verdict statement cannot be canonicalized (§7.14 — fractional measurement values must be `
        + `decimal strings, not JSON numbers): ${detail}`,
    );
  }

  const preAuthEncoding = dssePreAuthEncoding(VERDICT_DSSE_PAYLOAD_TYPE, canonicalBytes);
  const signatures = await input.signer({
    payloadType: VERDICT_DSSE_PAYLOAD_TYPE,
    payloadBytes: canonicalBytes,
    preAuthEncoding,
  });
  return sealDsseEnvelope({
    payloadBytes: canonicalBytes,
    signatures,
    payloadType: VERDICT_DSSE_PAYLOAD_TYPE,
  });
}

/** Parses a sealed verdict DSSE envelope (`payloadType` must be the verdict DSSE payload type)
 * and returns the product-scope view of its statement. Does not verify the signature — that is
 * the caller's job (Ed25519 `crypto.verify` against the workspace public key, per the spec). */
export function readVerdictEnvelope(envelopeBytes: Uint8Array): VerdictStatementView {
  const parsed = parseDsseEnvelope(envelopeBytes);
  if (parsed.payloadType !== VERDICT_DSSE_PAYLOAD_TYPE) {
    refuse("execution", "payloadType", "verdict envelope payloadType is not the verdict DSSE payload type");
  }
  return parseVerdictStatement(parsed.payloadBytes, "verdict envelope payload");
}
