// SPDX-License-Identifier: Apache-2.0

import type { EoaCeremonyEvidence } from "./ceremony.js";
import type { KeyBinding } from "./key-binding.js";
import type { Revocation } from "./revocation.js";
import type { Sha256Digest } from "./types.js";
import type { VoucherIdentity } from "./spellings.js";

// ---------------------------------------------------------------------------
// The §17 I/O split: these are the interface TYPES `core` defines and
// `trust-resolve` implements against (chain reads, anchor lookups, 1271
// witness verification -- promoting `client/src/erc8004/publisher-safe-
// resolver.ts`). `core` never implements them and never imports `resolve`;
// it only calls them through injection, in `verify.ts`.
// ---------------------------------------------------------------------------

/** A revocation record resolved against a specific binding, carrying its
 * own sealed envelope bytes (so `verify.ts` can independently check
 * signer authority, §7.4b) and its anchored effective (non-retroactive)
 * time. */
export interface ResolvedRevocation {
  readonly revocation: Revocation;
  readonly envelopeBytes: Uint8Array;
  /** The revocation's own anchor time -- §7.4b: "its effect starts at its
   * own anchor time," never earlier. */
  readonly effectiveTime: string;
}

/**
 * A binding resolved for a specific (key, agent) pair at a specific time
 * (§7.3/§7.5 step 2). The resolver has already performed the §7.3
 * anchor-ordering, `effectiveStart` computation, and (for `safe`/`agentId`/
 * `oidc-machine` ceremonies) the on-chain/witness/JWKS legs that only it
 * can do; for `eoa` and `safe` ceremonies it attaches the raw evidence so
 * `core`'s `verify.ts` can still perform its own offline leg of step 3
 * (rung separation -- a resolved binding is data, not yet a verified one).
 */
export interface ResolvedBinding {
  readonly binding: KeyBinding;
  readonly envelopeBytes: Uint8Array;
  readonly bindingDigest: Sha256Digest;
  /** `max(binding.validFrom, anchorTime)` -- §7.3's effective-start rule. */
  readonly effectiveStart: string;
  /** Present when `binding.ceremony.type === "eoa"` -- the raw ceremony
   * evidence for `core`'s own offline EIP-191 leg (`ceremony.ts`). */
  readonly ceremonyEvidence?: EoaCeremonyEvidence;
  /** Present when `binding.ceremony.type === "safe"` -- the 1271 witness
   * statement for the injected `WitnessVerifier` leg (§7.2a). */
  readonly witness?: Eip1271Witness;
  /** True only for the founding binding of the Agent IRI -- no §7.4a
   * consent-chain check applies (design §7.4a: "the genesis binding of an
   * Agent IRI stands alone"). */
  readonly isGenesis: boolean;
  /** The voucher currently holding a valid `controls`-relationship binding
   * to this same Agent IRI, if any -- the fact §7.4a's self-extension
   * check (option 1) compares this binding's own `voucher` against. */
  readonly incumbentControlVoucher?: VoucherIdentity;
  /** Every anchored revocation naming this binding's digest as `target`,
   * whether or not its signer authority holds -- `verify.ts` (not the
   * resolver) determines authority (§7.4b), consistent with §7.5 step 4
   * being `core`'s job. */
  readonly revocations: readonly ResolvedRevocation[];
}

export interface BindingResolverQuery {
  readonly key: string; // did:key
  readonly agent: string; // Agent IRI
}

/**
 * Resolves the binding for a (key, agent) pair at a time (§7.5 step 2 --
 * never by key alone: one key may hold bindings to several IRIs, and the
 * claim names which is in play). Anchor-ordered per §7.3; under
 * anchor-requiring profiles an unanchored binding does not resolve, so
 * implementations return `null` rather than an unanchored `ResolvedBinding`.
 */
export interface BindingResolver {
  resolveBinding(query: BindingResolverQuery, atTime: string): Promise<ResolvedBinding | null>;
}

/** An anchor observation resolved by digest (§7.3): append-only,
 * tamper-evident, and consistently ordered for every consumer. */
export interface AnchorObservation {
  readonly digest: Sha256Digest;
  readonly anchorTime: string;
}

export interface AnchorResolver {
  lookupAnchor(digest: Sha256Digest): Promise<AnchorObservation | null>;
}

/** The §7.2a 1271 witness: a DSSE-signed statement by a witness identity
 * -- `{chainId, blockNumber, blockHash, isValidSignature result, verifier}`
 * -- carried here as its sealed envelope bytes plus the declared fields
 * `verify1271Witness` needs to locate and check it (witness-author
 * acceptability is a §9 policy purpose, applied by the caller). */
export interface Eip1271Witness {
  readonly chainId: number;
  readonly blockNumber: number;
  readonly blockHash: string;
  /** Agent IRI of the witness's author. */
  readonly verifier: string;
  readonly envelopeBytes: Uint8Array;
}

export interface WitnessResult {
  readonly verified: boolean;
  readonly reason?: string;
}

export interface WitnessVerifier {
  verify1271Witness(witness: Eip1271Witness): Promise<WitnessResult>;
}

/** ERC-8004 agentId composition facts (§7.2): registry `ownerOf` +
 * `getAgentWallet`-at-block. Defined here so `trust-resolve` implements a
 * stable contract; consumed internally by a `BindingResolver`
 * implementation's agentId-composition leg, not called directly by
 * `core`'s procedures. */
export interface ChainFactResolver {
  ownerOf(caip19Agent: string): Promise<string>;
  getAgentWalletAtBlock(agentId: string, block: number): Promise<string>;
}
