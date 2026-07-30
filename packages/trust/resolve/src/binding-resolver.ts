// SPDX-License-Identifier: Apache-2.0

import { compareCodeUnitStrings } from "@jinn-network/trust-core";
import type {
  AnchorResolver,
  BindingResolver,
  BindingResolverQuery,
  ChainFactResolver,
  Eip1271Witness,
  EoaCeremonyEvidence,
  KeyBinding,
  Revocation,
  ResolvedBinding,
  ResolvedRevocation,
  Sha256Digest,
  VoucherIdentity,
} from "@jinn-network/trust-core";

// ---------------------------------------------------------------------------
// §7.3's at-time binding resolution, composed for `BindingResolver`:
// `effectiveStart = max(validFrom, anchorTime)`; unanchored bindings do
// not resolve under anchor-requiring profiles; where two bindings
// conflict over the same (key, agent) pair, the earlier-anchored one
// wins and the conflict is surfaced (§7.3 names "surfaced to policy" --
// `trust-resolve` has no policy layer of its own, so this composes the
// injected `onConflict` observability hook instead). Also composes §7.2's
// agentId account-composition leg: an agentId-voucher binding resolves
// only alongside a valid account-ceremony binding to the SAME Agent IRI,
// checked via the injected `ChainFactResolver`.
//
// Finding: `ChainFactResolver.ownerOf` (the frozen interface `trust-core`
// defines, T9) has no block/time parameter -- it reads the registry's
// CURRENT owner, not the owner at `atTime`. The agentId composition leg
// below therefore checks composition against the current registry state,
// not a fully historical one; an at-time-correct check would need a
// timestamp-to-block mapping this tree does not provide. Recorded as a
// finding, not silently patched.
//
// Also a finding: record discovery itself (where sealed binding and
// revocation records come from) is out of this plan's scope (trust design
// §18 steps 3+). `BindingStore` below is `trust-resolve`'s own injected
// port for that data source -- not a `trust-core` interface -- so a real
// host wires it to wherever it discovers sealed trust records.
// ---------------------------------------------------------------------------

/** A sealed key-binding record as the injected `BindingStore` supplies it
 * -- the parsed record alongside its raw envelope bytes and digest, plus
 * (when the ceremony type calls for it) the raw ceremony evidence
 * `trust-core`'s own offline leg needs (§7.5 step 3). */
export interface SealedKeyBindingRecord {
  readonly binding: KeyBinding;
  readonly envelopeBytes: Uint8Array;
  readonly bindingDigest: Sha256Digest;
  readonly ceremonyEvidence?: EoaCeremonyEvidence;
  readonly witness?: Eip1271Witness;
}

/** A sealed revocation record as the `BindingStore` supplies it. */
export interface SealedRevocationRecord {
  readonly revocation: Revocation;
  readonly envelopeBytes: Uint8Array;
}

/**
 * The binding/revocation data source `createBindingResolver` composes
 * over. Not itself a `trust-core` interface -- record discovery is out of
 * this plan's scope (trust design §18 steps 3+).
 */
export interface BindingStore {
  /** Every sealed key-binding record ever asserted for a given Agent IRI
   * (across every key, voucher, and version) -- the resolver applies the
   * anchor-ordering, conflict, and composition rules over this set. */
  listBindingsForAgent(agent: string): Promise<readonly SealedKeyBindingRecord[]>;
  /** Every sealed revocation record targeting any of the given binding
   * digests. */
  listRevocationsForTargets(targets: readonly Sha256Digest[]): Promise<readonly SealedRevocationRecord[]>;
}

export interface BindingConflict {
  readonly key: string;
  readonly agent: string;
  readonly atTime: string;
  readonly digests: readonly Sha256Digest[];
  readonly resolvedDigest: Sha256Digest;
}

export interface CreateBindingResolverOptions {
  readonly bindings: BindingStore;
  readonly anchors: AnchorResolver;
  /** Needed only to resolve agentId-voucher bindings' composition leg
   * (§7.2). Omit for deployments/tests that never use agentId vouchers --
   * any agentId-voucher candidate then simply fails to resolve. */
  readonly chainFacts?: ChainFactResolver;
  /** Under an anchor-requiring profile an unanchored binding never
   * resolves (§7.3). Defaults to `true`, the safer default. */
  readonly requireAnchors?: boolean;
  /** Observability seam for §7.3's "the conflict is surfaced to policy" --
   * `trust-resolve` has no policy layer of its own. */
  readonly onConflict?: (conflict: BindingConflict) => void;
}

interface EffectiveBinding {
  readonly record: SealedKeyBindingRecord;
  readonly effectiveStart: string;
}

function isObserved<T>(observation: T | null): observation is T {
  return observation !== null;
}

function earliestAnchorTime(
  anchorTimes: readonly string[],
): string | undefined {
  if (anchorTimes.length === 0) return undefined;
  return anchorTimes.reduce((min, time) => (time < min ? time : min));
}

// `AnchorReferenceSchema`/`RevocationSchema` (trust-core) infer their
// `digest` fields as plain `string` (a Zod regex refinement does not
// narrow to the `Sha256Digest` template-literal brand); the schema already
// enforces the `sha256:<hex>` shape at parse time, so the cast here is
// sound, not a bypass.
function asSha256Digest(digest: string): Sha256Digest {
  return digest as Sha256Digest;
}

async function effectiveStartOf(binding: KeyBinding, anchors: AnchorResolver): Promise<string | undefined> {
  const observations = await Promise.all(
    binding.anchors.map((reference) => anchors.lookupAnchor(asSha256Digest(reference.digest))),
  );
  const anchorTimes = observations.filter(isObserved).map((observation) => observation.anchorTime);
  const earliest = earliestAnchorTime(anchorTimes);
  if (earliest === undefined) return undefined;
  return binding.validFrom > earliest ? binding.validFrom : earliest;
}

async function effectiveTimeOfRevocation(
  revocation: Revocation,
  anchors: AnchorResolver,
): Promise<string | undefined> {
  const observations = await Promise.all(
    revocation.anchors.map((reference) => anchors.lookupAnchor(asSha256Digest(reference.digest))),
  );
  const anchorTimes = observations.filter(isObserved).map((observation) => observation.anchorTime);
  const earliest = earliestAnchorTime(anchorTimes);
  if (earliest === undefined) return undefined;
  return revocation.effectiveFrom > earliest ? revocation.effectiveFrom : earliest;
}

function isWithinWindow(binding: KeyBinding, effectiveStart: string, atTime: string): boolean {
  if (atTime < effectiveStart) return false;
  if (binding.expiresAt !== undefined && atTime > binding.expiresAt) return false;
  return true;
}

function didPkhFromAddress(chainId: number, address: string): string {
  return `did:pkh:eip155:${chainId}:${address}`;
}

function parseCaip19ChainId(caip19: string): number | undefined {
  const match = /^eip155:([0-9]+)\//.exec(caip19);
  return match ? Number(match[1]) : undefined;
}

/** §7.2's agentId composition leg: the agentId voucher's registry owner
 * must itself hold a currently-valid account-ceremony binding to the same
 * Agent IRI, valid at `atTime` (see the module's finding re: `ownerOf`
 * having no historical block parameter). */
async function agentIdCompositionHolds(
  candidate: SealedKeyBindingRecord,
  atTime: string,
  peers: readonly EffectiveBinding[],
  chainFacts: ChainFactResolver | undefined,
): Promise<boolean> {
  const voucher = candidate.binding.voucher;
  if (voucher.kind !== "agentId") return true; // composition applies only to agentId vouchers
  if (chainFacts === undefined) return false;

  const chainId = parseCaip19ChainId(voucher.caip19);
  if (chainId === undefined) return false;

  let ownerAddress: string;
  try {
    ownerAddress = await chainFacts.ownerOf(voucher.caip19);
  } catch {
    return false;
  }
  const ownerDid = didPkhFromAddress(chainId, ownerAddress);

  return peers.some(({ record, effectiveStart }) => {
    if (record.bindingDigest === candidate.bindingDigest) return false;
    if (record.binding.voucher.kind !== "account") return false;
    if (record.binding.voucher.did !== ownerDid) return false;
    return isWithinWindow(record.binding, effectiveStart, atTime);
  });
}

/** §7.4a option 1 (self-extension): the voucher already holding a valid
 * `controls`-relationship binding to this Agent IRI at the moment this
 * candidate binding was minted (`validFrom`), if any. */
function findIncumbentControlVoucher(
  candidate: SealedKeyBindingRecord,
  peers: readonly EffectiveBinding[],
): VoucherIdentity | undefined {
  const mintTime = candidate.binding.validFrom;
  const incumbent = peers.find(({ record, effectiveStart }) => {
    if (record.bindingDigest === candidate.bindingDigest) return false;
    if (record.binding.relationship !== "controls") return false;
    return isWithinWindow(record.binding, effectiveStart, mintTime);
  });
  return incumbent?.record.binding.voucher;
}

/** True only for the founding binding of the Agent IRI (§7.4a): the
 * earliest-effective binding among every binding ever asserted for it,
 * ties broken deterministically by digest. */
function isGenesisAmong(candidate: EffectiveBinding, allForAgent: readonly EffectiveBinding[]): boolean {
  return allForAgent.every(({ record, effectiveStart }) => {
    if (record.bindingDigest === candidate.record.bindingDigest) return true;
    if (effectiveStart !== candidate.effectiveStart) return effectiveStart > candidate.effectiveStart;
    return compareCodeUnitStrings(record.bindingDigest, candidate.record.bindingDigest) >= 0;
  });
}

/**
 * Builds a `BindingResolver` (§7.3/§7.5 step 2): resolves the binding for
 * a (key, agent) pair at a time, applying anchor ordering, the
 * `effectiveStart = max(validFrom, anchorTime)` rule, earlier-anchored-
 * wins conflict resolution, and the §7.2 agentId composition leg.
 */
export function createBindingResolver(options: CreateBindingResolverOptions): BindingResolver {
  const requireAnchors = options.requireAnchors ?? true;

  return {
    async resolveBinding(query: BindingResolverQuery, atTime: string): Promise<ResolvedBinding | null> {
      const allForAgent = await options.bindings.listBindingsForAgent(query.agent);

      const withEffectiveStart: EffectiveBinding[] = [];
      for (const record of allForAgent) {
        // eslint-disable-next-line no-await-in-loop -- candidate sets are small.
        const effectiveStart = await effectiveStartOf(record.binding, options.anchors);
        if (effectiveStart === undefined) {
          if (requireAnchors) continue; // unanchored -- non-resolvable (§7.3)
          withEffectiveStart.push({ record, effectiveStart: record.binding.validFrom });
          continue;
        }
        withEffectiveStart.push({ record, effectiveStart });
      }

      const forKeyAtTime = withEffectiveStart.filter(
        ({ record, effectiveStart }) =>
          record.binding.key.didKey === query.key
          && isWithinWindow(record.binding, effectiveStart, atTime),
      );
      if (forKeyAtTime.length === 0) return null;

      const withComposition: EffectiveBinding[] = [];
      for (const candidate of forKeyAtTime) {
        // eslint-disable-next-line no-await-in-loop -- candidate sets are small.
        const holds = await agentIdCompositionHolds(candidate.record, atTime, withEffectiveStart, options.chainFacts);
        if (holds) withComposition.push(candidate);
      }
      if (withComposition.length === 0) return null;

      let winner = withComposition[0]!;
      for (const candidate of withComposition.slice(1)) {
        if (candidate.effectiveStart < winner.effectiveStart) winner = candidate;
      }
      if (withComposition.length > 1 && options.onConflict) {
        options.onConflict({
          key: query.key,
          agent: query.agent,
          atTime,
          digests: withComposition.map(({ record }) => record.bindingDigest).sort(compareCodeUnitStrings),
          resolvedDigest: winner.record.bindingDigest,
        });
      }

      const revocationRecords = await options.bindings.listRevocationsForTargets([winner.record.bindingDigest]);
      const revocations: ResolvedRevocation[] = [];
      for (const revocationRecord of revocationRecords) {
        // eslint-disable-next-line no-await-in-loop -- revocation sets are small.
        const effectiveTime = await effectiveTimeOfRevocation(revocationRecord.revocation, options.anchors);
        if (effectiveTime === undefined) continue; // unanchored revocations never take effect
        revocations.push({
          revocation: revocationRecord.revocation,
          envelopeBytes: revocationRecord.envelopeBytes,
          effectiveTime,
        });
      }

      const incumbentControlVoucher = findIncumbentControlVoucher(winner.record, withEffectiveStart);
      const resolved: ResolvedBinding = {
        binding: winner.record.binding,
        envelopeBytes: winner.record.envelopeBytes,
        bindingDigest: winner.record.bindingDigest,
        effectiveStart: winner.effectiveStart,
        isGenesis: isGenesisAmong(winner, withEffectiveStart),
        revocations,
        ...(winner.record.ceremonyEvidence === undefined ? {} : { ceremonyEvidence: winner.record.ceremonyEvidence }),
        ...(winner.record.witness === undefined ? {} : { witness: winner.record.witness }),
        ...(incumbentControlVoucher === undefined ? {} : { incumbentControlVoucher }),
      };
      return resolved;
    },
  };
}
