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
 * delivery): that reference wraps via `sealSignedRecord({record: JSON.parse(bytes), ...})` and
 * then asserts `sealed.payloadBytes` byte-equals the original file bytes. Against a REAL spawned
 * evaluation harness this assertion cannot succeed: the harness writes `out/verdict` via
 * `@jinn-network/attestation-issuer`'s `buildResultEvaluationPayload` →
 * `deterministicJsonBytes`, which pretty-prints (2-space indent, trailing newline, `Object.keys(
 * ).sort()` key order); `sealSignedRecord` re-canonicalizes via `@jinn-network/trust-core`'s
 * `canonicalJsonBytes`, which is COMPACT (no whitespace, `compareCodeUnitStrings` key order).
 * The two canonicalizers never produce the same bytes for any non-trivial object, so the
 * byte-equality assertion is unsatisfiable for genuine harness output (confirmed empirically by
 * this module's own integration test against the real, compiled evaluation-harness binary — see
 * `./venue.integration.test.ts`). This module therefore does not reconstruct the payload at all:
 * it DSSE-wraps the harness's `out/verdict` bytes VERBATIM (`dssePreAuthEncoding` +
 * `sealDsseEnvelope` directly), which is both simpler and a more literal reading of "seal-once" —
 * the harness's bytes already are the sealed record; this module signs and wraps them, never
 * re-derives them.
 */

import { generateKeyPairSync, sign as edSign, createPrivateKey, createHash, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { dssePreAuthEncoding, parseDsseEnvelope, sealDsseEnvelope, type DsseSigner } from "@jinn-network/trust-core";
import { VERDICT_DSSE_PAYLOAD_TYPE } from "@jinn-network/task-execution-profiles";
import { refuse } from "../errors.js";

const PEM_FILE_NAME = "verdict-signing-key.pem";
const SIDECAR_FILE_NAME = "verdict-signing-key.json";

export interface VerdictSigningKey {
  readonly keyId: string;
  sign(bytes: Uint8Array): Uint8Array;
}

interface SigningKeySidecar {
  readonly keyId: string;
}

function deriveKeyId(publicKey: KeyObject): string {
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

  if (existsSync(pemPath) && existsSync(sidecarPath)) {
    const pem = readFileSync(pemPath, "utf8");
    const privateKey = createPrivateKey({ key: pem, format: "pem", type: "pkcs8" });
    const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8")) as SigningKeySidecar;
    return toVerdictSigningKey(privateKey, sidecar.keyId);
  }

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyId = deriveKeyId(publicKey);
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  writeFileSync(pemPath, pem, { mode: 0o600 });
  writeFileSync(sidecarPath, `${JSON.stringify({ keyId } satisfies SigningKeySidecar, null, 2)}\n`, { mode: 0o600 });
  return toVerdictSigningKey(privateKey, keyId);
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

function parseVerdictStatement(bytes: Uint8Array, label: string): VerdictStatementView {
  const json = decodeUtf8Json(bytes, label);
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
 * checks), then DSSE-wraps `input.statementBytes` VERBATIM — no re-serialization, no
 * re-canonicalization (see the module-level comment above for why: the two canonicalizers in
 * this stack disagree byte-for-byte, so reconstructing the payload and asserting equality can
 * never succeed against real harness output). The signature covers exactly the bytes the harness
 * wrote.
 */
export async function sealVerdictStatement(input: SealVerdictStatementInput): Promise<Uint8Array> {
  const view = parseVerdictStatement(input.statementBytes, "verdict statement");
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
  const preAuthEncoding = dssePreAuthEncoding(VERDICT_DSSE_PAYLOAD_TYPE, input.statementBytes);
  const signatures = await input.signer({
    payloadType: VERDICT_DSSE_PAYLOAD_TYPE,
    payloadBytes: input.statementBytes,
    preAuthEncoding,
  });
  return sealDsseEnvelope({
    payloadBytes: input.statementBytes,
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
