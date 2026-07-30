// SPDX-License-Identifier: Apache-2.0

import { sha256 } from "@noble/hashes/sha2.js";
import {
  AUTHORIZATION_PREDICATE_TYPE,
  IN_TOTO_STATEMENT_TYPE,
  TRUST_KEY_BINDING_FORMAT,
  TRUST_POLICY_FORMAT,
  TRUST_REVOCATION_FORMAT,
  ceremonyEvidenceDigest,
  deriveStrength,
  didPkh,
  sealAuthorization,
  sealKeyBinding,
  sealRevocation,
  sealTrustPolicy,
  serializeCeremonyMessage,
} from "@jinn-network/trust-core";
import type {
  AuthorizationStatement,
  CeremonyType,
  DsseSigner,
  Eip1271Witness,
  EoaCeremonyEvidence,
  KeyBinding,
  PolicyPurposeEntry,
  Relationship,
  ResolvedBinding,
  ResolvedRevocation,
  Revocation,
  Scope,
  Sha256Digest,
  SiweCeremonyMessage,
  Strength,
  TrustPolicy,
  VoucherIdentity,
} from "@jinn-network/trust-core";

import { createEoaTestSigner } from "./crypto.js";
import type { EoaTestSigner } from "./crypto.js";

export { createEoaTestSigner };
export type { EoaTestSigner };

// ---------------------------------------------------------------------------
// Executable fixture builders for the trust-testing kit -- the §16 goldens
// for the conformance battery (T14), the adversarial set (T15), and the
// §13 walkthroughs (T16) are all constructed here rather than hand-synced
// static JSON, so they stay internally consistent (matching digests,
// content-matching ceremonies) by construction. A representative static
// JSON example ships per record family in `fixtures/*-v1/` (see each
// directory's README.md) for the schema-shape-only cases; ceremony,
// resolution, and consent scenarios are inherently cryptographic/temporal
// and are built here.
//
// Every builder uses a "fixture signer" for the record's own DSSE
// envelope signature -- the kit's `dsseVerifier` fake (`fakes.ts`) trusts
// every declared `keyid`, so the envelope signature only needs to declare
// the right key, not carry real cryptographic material (consistent with
// the T7 finding: real DSSE verification is deferred everywhere in this
// tree). The one EXCEPTION is the EOA ceremony leg, which `verify.ts`
// independently, genuinely recovers -- `crypto.ts`'s `EoaTestSigner`
// signs for real there.
// ---------------------------------------------------------------------------

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function pseudoBase58(seed: string, length = 44): string {
  const hash = sha256(new TextEncoder().encode(seed));
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out += BASE58_ALPHABET[hash[index % hash.length]! % BASE58_ALPHABET.length];
  }
  return out;
}

/** A deterministic, format-valid `did:key` for fixtures that never need
 * genuine multicodec key material (every ceremony type except EOA/ReCap,
 * and every working key's envelope-signing identity, since real DSSE
 * verification is faked -- see the module doc above). */
export function testDidKey(seed: string): string {
  return `did:key:z${pseudoBase58(seed)}`;
}

export function testAgentIri(seed: string): string {
  return `https://jinn.network/agent/fixture-${seed}`;
}

export function testSha256Digest(seed: string): Sha256Digest {
  return `sha256:${sha256(new TextEncoder().encode(seed)).reduce((hex, byte) => hex + byte.toString(16).padStart(2, "0"), "")}`;
}

function fixtureSigner(keyid: string): DsseSigner {
  return async () => [{ signature: Uint8Array.of(1), keyid }];
}

/** A multi-signer fixture (needed only for §9 dual-threshold policy-chain
 * scenarios, where one envelope must carry signatures from more than one
 * declared keyid at once -- `DsseSigner` returns a non-empty array of
 * signatures per call, so a single injected signer can produce all of
 * them). */
function multiFixtureSigner(keyids: readonly string[]): DsseSigner {
  return async () => {
    const [first, ...rest] = keyids;
    return [
      { signature: Uint8Array.of(1), keyid: first! },
      ...rest.map((keyid) => ({ signature: Uint8Array.of(1), keyid })),
    ];
  };
}

// ---------------------------------------------------------------------------
// Key-binding fixtures (§7.1/§7.2).
// ---------------------------------------------------------------------------

export interface EoaCeremonyOptions {
  readonly signer: EoaTestSigner;
  readonly chainId: number;
}

function buildEoaCeremonyEvidence(
  agentIri: string,
  workingKeyDidKey: string,
  options: EoaCeremonyOptions,
): EoaCeremonyEvidence {
  const message: SiweCeremonyMessage = {
    domain: "trust.jinn.network",
    address: options.signer.address,
    uri: "https://trust.jinn.network/ceremony/key-binding",
    version: "1",
    chainId: options.chainId,
    nonce: "fixture-nonce",
    issuedAt: "2026-01-01T00:00:00.000Z",
    // §7.2's mandatory content-match payload for an EOA key-binding
    // ceremony: [Agent IRI, did:key URI].
    resources: [agentIri, workingKeyDidKey],
  };
  // `messageBytes` is the REAL canonical EIP-4361 re-serialization of
  // `message` -- `matchCeremonyContent` (core) now asserts byte-equality
  // between the two before trusting any `message.*` field (blocker
  // finding), so a genuine fixture ceremony must actually sign the bytes
  // its structured `message` re-serializes to, not a JSON stand-in.
  const messageBytes = serializeCeremonyMessage("eoa", message);
  const signature = options.signer.sign(messageBytes);
  return { type: "eoa", message, messageBytes, signature };
}

export interface BuildKeyBindingFixtureOptions {
  readonly agent: string;
  readonly workingKeyDidKey: string;
  readonly ceremonyType: CeremonyType;
  readonly voucher: VoucherIdentity;
  readonly relationship?: Relationship;
  readonly scope?: readonly Scope[];
  readonly validFrom?: string;
  readonly expiresAt?: string;
  readonly consent?: { readonly keyid: string; readonly sig: string };
  readonly supersedes?: Sha256Digest;
  readonly anchorDigest?: Sha256Digest;
  readonly strengthOverride?: Strength;
  /** Required when `ceremonyType === "eoa"`. */
  readonly eoaCeremony?: EoaCeremonyOptions;
}

export interface KeyBindingFixture {
  readonly binding: KeyBinding;
  readonly envelopeBytes: Uint8Array;
  readonly bindingDigest: Sha256Digest;
  readonly ceremonyEvidence?: EoaCeremonyEvidence;
}

const DEFAULT_SCOPE: readonly Scope[] = ["bindings", "verdicts", "deliveries", "observations", "authorizations"];

export async function buildKeyBindingFixture(options: BuildKeyBindingFixtureOptions): Promise<KeyBindingFixture> {
  let ceremonyEvidence: EoaCeremonyEvidence | undefined;
  let ceremonyDigest: Sha256Digest;

  if (options.ceremonyType === "eoa") {
    if (options.eoaCeremony === undefined) {
      throw new Error("buildKeyBindingFixture: eoa ceremonyType requires eoaCeremony options.");
    }
    ceremonyEvidence = buildEoaCeremonyEvidence(options.agent, options.workingKeyDidKey, options.eoaCeremony);
    // §7.1's digest-referenced ceremony evidence: the binding's
    // `ceremony.digest` must commit to the SAME evidence blob `verify.ts`'s
    // ceremony leg is handed (major finding) -- computed the same way
    // `ceremonyEvidenceDigest` computes it in core, over the full evidence.
    ceremonyDigest = ceremonyEvidenceDigest(ceremonyEvidence);
  } else {
    ceremonyDigest = testSha256Digest(`${options.ceremonyType}-ceremony-${options.agent}-${options.workingKeyDidKey}`);
  }

  const binding: KeyBinding = {
    protocol: TRUST_KEY_BINDING_FORMAT,
    agent: options.agent,
    key: {
      publicKey: options.workingKeyDidKey,
      keyid: options.workingKeyDidKey,
      algorithm: "secp256k1",
      didKey: options.workingKeyDidKey,
    },
    voucher: options.voucher,
    relationship: options.relationship ?? "controls",
    scope: [...(options.scope ?? DEFAULT_SCOPE)],
    validFrom: options.validFrom ?? "2026-01-01T00:00:00.000Z",
    ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    ceremony: { type: options.ceremonyType, digest: ceremonyDigest },
    strength: options.strengthOverride ?? deriveStrength(options.ceremonyType),
    ...(options.supersedes === undefined ? {} : { supersedes: options.supersedes }),
    ...(options.consent === undefined ? {} : { consent: options.consent }),
    anchors: options.anchorDigest === undefined ? [] : [{ digest: options.anchorDigest }],
  };

  const sealed = await sealKeyBinding(binding, fixtureSigner(options.workingKeyDidKey));
  return {
    binding,
    envelopeBytes: sealed.envelopeBytes,
    bindingDigest: sealed.recordDigest,
    ...(ceremonyEvidence === undefined ? {} : { ceremonyEvidence }),
  };
}

export interface ResolvedBindingFixtureOptions extends BuildKeyBindingFixtureOptions {
  readonly effectiveStart?: string;
  readonly isGenesis?: boolean;
  readonly incumbentControlVoucher?: VoucherIdentity;
  readonly witness?: Eip1271Witness;
  readonly revocations?: readonly ResolvedRevocation[];
}

export interface ResolvedBindingFixture extends KeyBindingFixture {
  readonly resolved: ResolvedBinding;
}

/** Builds a `KeyBindingFixture` and its matching `ResolvedBinding` (as a
 * `BindingResolver`/`fakes.ts` would hand it to `verify.ts`) in one call --
 * the common case for registering a binding with `createFakeResolvers()`. */
export async function buildResolvedBindingFixture(
  options: ResolvedBindingFixtureOptions,
): Promise<ResolvedBindingFixture> {
  const built = await buildKeyBindingFixture(options);
  const resolved: ResolvedBinding = {
    binding: built.binding,
    envelopeBytes: built.envelopeBytes,
    bindingDigest: built.bindingDigest,
    effectiveStart: options.effectiveStart ?? built.binding.validFrom,
    isGenesis: options.isGenesis ?? true,
    revocations: options.revocations ?? [],
    ...(built.ceremonyEvidence === undefined ? {} : { ceremonyEvidence: built.ceremonyEvidence }),
    ...(options.witness === undefined ? {} : { witness: options.witness }),
    ...(options.incumbentControlVoucher === undefined ? {} : { incumbentControlVoucher: options.incumbentControlVoucher }),
  };
  return { ...built, resolved };
}

/** A stub 1271 witness for the kit's fake `WitnessVerifier` -- pair with
 * `fakes.ts`'s `registerWitnessResult(verifierIri, result)`. The real
 * witness envelope shape is exercised by `trust-resolve`'s own
 * `witness.test.ts` (T12); the kit only needs the lookup key. */
export function stubWitness(verifier: string): Eip1271Witness {
  return {
    chainId: 84532,
    blockNumber: 1,
    blockHash: testSha256Digest(`${verifier}-block`),
    verifier,
    envelopeBytes: new TextEncoder().encode("fixture-witness"),
  };
}

export type AccountVoucherIdentity = Extract<VoucherIdentity, { readonly kind: "account" }>;

export function accountVoucher(
  chainId: number,
  address: `0x${string}`,
  contractAccount = false,
): AccountVoucherIdentity {
  return { kind: "account", did: didPkh(chainId, address), contractAccount };
}

// ---------------------------------------------------------------------------
// Revocation fixtures (§7.4b).
// ---------------------------------------------------------------------------

export interface BuildRevocationFixtureOptions {
  readonly target: Sha256Digest;
  readonly revokedBy: string;
  readonly effectiveFrom?: string;
  readonly anchorDigest?: Sha256Digest;
}

export interface RevocationFixture {
  readonly revocation: Revocation;
  readonly envelopeBytes: Uint8Array;
}

/**
 * Seals a revocation companion record (§7.4b). `revokedBy` is signed as
 * the fixture envelope's declared keyid regardless of whether it is a
 * `did:pkh` (the voucher account, via a fresh ceremony) or a `did:key`
 * (a `scope: bindings` working key) -- `verify.ts`'s
 * `isRevocationAuthorized` only checks that the envelope's valid signer
 * set includes `revocation.revokedBy` literally (the kit's declared-
 * keyid-trusting `dsseVerifier` fake makes this sufficient).
 */
export async function buildRevocationFixture(options: BuildRevocationFixtureOptions): Promise<RevocationFixture> {
  const revocation: Revocation = {
    protocol: TRUST_REVOCATION_FORMAT,
    target: options.target,
    revokedBy: options.revokedBy,
    anchors: options.anchorDigest === undefined ? [] : [{ digest: options.anchorDigest }],
    effectiveFrom: options.effectiveFrom ?? "2026-02-01T00:00:00.000Z",
  };
  const sealed = await sealRevocation(revocation, fixtureSigner(options.revokedBy));
  return { revocation, envelopeBytes: sealed.envelopeBytes };
}

export function resolvedRevocation(fixture: RevocationFixture, effectiveTime: string): ResolvedRevocation {
  return { revocation: fixture.revocation, envelopeBytes: fixture.envelopeBytes, effectiveTime };
}

// ---------------------------------------------------------------------------
// Authorization statement fixtures (§8.1).
// ---------------------------------------------------------------------------

export interface BuildAuthorizationFixtureOptions {
  readonly issuer: string;
  readonly audience?: string;
  readonly subjectName?: string;
  readonly subjectDigestHex?: string;
  readonly capabilities: readonly string[];
  readonly expiry?: string;
  readonly nonce?: string;
  readonly proofs?: readonly Sha256Digest[];
  readonly revocation?: Sha256Digest;
  readonly signerKeyid: string;
}

export interface AuthorizationFixture {
  readonly statement: AuthorizationStatement;
  readonly envelopeBytes: Uint8Array;
  readonly digest: Sha256Digest;
}

export async function buildAuthorizationFixture(
  options: BuildAuthorizationFixtureOptions,
): Promise<AuthorizationFixture> {
  const statement: AuthorizationStatement = {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [{
      name: options.subjectName ?? "fixture-subject",
      digest: { sha256: options.subjectDigestHex ?? "a".repeat(64) },
    }],
    predicateType: AUTHORIZATION_PREDICATE_TYPE,
    predicate: {
      issuer: options.issuer,
      ...(options.audience === undefined ? {} : { audience: options.audience }),
      capabilities: [...options.capabilities],
      expiry: options.expiry ?? "2027-01-01T00:00:00.000Z",
      nonce: options.nonce ?? "fixture-nonce",
      ...(options.proofs === undefined ? {} : { proofs: [...options.proofs] }),
      ...(options.revocation === undefined ? {} : { revocation: options.revocation }),
    },
  };
  const sealed = await sealAuthorization(statement, fixtureSigner(options.signerKeyid));
  return { statement, envelopeBytes: sealed.envelopeBytes, digest: sealed.recordDigest };
}

// ---------------------------------------------------------------------------
// Trust-policy fixtures (§9).
// ---------------------------------------------------------------------------

export interface BuildPolicyFixtureOptions {
  readonly version?: number;
  readonly predecessor?: Sha256Digest;
  readonly purposes: Record<string, PolicyPurposeEntry>;
  /** The version's own declared signer set (§9: working keys listed in
   * THIS version). Defaults to a single-key, threshold-1 set naming
   * `signerKeyid`. */
  readonly signerSet?: { readonly keys: readonly string[]; readonly threshold: number };
  readonly signerKeyid: string;
  /** Every keyid whose signature the sealed envelope should actually
   * carry -- defaults to `[signerKeyid]`. §9's dual-threshold chaining
   * needs a child version's envelope to carry signatures from BOTH the
   * old and new signer sets at once. */
  readonly envelopeSignerKeyids?: readonly string[];
  readonly refreshBy?: string;
}

export interface PolicyFixture {
  readonly policy: TrustPolicy;
  readonly envelopeBytes: Uint8Array;
  readonly digest: Sha256Digest;
}

export async function buildPolicyFixture(options: BuildPolicyFixtureOptions): Promise<PolicyFixture> {
  const policy: TrustPolicy = {
    protocol: TRUST_POLICY_FORMAT,
    version: options.version ?? 1,
    ...(options.predecessor === undefined ? {} : { predecessor: options.predecessor }),
    purposes: options.purposes,
    signerSet: options.signerSet === undefined
      ? { keys: [options.signerKeyid], threshold: 1 }
      : { keys: [...options.signerSet.keys], threshold: options.signerSet.threshold },
    refreshBy: options.refreshBy ?? "2027-01-01T00:00:00.000Z",
  };
  const envelopeSigners = options.envelopeSignerKeyids ?? [options.signerKeyid];
  const sealed = await sealTrustPolicy(policy, multiFixtureSigner(envelopeSigners));
  return { policy, envelopeBytes: sealed.envelopeBytes, digest: sealed.recordDigest };
}
