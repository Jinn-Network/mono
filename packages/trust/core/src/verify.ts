// SPDX-License-Identifier: Apache-2.0

import { ceremonyEvidenceDigest, verifyEoaCeremony } from "./ceremony.js";
import { canonicalJsonBytes } from "./canonical-json.js";
import { dssePreAuthEncoding, sealDsseEnvelope } from "./dsse.js";
import { recordDigest } from "./hashing.js";
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

function describeVoucherIdentity(v: VoucherIdentity): string {
  switch (v.kind) {
    case "account":
      return `account ${v.did}`;
    case "agentId":
      return `agentId ${v.caip19}`;
    case "oidc-machine":
      return `oidc-machine ${v.subject}`;
    case "github-human":
      return `github-human ${v.profile} (id ${v.id})`;
    default:
      return "unknown voucher identity";
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
  /** A `signs-for` relationship is a narrow, explicit substitute for an
   * authorizations scope when authenticating requester envelopes. */
  readonly allowSignsForAuthorization?: boolean;
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
  /**
   * Whatever step 2 resolved, attached on failure as well as success — including the
   * `binding-not-resolved` failure for a resolver that echoed a binding for a different Agent
   * IRI. Never infer success from its presence; `ok` is the only success signal.
   */
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

  // agentId / oidc-machine / github-human: §7.5 step 3's leg for these needs
  // I/O, so it is the resolver's job (§17), and a non-null `ResolvedBinding`
  // is the resolver's statement that it ran. `createBindingResolver` keeps
  // that promise by not resolving a binding whose ceremony nothing verified.
  return { verified: true };
}

/**
 * `BindingResolver.resolveBinding` narrowed to the agent it was asked for.
 * The interface is contracted never to resolve by key alone (interfaces.ts),
 * so this is redundant against a conforming resolver -- but a key-only
 * resolver cache is a realistic bug, and every guard downstream of a
 * resolution reasons about scope and relationship only, so a foreign
 * binding would otherwise stand in for the claimed agent's. Narrowing at
 * the call rather than after it also fixes placement: the pair check
 * necessarily precedes each site's scope guard, so a foreign binding is
 * refused as unresolved rather than reported as some later leg's failure
 * (issue #3572).
 *
 * `verifyEnvelopeBinding`'s step 2 asserts the same pair inline instead,
 * where it can name the mismatch in its own `detail` and still return the
 * offending `resolvedBinding` (issue #3385). `settlementJoinCheck`'s
 * claim-time settlement leg does the same, so that a leg which drifted to
 * another agent is not reported as a revocation (issue #3630).
 *
 * Exported for the direct `resolveBinding` consumers outside this package,
 * which have the same shape and the same exposure (issue #3629).
 */
export async function resolveBindingForAgent(
  resolver: BindingResolver,
  query: { readonly key: string; readonly agent: string },
  atTime: string,
): Promise<ResolvedBinding | null> {
  const resolved = await resolver.resolveBinding(query, atTime);
  if (resolved === null || resolved.binding.agent !== query.agent) return null;
  return resolved;
}

// ---------------------------------------------------------------------------
// §7.4a/§7.4b authority: a binding that gives authority (an incumbent, a
// consenter, a revoker) must itself stand. Resolving is not enough -- a
// resolved binding is data (`interfaces.ts`) and a store may hold anything.
// ---------------------------------------------------------------------------

type AuthorityDeps = Pick<VerifyEnvelopeBindingDeps, "bindingResolver" | "witnessVerifier" | "dsseVerifier">;

/** Which revocations end a binding's use as an authority. Every one that is
 * authorized, except for the founding account's own incumbency: see `readChain`. */
type RevocationsThatCount = "all" | "voucher-signed";

/** One verification's walk. `settled` holds each fact the walk has decided,
 * because a store full of peers would otherwise be re-walked along every path
 * through it. Every fact is decided at a fixed instant -- a binding's own
 * effective start, a revocation's own effective time -- so the answer does
 * not depend on which path asked. */
interface AuthorityWalk extends AuthorityDeps {
  readonly settled: Map<string, boolean>;
}

async function settle(walk: AuthorityWalk, fact: string, decide: () => Promise<boolean>): Promise<boolean> {
  const known = walk.settled.get(fact);
  if (known !== undefined) return known;
  const decided = await decide();
  walk.settled.set(fact, decided);
  return decided;
}

function withinWindow(resolved: ResolvedBinding, atTime: string): boolean {
  const start = compareCalendarStrictRfc3339Instants(atTime, resolved.effectiveStart);
  if (start === undefined || start < 0) return false;
  if (resolved.binding.expiresAt === undefined) return true;
  const end = compareCalendarStrictRfc3339Instants(atTime, resolved.binding.expiresAt);
  return end !== undefined && end <= 0;
}

/**
 * All of what it takes to give authority at an instant except the consent
 * chain: in window, record signed by the key it binds (§7.1), ceremony
 * verified, and no authorized revocation effective strictly before that
 * instant. Step 5 is not applied: authority is a §7.4 question, and a
 * verifier's trust policy says nothing about who an Agent's keys are.
 *
 * Revocations count strictly before the instant because an act is judged by
 * the state it was taken in. So a successor can revoke the binding it descends
 * from, and two keys revoking each other at one instant both take effect. It
 * also keeps the walk finite: a revocation's signer is always judged at a
 * strictly earlier instant than the binding it revokes was being judged at.
 */
async function authorityUsable(
  resolved: ResolvedBinding,
  atTime: string,
  walk: AuthorityWalk,
  revocationsThatCount: RevocationsThatCount = "all",
): Promise<boolean> {
  if (!withinWindow(resolved, atTime)) return false;
  const sound = await settle(walk, `record\u001f${resolved.bindingDigest}`, async () => {
    const { validSignerKeyids } = walk.dsseVerifier(resolved.envelopeBytes);
    if (!validSignerKeyids.includes(resolved.binding.key.didKey)) return false;
    return (await verifyCeremonyLeg(resolved, walk.witnessVerifier)).verified;
  });
  return sound && (await checkRevocation(resolved, atTime, "before", walk, revocationsThatCount)).ok;
}

/** Whether a binding stands at the instant it gives authority. */
async function bindingStands(
  resolved: ResolvedBinding,
  atTime: string,
  walk: AuthorityWalk,
  revocationsThatCount: RevocationsThatCount = "all",
): Promise<boolean> {
  return await authorityUsable(resolved, atTime, walk, revocationsThatCount) && chainHolds(resolved, walk);
}

/** What one binding's record offers §7.4a, before the batch it was sealed in
 * is settled. */
interface ChainReading {
  /** Genesis, or an authority from a strictly earlier instant stands. */
  readonly rooted: boolean;
  /** Usable authorities that took effect at this binding's own instant:
   * they stand or fall with it. */
  readonly peers: readonly ResolvedBinding[];
  /** Why the chain fails if nothing roots it. */
  readonly detail?: string;
}

async function readChain(resolved: ResolvedBinding, walk: AuthorityWalk): Promise<ChainReading> {
  if (resolved.isGenesis) return { rooted: true, peers: [] };

  const { binding } = resolved;
  // Authority is judged when it was exercised, and §7.3's effective start is
  // when this binding really entered the world: `validFrom` alone is the
  // minter's claim. Later expiry or revocation of the authority takes nothing
  // back (§7.4b), and a back-dated `validFrom` reaches nothing earlier.
  const mintTime = resolved.effectiveStart;
  const peers: ResolvedBinding[] = [];
  /** True when `authority` roots this binding. One from its own instant is
   * noted as a peer instead: only its batch as a whole can say if it stands. */
  const roots = async (authority: ResolvedBinding, revocationsThatCount: RevocationsThatCount = "all"): Promise<boolean> => {
    if (authority.bindingDigest === resolved.bindingDigest) return false;
    const order = compareCalendarStrictRfc3339Instants(authority.effectiveStart, mintTime);
    if (order === undefined || order > 0) return false;
    if (order < 0) return bindingStands(authority, mintTime, walk, revocationsThatCount);
    if (await authorityUsable(authority, mintTime, walk, revocationsThatCount)) peers.push(authority);
    return false;
  };

  const incumbents = resolved.incumbentControls ?? [];
  for (const incumbent of incumbents) {
    if (!voucherIdentityEquals(incumbent.voucher, binding.voucher)) continue;
    // eslint-disable-next-line no-await-in-loop -- sequential: the first that stands settles it.
    const authority = await resolveBindingForAgent(
      walk.bindingResolver,
      { key: incumbent.key, agent: binding.agent },
      mintTime,
    );
    // What the store listed is a candidate; what resolves for that key is the
    // binding that holds it, so that is the record every check here applies to.
    if (authority === null
      || authority.binding.relationship !== "controls"
      || !voucherIdentityEquals(authority.binding.voucher, binding.voucher)) {
      continue;
    }
    // §7.4a: "the account is the incumbent authority", and §7.4b keeps what a
    // bindings key revokes recoverable through that account. So a working key
    // can retire the founding binding but not the founding account: only the
    // account's own revocation ends that binding's self-extension authority.
    // Every other account stays removable, by any authorized revocation.
    const counting: RevocationsThatCount = authority.isGenesis ? "voucher-signed" : "all";
    // eslint-disable-next-line no-await-in-loop -- sequential: the first that stands settles it.
    if (await roots(authority, counting)) return { rooted: true, peers: [] }; // self-extension (§7.4a option 1)
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
    const { validSignerKeyids } = walk.dsseVerifier(syntheticEnvelope);
    if (!validSignerKeyids.includes(binding.consent.keyid)) {
      return { rooted: false, peers, detail: "consent countersignature does not validate against its declared keyid." };
    }
    const consentingBinding = await resolveBindingForAgent(
      walk.bindingResolver,
      { key: binding.consent.keyid, agent: binding.agent },
      mintTime,
    );
    if (consentingBinding === null || !consentingBinding.binding.scope.includes("bindings")) {
      return {
        rooted: false,
        peers,
        detail: `consent keyid "${binding.consent.keyid}" did not hold a scope:bindings binding to `
          + `"${binding.agent}" at this binding's effective start "${mintTime}".`,
      };
    }
    if (await roots(consentingBinding)) return { rooted: true, peers: [] }; // cross-account consent (§7.4a option 2)
    return {
      rooted: false,
      peers,
      detail: `consent keyid "${binding.consent.keyid}" holds a binding to "${binding.agent}" that did `
        + `not stand at this binding's effective start "${mintTime}" (§7.4a).`,
    };
  }

  if (incumbents.length === 0) {
    return {
      rooted: false,
      peers,
      detail: "non-genesis binding carries no incumbent controls voucher and no "
        + "bindings-scoped consent countersignature (§7.4a).",
    };
  }
  return {
    rooted: false,
    peers,
    detail: `no incumbent controls binding (${incumbents.map(({ voucher }) => describeVoucherIdentity(voucher)).join(", ")}) `
      + `stands for the binding's own voucher (${describeVoucherIdentity(binding.voucher)}) and it `
      + "carries no bindings-scoped consent countersignature (§7.4a).",
  };
}

/**
 * Whether a chain of authority reaches this binding from the genesis: the
 * least fixed point, not a walk that gives up on a repeat, so a binding stands
 * only on something that does. This is the cycle guard. A binding cannot
 * countersign itself, and a ring of bindings countersigning each other has
 * nothing under it however it is entered.
 *
 * Bindings sealed at one instant may authorize each other in any order, and
 * no digest may decide which, so a batch is settled together: every binding
 * reachable through authority at that same instant is read once, then standing
 * spreads out from the ones rooted at an earlier instant. Everything else the
 * walk asks about lies at a strictly earlier instant, so the fact settled here
 * for each member does not depend on which of them asked.
 */
async function chainHolds(resolved: ResolvedBinding, walk: AuthorityWalk): Promise<boolean> {
  const fact = (binding: ResolvedBinding): string => `chain\u001f${binding.bindingDigest}`;
  const known = walk.settled.get(fact(resolved));
  if (known !== undefined) return known;

  const batch = new Map<ResolvedBinding["bindingDigest"], ChainReading>();
  const unread = [resolved];
  for (let next = unread.pop(); next !== undefined; next = unread.pop()) {
    if (batch.has(next.bindingDigest)) continue;
    const settled = walk.settled.get(fact(next));
    // eslint-disable-next-line no-await-in-loop -- batches are small; sequential is fine.
    const reading = settled === undefined ? await readChain(next, walk) : { rooted: settled, peers: [] };
    batch.set(next.bindingDigest, reading);
    unread.push(...reading.peers);
  }

  const standing = new Set([...batch].filter(([, { rooted }]) => rooted).map(([digest]) => digest));
  for (let spread = true; spread;) {
    spread = false;
    for (const [digest, { peers }] of batch) {
      if (standing.has(digest) || !peers.some(({ bindingDigest }) => standing.has(bindingDigest))) continue;
      standing.add(digest);
      spread = true;
    }
  }
  for (const digest of batch.keys()) walk.settled.set(`chain\u001f${digest}`, standing.has(digest));
  return standing.has(resolved.bindingDigest);
}

async function checkConsentChain(
  resolved: ResolvedBinding,
  walk: AuthorityWalk,
): Promise<{ ok: boolean; detail?: string }> {
  if (await chainHolds(resolved, walk)) return { ok: true };
  const { detail } = await readChain(resolved, walk);
  return { ok: false, ...(detail === undefined ? {} : { detail }) };
}

async function isRevocationAuthorized(
  resolved: ResolvedBinding,
  entry: ResolvedRevocation,
  walk: AuthorityWalk,
): Promise<boolean> {
  const { validSignerKeyids } = walk.dsseVerifier(entry.envelopeBytes);
  if (!validSignerKeyids.includes(entry.revocation.revokedBy)) return false;

  const revokedBy = entry.revocation.revokedBy;
  if (revokedBy.startsWith("did:pkh:")) {
    // The binding's voucher account, via a fresh ceremony (§7.4b).
    return resolved.binding.voucher.kind === "account" && resolved.binding.voucher.did === revokedBy;
  }
  // A currently-valid working key of the same Agent with scope: bindings.
  // Valid means it stands, not that a record for it resolves: otherwise any
  // bindings-scoped record for this Agent could revoke its genesis.
  const revokerBinding = await resolveBindingForAgent(
    walk.bindingResolver,
    { key: revokedBy, agent: resolved.binding.agent },
    entry.effectiveTime,
  );
  if (revokerBinding === null || !revokerBinding.binding.scope.includes("bindings")) return false;
  // A key giving up its own binding gives no authority to anyone, so there is
  // nothing for it to stand on: the signature above is all this act needs, and
  // refusing it would keep alive a binding its own holder has retired.
  if (revokerBinding.bindingDigest === resolved.bindingDigest) return true;
  return bindingStands(revokerBinding, entry.effectiveTime, walk);
}

/** `"at"` is step 4's check on the evidence: a revocation effective at or
 * before `atTime` applies. `"before"` is `bindingStands`'s, which excludes the
 * instant itself. */
async function checkRevocation(
  resolved: ResolvedBinding,
  atTime: string,
  boundary: "at" | "before",
  walk: AuthorityWalk,
  revocationsThatCount: RevocationsThatCount = "all",
): Promise<{ ok: boolean; detail?: string }> {
  for (const entry of resolved.revocations) {
    if (revocationsThatCount === "voucher-signed" && !entry.revocation.revokedBy.startsWith("did:pkh:")) continue;
    // §7.4b: never retroactive -- a revocation anchored after the
    // evidence's effective time attributes nothing before it.
    const comparison = compareCalendarStrictRfc3339Instants(entry.effectiveTime, atTime);
    if (comparison !== undefined && (comparison > 0 || (comparison === 0 && boundary === "before"))) continue;
    const fact = `revocation\u001f${resolved.bindingDigest}\u001f${recordDigest(entry.envelopeBytes)}`;
    // eslint-disable-next-line no-await-in-loop -- revocations lists are small; sequential is fine.
    if (!(await settle(walk, fact, () => isRevocationAuthorized(resolved, entry, walk)))) continue;
    // Authority comes first: a time nobody can read refuses only when someone
    // with standing wrote it, or any record naming this binding would revoke it.
    return {
      ok: false,
      detail: comparison === undefined
        ? "revocation effectiveTime is not a calendar-valid RFC 3339 authority time."
        : `revoked effective "${entry.effectiveTime}" by "${entry.revocation.revokedBy}".`,
    };
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
  // `BindingResolver` is contracted never to resolve by key alone (interfaces.ts),
  // so this holds for every conforming resolver -- but a key-only resolver cache is
  // a realistic bug, and an echoed agent would let a forged envelope pass as the
  // victim's. Asserted here so no call site has to remember to.
  if (resolved.binding.agent !== input.agent) {
    return {
      ok: false,
      resolvedBinding: resolved,
      reason: "binding-not-resolved",
      detail: `the resolver returned a binding for Agent IRI "${resolved.binding.agent}", `
        + `not the claimed "${input.agent}".`,
    };
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
  if (!resolved.binding.scope.includes(input.family)
    && !(input.allowSignsForAuthorization === true
      && input.family === "authorizations"
      && resolved.binding.relationship === "signs-for")) {
    return {
      ok: false,
      resolvedBinding: resolved,
      reason: "scope-violation",
      detail: `binding scope [${resolved.binding.scope.join(", ")}] does not cover family "${input.family}".`,
    };
  }
  const walk: AuthorityWalk = {
    bindingResolver: deps.bindingResolver,
    witnessVerifier: deps.witnessVerifier,
    dsseVerifier: deps.dsseVerifier,
    settled: new Map(),
  };
  const consentResult = await checkConsentChain(resolved, walk);
  if (!consentResult.ok) {
    return {
      ok: false,
      resolvedBinding: resolved,
      reason: "consent-chain-violation",
      ...(consentResult.detail === undefined ? {} : { detail: consentResult.detail }),
    };
  }
  const revocationResult = await checkRevocation(resolved, input.atTime, "at", walk);
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
  const verdictLeg = await resolveBindingForAgent(
    deps.bindingResolver,
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

  const settlementLegAtEnvelopeTime = await resolveBindingForAgent(
    deps.bindingResolver,
    { key: input.settlementDeclarationKey, agent: input.claimedEvaluatorAgent },
    input.envelopeEffectiveTime,
  );
  if (settlementLegAtEnvelopeTime === null) {
    return { ok: false, reason: "settlement leg does not resolve to the claimed evaluator IRI." };
  }
  if (!settlementLegAtEnvelopeTime.binding.scope.includes("settlements")) {
    return { ok: false, reason: "settlement leg does not carry scope:settlements." };
  }

  // "not revoked at claim time" -- a distinct, later check from the
  // envelope-time resolution above (divergent-times protection).
  // Resolved through the plain resolver rather than `resolveBindingForAgent`
  // so the two ways this leg can fail to stand for the claimed agent report
  // distinctly: a genuine miss (revoked or expired) and a resolution that
  // drifted to a different Agent IRI. The inline assertion mirrors
  // `verifyEnvelopeBinding` step 2.
  const settlementLegAtClaimTime = await deps.bindingResolver.resolveBinding(
    { key: input.settlementDeclarationKey, agent: input.claimedEvaluatorAgent },
    input.claimTime,
  );
  if (settlementLegAtClaimTime === null) {
    return { ok: false, reason: "settlement leg is not valid (revoked or expired) at claim time." };
  }
  if (settlementLegAtClaimTime.binding.agent !== input.claimedEvaluatorAgent) {
    return {
      ok: false,
      reason: `settlement leg resolves to Agent IRI "${settlementLegAtClaimTime.binding.agent}" at claim time, `
        + `not the claimed "${input.claimedEvaluatorAgent}".`,
    };
  }
  if (!settlementLegAtClaimTime.binding.scope.includes("settlements")) {
    return { ok: false, reason: "settlement leg lost scope:settlements at claim time." };
  }

  // The agent this join PROVED, not the one it was handed -- equal by
  // construction now that both legs assert the pair, and the fact the
  // `ok: true` is entitled to carry.
  return { ok: true, agent: verdictLeg.binding.agent };
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
    readonly witnessVerifier: WitnessVerifier;
    readonly dsseVerifier: DsseChainVerifier;
    readonly policy?: PolicyCheckInput;
  },
): Promise<RequesterAuthenticationOutcome> {
  const verified = await verifyEnvelopeBinding({
    envelopeBytes: input.envelopeBytes,
    key: input.key,
    agent: input.requesterAgent,
    family: "authorizations",
    atTime: input.sealingTime,
    allowSignsForAuthorization: true,
  }, deps);
  if (!verified.ok || verified.resolvedBinding === undefined) {
    return {
      ok: false,
      reason: `requester binding ceremony failed: ${verified.reason ?? "unknown"}`
        + `${verified.detail === undefined ? "" : `: ${verified.detail}`}`,
    };
  }
  const resolved = verified.resolvedBinding;

  const authorized = resolved.binding.scope.includes("authorizations")
    || resolved.binding.relationship === "signs-for";
  if (!authorized) {
    return {
      ok: false,
      reason: "binding neither carries scope:authorizations nor relationship:signs-for.",
    };
  }

  return { ok: true };
}
