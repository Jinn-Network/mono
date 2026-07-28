// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import type { DsseSigner, SealedRecord } from "./dsse.js";
import { parseSignedRecordEnvelope, sealSignedRecord } from "./dsse.js";
import { recordDigest } from "./hashing.js";
import { invalidInput } from "./errors.js";
import { TRUST_POLICY_FORMAT, TRUST_POLICY_MEDIA_TYPE } from "./identifiers.js";
import { Sha256DigestSchema } from "./types.js";
import type { Sha256Digest, ValidationDiagnostic } from "./types.js";
import { AgentIriSchema, DidKeySchema } from "./spellings.js";
import { StrengthSchema } from "./key-binding.js";

// ---------------------------------------------------------------------------
// Trust-policy documents (§9). "One policy shape replaces every allowlist."
// ---------------------------------------------------------------------------

/** The 9 core-registered policy purposes (§9). Deployments extend under
 * their own namespaces (same namespaced-extension grammar as scope, §5). */
export const POLICY_PURPOSES = [
  "adoption-authority",
  "admission-agent",
  "verifier-agent",
  "witness-verifier",
  "parser-registry",
  "receipt-author",
  "plugin-signer",
  "dispatcher-author",
  "evaluator-eligibility",
] as const;
export type PolicyPurpose = (typeof POLICY_PURPOSES)[number];

const NAMESPACED_PURPOSE_PATTERN = /^[a-z][a-z0-9-]*:[A-Za-z0-9-]+$/;

export const PolicyPurposeSchema = z.string().refine(
  (value) => (POLICY_PURPOSES as readonly string[]).includes(value)
    || NAMESPACED_PURPOSE_PATTERN.test(value),
  { message: "policy purpose must be one of the 9 core purposes or a namespaced extension (namespace:custom)" },
);

export const PolicyPurposeEntrySchema = z.looseObject({
  accepted: z.array(AgentIriSchema),
  requiredStrength: StrengthSchema,
});
export type PolicyPurposeEntry = z.infer<typeof PolicyPurposeEntrySchema>;

/**
 * Signer sets are working keys listed in the previous version -- TUF-
 * native, and the one sanctioned exception to "entries name IRIs" (§9): the
 * chain must be verifiable without recursing into binding resolution.
 */
export const SignerSetSchema = z.looseObject({
  keys: z.array(DidKeySchema).min(1),
  threshold: z.number().int().positive(),
}).refine((set) => set.threshold <= set.keys.length, {
  message: "signerSet.threshold must not exceed the number of declared keys",
});
export type SignerSet = z.infer<typeof SignerSetSchema>;

const CREDIT_REGIME_VALUES = ["loop-completion", "pass-gated"] as const;

export const TrustPolicySchema = z.looseObject({
  protocol: z.literal(TRUST_POLICY_FORMAT),
  version: z.number().int().positive(),
  /** Hash-link to the predecessor version's envelope digest. Absent only
   * for the genesis version. */
  predecessor: Sha256DigestSchema.optional(),
  purposes: z.record(PolicyPurposeSchema, PolicyPurposeEntrySchema),
  signerSet: SignerSetSchema,
  refreshBy: z.iso.datetime(),
  /** Optional, namespaced per credit stream (§9 credit-regime declaration). */
  creditRegime: z.record(z.string(), z.enum(CREDIT_REGIME_VALUES)).optional(),
});
export type TrustPolicy = z.infer<typeof TrustPolicySchema>;

export interface TrustPolicyValidationReport {
  readonly conforms: boolean;
  readonly diagnostics: readonly ValidationDiagnostic[];
  readonly value?: TrustPolicy;
}

/** Structurally parses and schema-validates a single sealed trust-policy
 * envelope. Chain-level rules (dual-threshold, freshness, anti-rollback,
 * genesis pinning) are `verifyPolicyChain`'s job, not this per-document
 * check. */
export function validateTrustPolicy(envelopeBytes: Uint8Array): TrustPolicyValidationReport {
  let payloadBytes: Uint8Array;
  try {
    ({ payloadBytes } = parseSignedRecordEnvelope(envelopeBytes, TRUST_POLICY_MEDIA_TYPE));
  } catch (cause) {
    return {
      conforms: false,
      diagnostics: [{ code: "ENVELOPE_INVALID", path: "", message: describeError(cause) }],
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes));
  } catch (cause) {
    return {
      conforms: false,
      diagnostics: [{ code: "PAYLOAD_NOT_JSON", path: "", message: describeError(cause) }],
    };
  }

  const result = TrustPolicySchema.safeParse(payload);
  if (!result.success) {
    return {
      conforms: false,
      diagnostics: result.error.issues.map((issue) => ({
        code: "SCHEMA_VIOLATION",
        path: issue.path.join("."),
        message: issue.message,
      })),
    };
  }

  return { conforms: true, diagnostics: [], value: result.data };
}

/** Canonicalizes and DSSE-seals a trust-policy document under its own
 * vendor media type (TEP §21.2). */
export async function sealTrustPolicy(
  policy: TrustPolicy,
  signer: DsseSigner,
  signal?: AbortSignal,
): Promise<SealedRecord> {
  let parsed: TrustPolicy;
  try {
    parsed = TrustPolicySchema.parse(policy);
  } catch (cause) {
    return invalidInput("Trust-policy document does not conform to TrustPolicySchema.", cause);
  }
  return sealSignedRecord({
    record: parsed,
    payloadType: TRUST_POLICY_MEDIA_TYPE,
    signer,
    ...(signal === undefined ? {} : { signal }),
  });
}

// ---------------------------------------------------------------------------
// Policy-chain verification (§9). DSSE-offline + signer-set membership
// only -- never recurses into §7.5 step 5 binding resolution on its own
// signers (otherwise the policy would be needed to verify the policy).
// ---------------------------------------------------------------------------

export interface DsseChainVerificationResult {
  /** did:key values whose signature over the envelope's DSSE
   * pre-authentication encoding validated cryptographically. */
  readonly validSignerKeyids: readonly string[];
}

/**
 * An injected, pure-compute DSSE-signature-verification port. Deliberately
 * injected rather than implemented in `policy.ts` directly: real
 * verification is multicodec-aware (`did:key` can encode more than one
 * curve), and `ceremony.ts` (T8, Milestone 3) is where this design
 * introduces `@noble/curves`-based signature recovery for the first time --
 * duplicating that ahead of T8 here risked diverging conventions. See the
 * T7 finding recorded in the implementer's final report.
 */
export type DsseChainVerifier = (envelopeBytes: Uint8Array) => DsseChainVerificationResult;

export interface VerifyPolicyChainOptions {
  /** Pins the chain's genesis by its sealed envelope digest -- the
   * deployment profile's by-digest reference (§9). */
  readonly genesisAnchor: { readonly digest: Sha256Digest };
  /** ISO datetime string, compared lexically against `refreshBy` (both are
   * `z.iso.datetime()` UTC strings of matching format, so code-unit order
   * matches chronological order). */
  readonly now: string;
  readonly dsseVerifier: DsseChainVerifier;
}

export type PolicyChainFailureReason =
  | "invalid-document"
  | "missing-genesis"
  | "competing-genesis"
  | "genesis-mismatch"
  | "threshold-not-met"
  | "dual-threshold-not-met"
  | "non-monotonic-version"
  | "rollback-detected"
  | "policy-expired";

export interface PolicyChainVerificationResult {
  readonly ok: boolean;
  readonly newest?: TrustPolicy;
  readonly reason?: PolicyChainFailureReason;
}

interface ParsedPolicyVersion {
  readonly envelopeBytes: Uint8Array;
  readonly digest: Sha256Digest;
  readonly value: TrustPolicy;
}

function parsePolicyVersion(envelopeBytes: Uint8Array): ParsedPolicyVersion | undefined {
  try {
    const { payloadBytes } = parseSignedRecordEnvelope(envelopeBytes, TRUST_POLICY_MEDIA_TYPE);
    const payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes));
    const result = TrustPolicySchema.safeParse(payload);
    if (!result.success) return undefined;
    return { envelopeBytes, digest: recordDigest(envelopeBytes), value: result.data };
  } catch {
    return undefined;
  }
}

function meetsThreshold(validKeyids: ReadonlySet<string>, signerSet: SignerSet): boolean {
  let matched = 0;
  for (const key of signerSet.keys) {
    if (validKeyids.has(key)) matched += 1;
  }
  return matched >= signerSet.threshold;
}

/**
 * Verifies a hash-linked, dual-threshold-signed trust-policy version chain
 * (§9) and resolves the newest fresh version. `versions` may be supplied in
 * any order. Never resolves bindings, never invokes §7.5 step 5 -- the
 * chain is verifiable from DSSE signatures and declared signer-set
 * membership alone.
 */
export function verifyPolicyChain(
  versions: readonly Uint8Array[],
  options: VerifyPolicyChainOptions,
): PolicyChainVerificationResult {
  const parsedVersions: ParsedPolicyVersion[] = [];
  for (const envelopeBytes of versions) {
    const parsed = parsePolicyVersion(envelopeBytes);
    if (parsed === undefined) return { ok: false, reason: "invalid-document" };
    parsedVersions.push(parsed);
  }

  const genesisCandidates = parsedVersions.filter((version) => version.value.predecessor === undefined);
  if (genesisCandidates.length === 0) return { ok: false, reason: "missing-genesis" };
  if (genesisCandidates.length > 1) return { ok: false, reason: "competing-genesis" };
  const genesis = genesisCandidates[0]!;
  if (genesis.digest !== options.genesisAnchor.digest) {
    return { ok: false, reason: "genesis-mismatch" };
  }

  const genesisValidKeyids = new Set(options.dsseVerifier(genesis.envelopeBytes).validSignerKeyids);
  if (!meetsThreshold(genesisValidKeyids, genesis.value.signerSet)) {
    return { ok: false, reason: "threshold-not-met" };
  }

  const consumed = new Set<ParsedPolicyVersion>([genesis]);
  let current = genesis;
  for (;;) {
    const children = parsedVersions.filter(
      (version) => !consumed.has(version) && version.value.predecessor === current.digest,
    );
    if (children.length === 0) break;
    if (children.length > 1) return { ok: false, reason: "rollback-detected" };

    const child = children[0]!;
    if (child.value.version <= current.value.version) {
      return { ok: false, reason: "non-monotonic-version" };
    }

    const validKeyids = new Set(options.dsseVerifier(child.envelopeBytes).validSignerKeyids);
    const oldThresholdMet = meetsThreshold(validKeyids, current.value.signerSet);
    const newThresholdMet = meetsThreshold(validKeyids, child.value.signerSet);
    if (!oldThresholdMet || !newThresholdMet) {
      return { ok: false, reason: "dual-threshold-not-met" };
    }

    consumed.add(child);
    current = child;
  }

  if (current.value.refreshBy < options.now) {
    return { ok: false, reason: "policy-expired" };
  }

  return { ok: true, newest: current.value };
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
