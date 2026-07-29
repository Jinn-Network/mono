// SPDX-License-Identifier: Apache-2.0

import { ceremonyEvidenceDigest, verifyEoaCeremony } from "./ceremony.js";
import { canonicalJsonBytes } from "./canonical-json.js";
import { dssePreAuthEncoding, sealDsseEnvelope } from "./dsse.js";
import { TRUST_KEY_BINDING_MEDIA_TYPE } from "./identifiers.js";
import { compareCalendarStrictRfc3339Instants, isCalendarStrictRfc3339 } from "./rfc3339.js";
import type { DsseChainVerifier } from "./policy.js";
import type { Strength } from "./key-binding.js";
import type { VoucherIdentity } from "./spellings.js";
import type {
  BindingResolver,
  ResolvedBinding,
  ResolvedRevocation,
  WitnessVerifier,
} from "./interfaces.js";

// ---------------------------------------------------------------------------
// §7.5's normative verification procedure, §7.5a's settlement join check,
// and §7.5b's requester authentication -- I/O-free (design §17): steps 1,
// 4, and 5 are pure compute here; steps 2-3's chain/anchor/witness facts
// come from the injected `BindingResolver`/`WitnessVerifier` (implemented
// by `trust-resolve`). The `dsseVerifier` port mirrors `policy.ts`'s
// `DsseChainVerifier` (T7) rather than a new shape -- the T7 finding this
// module inherits from noted that real DSSE-signature verification is
// multicodec-aware (did:key can encode more than one curve) and deferred
// that to an injected port rather than duplicating ahead of a design
// decision on which curves `trust-core` decodes natively. This is a
// deviation from the plan's literal `verifyEnvelopeBinding(..., {
// bindingResolver, witnessVerifier, policy })` deps-bag listing (no
// `dsseVerifier` shown there) -- recorded as a finding, not silently
// patched: without it, step 1 ("verify the DSSE envelope offline against
// K") and the §7.4a/§7.4b signature checks below have no way to check a
// signature at all.
// ---------------------------------------------------------------------------

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function voucherIdentityEquals(a: VoucherIdentity, b: VoucherIdentity): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "account":
      return b.kind === "account" && a.did === b.did;
    case "agentId":
      return b.kind === "agentId" && a.caip19 === b.caip19;
    case "oidc-machine":
      return b.kind === "oidc-machine" && a.subject === b.subject;
    case "github-human":
      return b.kind === "github-human" && a.profile === b.profile && a.id === b.id;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// verifyEnvelopeBinding (§7.5 steps 1, 2, 3, 4, 5).
// ---------------------------------------------------------------------------

export interface VerifyEnvelopeBindingInput {
  readonly envelopeBytes: Uint8Array;
  /** did:key claiming to have signed `envelopeBytes`. */
  readonly key: string;
  /** the Agent IRI the envelope claims to be signed on behalf of. */
  readonly agent: string;
  /** the record family this envelope belongs to -- must be in the
   * resolved binding's `scope` (step 4). */
  readonly family: string;
  /** the evidence's effective time -- binding resolution and the window
   * check both apply at this time. */
  readonly atTime: string;
}

/** §9's policy-purpose check applied at step 5, pre-scoped by the caller
 * to whichever purpose applies to this call site (`verifyEnvelopeBinding`
 * does not itself know which of the 9 registered purposes is in play). */
export interface PolicyCheckInput {
  readonly accepted: readonly string[];
  readonly requiredStrength: Strength;
}

export interface VerifyEnvelopeBindingDeps {
  readonly bindingResolver: BindingResolver;
  readonly witnessVerifier: WitnessVerifier;
  readonly dsseVerifier: DsseChainVerifier;
  readonly policy?: PolicyCheckInput;
  /**
   * Defaults to `true` when `policy` is supplied. Set `false` so a caller
   * that is *itself* verifying a trust-policy document's genesis signers
   * (§9) can run steps 1-4 without step 5 ever recursing into policy
   * resolution on its own signers.
   */
  readonly applyPolicy?: boolean;
}

export type VerificationFailureReason =
  | "envelope-signature-invalid"
  | "binding-not-resolved"
  | "ceremony-verification-failed"
  | "window-violation"
  | "scope-violation"
  | "consent-chain-violation"
  | "revoked"
  | "policy-rejected";

export interface VerificationOutcome {
  readonly ok: boolean;
  readonly resolvedBinding?: ResolvedBinding;
  readonly reason?: VerificationFailureReason;
  readonly detail?: string;
}

async function verifyCeremonyLeg(
  resolved: ResolvedBinding,
  witnessVerifier: WitnessVerifier,
): Promise<{ verified: boolean; reason?: string }> {
  const ceremonyType = resolved.binding.ceremony.type;

  if (ceremonyType === "eoa") {
    if (resolved.ceremonyEvidence === undefined) {
      return { verified: false, reason: "resolved binding is missing its EOA ceremony evidence." };
    }
    // §7.1's digest-referenced ceremony evidence: the record's own
    // `ceremony.digest` commits to a specific evidence blob. Without this
    // check the resolver-supplied `ceremonyEvidence` is never tied to that
    // commitment -- any evidence that independently recovers and content-
    // matches would verify, regardless of what the signed record actually
    // committed to (major finding: the digest is otherwise decorative).
    const committedDigest = resolved.binding.ceremony.digest;
    const suppliedDigest = ceremonyEvidenceDigest(resolved.ceremonyEvidence);
    if (suppliedDigest !== committedDigest) {
      return {
        verified: false,
        reason: `ceremony evidence digest "${suppliedDigest}" does not match the binding's `
          + `committed ceremony.digest "${committedDigest}".`,
      };
    }
    const result = verifyEoaCeremony(resolved.ceremonyEvidence, resolved.binding);
    return { verified: result.verified, ...(result.reason === undefined ? {} : { reason: result.reason }) };
  }

  if (ceremonyType === "safe") {
    if (resolved.witness === undefined) {
      return { verified: false, reason: "resolved binding is missing its 1271 witness." };
    }
    const result = await witnessVerifier.verify1271Witness(resolved.witness);
    return { verified: result.verified, ...(result.reason === undefined ? {} : { reason: result.reason }) };
  }

  // agentId / oidc-machine / github-human: the resolver already performed
  // this ceremony's authenticity check as part of resolution (the agentId
  // composition leg and anchored-JWKS leg are `resolve`'s job, per §7.2
  // and T13's `createBindingResolver`) -- a non-null `ResolvedBinding`
  // already carries that guarantee for these ceremony types.
  return { verified: true };
}

async function checkConsentChain(
  resolved: ResolvedBinding,
  atTime: string,
  deps: { readonly bindingResolver: BindingResolver; readonly dsseVerifier: DsseChainVerifier },
): Promise<{ ok: boolean; detail?: string }> {
  if (resolved.isGenesis) return { ok: true };

  const { binding } = resolved;

  if (
    resolved.incumbentControlVoucher !== undefined
    && voucherIdentityEquals(resolved.incumbentControlVoucher, binding.voucher)
  ) {
    return { ok: true }; // self-extension (§7.4a option 1)
  }

  if (binding.consent !== undefined) {
    // The consent countersignature's target bytes are not specified by the
    // design (§7.4a names the rule, not the wire format). This
    // implementation defines them as the DSSE PAE of the binding's own
    // canonical payload with the `consent` field itself omitted (avoiding
    // the self-reference a signature-over-itself would create) -- a
    // documented convention, flagged as a finding for design ratification.
    const { consent: _consent, ...bindingWithoutConsent } = binding;
    const consentTargetPayload = canonicalJsonBytes(bindingWithoutConsent);
    const syntheticEnvelope = sealDsseEnvelope({
      payloadBytes: consentTargetPayload,
      payloadType: TRUST_KEY_BINDING_MEDIA_TYPE,
      signatures: [{ signature: decodeBase64(binding.consent.sig), keyid: binding.consent.keyid }],
    });
    const { validSignerKeyids } = deps.dsseVerifier(syntheticEnvelope);
    if (!validSignerKeyids.includes(binding.consent.keyid)) {
      return { ok: false, detail: "consent countersignature does not validate against its declared keyid." };
    }
    const consentingBinding = await deps.bindingResolver.resolveBinding(
      { key: binding.consent.keyid, agent: binding.agent },
      atTime,
    );
    if (consentingBinding === null || !consentingBinding.binding.scope.includes("bindings")) {
      return {
        ok: false,
        detail: `consent keyid "${binding.consent.keyid}" does not currently hold a scope:bindings `
          + `binding to "${binding.agent}".`,
      };
    }
    return { ok: true }; // cross-account consent (§7.4a option 2)
  }

  return {
    ok: false,
    detail: "non-genesis binding carries neither an incumbent controls voucher nor a "
      + "bindings-scoped consent countersignature (§7.4a).",
  };
}

async function isRevocationAuthorized(
  resolved: ResolvedBinding,
  entry: ResolvedRevocation,
  deps: { readonly bindingResolver: BindingResolver; readonly dsseVerifier: DsseChainVerifier },
): Promise<boolean> {
  const { validSignerKeyids } = deps.dsseVerifier(entry.envelopeBytes);
  if (!validSignerKeyids.includes(entry.revocation.revokedBy)) return false;

  const revokedBy = entry.revocation.revokedBy;
  if (revokedBy.startsWith("did:pkh:")) {
    // The binding's voucher account, via a fresh ceremony (§7.4b).
    return resolved.binding.voucher.kind === "account" && resolved.binding.voucher.did === revokedBy;
  }
  // A currently-valid working key of the same Agent with scope: bindings.
  const revokerBinding = await deps.bindingResolver.resolveBinding(
    { key: revokedBy, agent: resolved.binding.agent },
    entry.effectiveTime,
  );
  return revokerBinding !== null && revokerBinding.binding.scope.includes("bindings");
}

async function checkRevocation(
  resolved: ResolvedBinding,
  atTime: string,
  deps: { readonly bindingResolver: BindingResolver; readonly dsseVerifier: DsseChainVerifier },
): Promise<{ ok: boolean; detail?: string }> {
  for (const entry of resolved.revocations) {
    // §7.4b: never retroactive -- a revocation anchored after the
    // evidence's effective time attributes nothing before it.
    const comparison = compareCalendarStrictRfc3339Instants(entry.effectiveTime, atTime);
    if (comparison === undefined) {
      return { ok: false, detail: "revocation effectiveTime is not a calendar-valid RFC 3339 authority time." };
    }
    if (comparison > 0) continue;
    // eslint-disable-next-line no-await-in-loop -- revocations lists are small; sequential is fine.
    if (await isRevocationAuthorized(resolved, entry, deps)) {
      return {
        ok: false,
        detail: `revoked effective "${entry.effectiveTime}" by "${entry.revocation.revokedBy}".`,
      };
    }
  }
  return { ok: true };
}

function strengthSatisfies(actual: Strength, required: Strength): boolean {
  if (required === "weak") return true;
  return actual === "strong";
}

function checkPolicy(
  resolved: ResolvedBinding,
  policy: PolicyCheckInput,
): { ok: boolean; detail?: string } {
  if (!policy.accepted.includes(resolved.binding.agent)) {
    return { ok: false, detail: `Agent IRI "${resolved.binding.agent}" is not policy-accepted.` };
  }
  if (!strengthSatisfies(resolved.binding.strength, policy.requiredStrength)) {
    return {
      ok: false,
      detail: `binding strength "${resolved.binding.strength}" does not satisfy required `
        + `"${policy.requiredStrength}".`,
    };
  }
  return { ok: true };
}

/**
 * The §7.5 normative verification procedure. Steps 1, 4, and 5 execute
 * here; steps 2 (resolve) and 3 (ceremony/witness facts) delegate to the
 * injected `bindingResolver`/`witnessVerifier`. Passing `{ applyPolicy:
 * false }` runs steps 1-4 only -- policy-chain verification (§9) never
 * recurses into step 5 on its own signers.
 */
export async function verifyEnvelopeBinding(
  input: VerifyEnvelopeBindingInput,
  deps: VerifyEnvelopeBindingDeps,
): Promise<VerificationOutcome> {
  if (!isCalendarStrictRfc3339(input.atTime)) {
    return { ok: false, reason: "window-violation", detail: "atTime is not a calendar-valid RFC 3339 authority time." };
  }
  // Step 1: verify the DSSE envelope offline against K.
  const { validSignerKeyids } = deps.dsseVerifier(input.envelopeBytes);
  if (!validSignerKeyids.includes(input.key)) {
    return {
      ok: false,
      reason: "envelope-signature-invalid",
      detail: `no valid signature by claimed key "${input.key}" on the envelope.`,
    };
  }

  // Step 2: resolve the binding for the pair (K, A) at the evidence's
  // effective time.
  const resolved = await deps.bindingResolver.resolveBinding(
    { key: input.key, agent: input.agent },
    input.atTime,
  );
  if (resolved === null) {
    return { ok: false, reason: "binding-not-resolved" };
  }

  // Step 3: verify the ceremony evidence, including the mandatory content
  // match (§7.2).
  const ceremony = await verifyCeremonyLeg(resolved, deps.witnessVerifier);
  if (!ceremony.verified) {
    return {
      ok: false,
      resolvedBinding: resolved,
      reason: "ceremony-verification-failed",
      ...(ceremony.reason === undefined ? {} : { detail: ceremony.reason }),
    };
  }

  // Step 4: validity window, scope, consent chain, absence of anchored
  // revocation.
  const startComparison = compareCalendarStrictRfc3339Instants(input.atTime, resolved.effectiveStart);
  if (startComparison === undefined) {
    return { ok: false, resolvedBinding: resolved, reason: "window-violation", detail: "binding effectiveStart is not a calendar-valid RFC 3339 authority time." };
  }
  if (startComparison < 0) {
    return {
      ok: false,
      resolvedBinding: resolved,
      reason: "window-violation",
      detail: `atTime "${input.atTime}" precedes the binding's effective start "${resolved.effectiveStart}".`,
    };
  }
  const expiryComparison = resolved.binding.expiresAt === undefined
    ? undefined
    : compareCalendarStrictRfc3339Instants(input.atTime, resolved.binding.expiresAt);
  if (resolved.binding.expiresAt !== undefined && expiryComparison === undefined) {
    return { ok: false, resolvedBinding: resolved, reason: "window-violation", detail: "binding expiresAt is not a calendar-valid RFC 3339 authority time." };
  }
  if (expiryComparison !== undefined && expiryComparison > 0) {
    return {
      ok: false,
      resolvedBinding: resolved,
      reason: "window-violation",
      detail: `atTime "${input.atTime}" is after the binding's expiresAt "${resolved.binding.expiresAt}".`,
    };
  }
  if (!resolved.binding.scope.includes(input.family)) {
    return {
      ok: false,
      resolvedBinding: resolved,
      reason: "scope-violation",
      detail: `binding scope [${resolved.binding.scope.join(", ")}] does not cover family "${input.family}".`,
    };
  }
  const consentResult = await checkConsentChain(resolved, input.atTime, deps);
  if (!consentResult.ok) {
    return {
      ok: false,
      resolvedBinding: resolved,
      reason: "consent-chain-violation",
      ...(consentResult.detail === undefined ? {} : { detail: consentResult.detail }),
    };
  }
  const revocationResult = await checkRevocation(resolved, input.atTime, deps);
  if (!revocationResult.ok) {
    return {
      ok: false,
      resolvedBinding: resolved,
      reason: "revoked",
      ...(revocationResult.detail === undefined ? {} : { detail: revocationResult.detail }),
    };
  }

  // Step 5: apply the deployment's trust policy to the vouching identity.
  if (deps.applyPolicy !== false && deps.policy !== undefined) {
    const policyResult = checkPolicy(resolved, deps.policy);
    if (!policyResult.ok) {
      return {
        ok: false,
        resolvedBinding: resolved,
        reason: "policy-rejected",
        ...(policyResult.detail === undefined ? {} : { detail: policyResult.detail }),
      };
    }
  }

  return { ok: true, resolvedBinding: resolved };
}

// ---------------------------------------------------------------------------
// settlementJoinCheck (§7.5a, R13).
// ---------------------------------------------------------------------------

export interface SettlementJoinInput {
  /** did:key that signed the verdict envelope. */
  readonly verdictKey: string;
  /**
   * did:key identifying the settling Safe's own binding declaration to the
   * claimed evaluator IRI. The design names the *concept* (join the
   * verdict's DSSE key to the on-chain settling actor) but not the
   * concrete on-chain declaration/lookup mechanism -- that mechanism is
   * out of scope here (program doc §9: the marketplace binding is a
   * pending design session). This procedure therefore takes the
   * settlement leg's resolvable key directly rather than deriving it from
   * a Safe address, which the frozen `BindingResolver` interface (keyed by
   * (did:key, agent), not by voucher) cannot do on its own. Flagged as a
   * finding.
   */
  readonly settlementDeclarationKey: string;
  readonly claimedEvaluatorAgent: string;
  readonly family: string;
  readonly envelopeEffectiveTime: string;
  readonly claimTime: string;
}

export interface SettlementJoinOutcome {
  readonly ok: boolean;
  readonly agent?: string;
  readonly reason?: string;
}

/**
 * §7.5a: joins a verdict's DSSE key to a settling on-chain actor. Both
 * legs must resolve to the same Agent IRI at the envelope's effective
 * time, with the verdict leg's scope covering `family` and its
 * relationship in `{controls, signs-for}`; the settlement leg must also
 * stand (not revoked) at the later claim time. Divergent times or a
 * missing leg fail the join -- no partial credit.
 */
export async function settlementJoinCheck(
  input: SettlementJoinInput,
  deps: { readonly bindingResolver: BindingResolver },
): Promise<SettlementJoinOutcome> {
  const verdictLeg = await deps.bindingResolver.resolveBinding(
    { key: input.verdictKey, agent: input.claimedEvaluatorAgent },
    input.envelopeEffectiveTime,
  );
  if (verdictLeg === null) {
    return { ok: false, reason: "verdict leg does not resolve to the claimed evaluator IRI." };
  }
  if (!verdictLeg.binding.scope.includes(input.family)) {
    return {
      ok: false,
      reason: `verdict leg's scope [${verdictLeg.binding.scope.join(", ")}] does not cover family "${input.family}".`,
    };
  }
  if (verdictLeg.binding.relationship !== "controls" && verdictLeg.binding.relationship !== "signs-for") {
    return {
      ok: false,
      reason: `verdict leg's relationship "${verdictLeg.binding.relationship}" is neither controls nor signs-for.`,
    };
  }

  const settlementLegAtEnvelopeTime = await deps.bindingResolver.resolveBinding(
    { key: input.settlementDeclarationKey, agent: input.claimedEvaluatorAgent },
    input.envelopeEffectiveTime,
  );
  if (settlementLegAtEnvelopeTime === null) {
    return { ok: false, reason: "settlement leg does not resolve to the claimed evaluator IRI." };
  }

  // "not revoked at claim time" -- a distinct, later check from the
  // envelope-time resolution above (divergent-times protection).
  const settlementLegAtClaimTime = await deps.bindingResolver.resolveBinding(
    { key: input.settlementDeclarationKey, agent: input.claimedEvaluatorAgent },
    input.claimTime,
  );
  if (settlementLegAtClaimTime === null) {
    return { ok: false, reason: "settlement leg is not valid (revoked or expired) at claim time." };
  }

  return { ok: true, agent: input.claimedEvaluatorAgent };
}

// ---------------------------------------------------------------------------
// authenticateRequester (§7.5b, R5/R14).
// ---------------------------------------------------------------------------

export interface SubmissionAuthenticationInput {
  readonly envelopeBytes: Uint8Array;
  /** did:key that signed the Submission envelope. */
  readonly key: string;
  /** the claimed requester Agent IRI. */
  readonly requesterAgent: string;
  /** the Submission's sealing time -- resolution and policy both apply at
   * this time. */
  readonly sealingTime: string;
}

export interface RequesterAuthenticationOutcome {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * §7.5b: authenticates a signed Submission's `requester` IRI by the same
 * procedure as `verifyEnvelopeBinding` -- verify the envelope against its
 * key, resolve (key, requester IRI) at the Submission's sealing time with
 * `scope: authorizations` or `relationship: signs-for`, then apply policy.
 */
export async function authenticateRequester(
  input: SubmissionAuthenticationInput,
  deps: {
    readonly bindingResolver: BindingResolver;
    readonly dsseVerifier: DsseChainVerifier;
    readonly policy?: PolicyCheckInput;
  },
): Promise<RequesterAuthenticationOutcome> {
  const { validSignerKeyids } = deps.dsseVerifier(input.envelopeBytes);
  if (!validSignerKeyids.includes(input.key)) {
    return { ok: false, reason: "no valid signature from the claimed key on the Submission envelope." };
  }

  const resolved = await deps.bindingResolver.resolveBinding(
    { key: input.key, agent: input.requesterAgent },
    input.sealingTime,
  );
  if (resolved === null) {
    return { ok: false, reason: "the signing key does not resolve to the claimed requester Agent IRI." };
  }

  const authorized = resolved.binding.scope.includes("authorizations")
    || resolved.binding.relationship === "signs-for";
  if (!authorized) {
    return {
      ok: false,
      reason: "binding neither carries scope:authorizations nor relationship:signs-for.",
    };
  }

  const revocationResult = await checkRevocation(
    resolved,
    input.sealingTime,
    deps,
  );
  if (!revocationResult.ok) {
    return {
      ok: false,
      reason: revocationResult.detail ?? "requester binding is revoked.",
    };
  }

  if (deps.policy !== undefined) {
    const policyResult = checkPolicy(resolved, deps.policy);
    if (!policyResult.ok) {
      return { ok: false, ...(policyResult.detail === undefined ? {} : { reason: policyResult.detail }) };
    }
  }

  return { ok: true };
}
