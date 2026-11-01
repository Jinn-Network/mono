// SPDX-License-Identifier: Apache-2.0

import {
  AnchorReferenceSchema,
  KeyBindingSchema,
  Sha256DigestSchema,
  ceremonyEvidenceDigest,
  compareCalendarStrictRfc3339Instants,
  compareCodeUnitStrings,
  isCalendarStrictRfc3339,
  recordDigest,
  verifyEoaCeremony,
  voucherIdentityEquals,
} from "@jinn-network/trust-core";
import type {
  AnchorResolver,
  BindingResolver,
  BindingResolverQuery,
  ChainFactResolver,
  Eip1271Witness,
  EoaCeremonyEvidence,
  IncumbentControl,
  KeyBinding,
  Revocation,
  ResolvedBinding,
  ResolvedRevocation,
  Sha256Digest,
} from "@jinn-network/trust-core";

import { TrustResolveError } from "./errors.js";

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
   * any agentId-voucher candidate then simply fails to resolve. A
   * `TrustResolveError` with code `INVALID_INPUT` says the registry holds no such
   * agent, and the leg fails. Any other throw is an outage: it leaves
   * `resolveBinding` as a throw. */
  readonly chainFacts?: ChainFactResolver;
  /** §7.5 step 3 for the ceremonies nothing in this package can verify:
   * `safe` (the witness leg in `verify.ts` does not tie a witness to this
   * record), `oidc-machine` (anchored JWKS) and `github-human`. A host that
   * can verify them says so here, record by record. Omit it and those
   * bindings simply fail to resolve: `verify.ts` takes a resolved binding as
   * this resolver's word that its ceremony was checked. A record the leg cannot
   * read is a `false`, because a store may hold anything. A throw says the leg
   * could not find out: it is an outage and leaves `resolveBinding` as a throw,
   * so a caller can tell it from a refusal. */
  readonly verifyHostedCeremony?: (record: SealedKeyBindingRecord) => Promise<boolean>;
  /** §7.1: a binding is DSSE-signed by the key it binds. A record that key
   * never signed does not resolve and cannot win a conflict over the key. It
   * still counts when deciding what came first, like any other record that
   * does not resolve. This package has no DSSE verifier of its own, so the host
   * supplies this leg, and an envelope it cannot read counts as unsigned. */
  readonly recordSignedByItsKey: (record: SealedKeyBindingRecord) => boolean;
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

type Verdicts = WeakMap<object, boolean>;

const placedBindings: Verdicts = new WeakMap();
const readableBindings: Verdicts = new WeakMap();
const readableRevocations: Verdicts = new WeakMap();

/** A store may hold anything, and one object may be listed as both kinds of
 * record, so each question keeps its own answers. */
function remembered(verdicts: Verdicts, entry: object | null, decide: () => boolean): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const known = verdicts.get(entry);
  if (known !== undefined) return known;
  const verdict = decide();
  verdicts.set(entry, verdict);
  return verdict;
}

const AnchorsSchema = AnchorReferenceSchema.array();

function hasReadableAnchors(record: { readonly anchors?: unknown } | null | undefined): boolean {
  return typeof record === "object" && record !== null && AnchorsSchema.safeParse(record.anchors).success;
}

/** Whether a stored entry can be placed in time. One that can counts when
 * deciding what came first, whatever else it holds: it may be the true genesis,
 * and leaving it out would make the next record the founder of the IRI (§7.4a). */
function canBePlaced(record: SealedKeyBindingRecord): boolean {
  return remembered(placedBindings, record, () => hasReadableAnchors(record.binding)
    && Sha256DigestSchema.safeParse(record.bindingDigest).success);
}

/** Whether a stored entry is the record it says it is. Only one that is can
 * resolve or give authority. */
function isReadableBinding(record: SealedKeyBindingRecord): boolean {
  return remembered(readableBindings, record, () => KeyBindingSchema.safeParse(record.binding).success
    && Sha256DigestSchema.safeParse(record.bindingDigest).success
    && record.envelopeBytes instanceof Uint8Array);
}

/** Whether a stored revocation has what verification reads: a place in time, a
 * signer and the bytes that signer signed. A time that cannot be read claims
 * nothing, so the anchor stands alone, and authority is settled in `verify.ts`.
 * A revocation by someone with standing must not vanish for how it is spelled. */
function isReadableRevocation(record: SealedRevocationRecord): boolean {
  return remembered(readableRevocations, record, () => hasReadableAnchors(record.revocation)
    && typeof record.revocation.revokedBy === "string"
    && record.envelopeBytes instanceof Uint8Array);
}

function isObserved<T>(observation: T | null): observation is T {
  return observation !== null;
}

/**
 * Instants, not spellings: `...00.500Z` sorts before `...00Z` as text, and one
 * instant can be written many ways. A time nothing can read sorts after every
 * time that can be read, so it can found nothing and the order stays total.
 */
function compareTimes(left: string, right: string): number {
  const instants = compareCalendarStrictRfc3339Instants(left, right);
  if (instants !== undefined) return instants;
  const leftReadable = isCalendarStrictRfc3339(left);
  if (leftReadable !== isCalendarStrictRfc3339(right)) return leftReadable ? -1 : 1;
  return compareCodeUnitStrings(left, right);
}

function earliestAnchorTime(
  anchorTimes: readonly string[],
): string | undefined {
  if (anchorTimes.length === 0) return undefined;
  return anchorTimes.reduce((min, time) => (compareTimes(time, min) < 0 ? time : min));
}

/** §7.3's `max(stated, anchorTime)`. A stated time nothing can read claims
 * nothing, so the anchor stands alone. */
function laterOf(stated: string, anchorTime: string): string {
  const comparison = compareCalendarStrictRfc3339Instants(stated, anchorTime);
  return comparison !== undefined && comparison > 0 ? stated : anchorTime;
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
  return earliest === undefined ? undefined : laterOf(binding.validFrom, earliest);
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
  return earliest === undefined ? undefined : laterOf(revocation.effectiveFrom, earliest);
}

function isWithinWindow(binding: KeyBinding, effectiveStart: string, atTime: string): boolean {
  if (compareTimes(atTime, effectiveStart) < 0) return false;
  if (binding.expiresAt !== undefined && compareTimes(atTime, binding.expiresAt) > 0) return false;
  return true;
}

function didPkhFromAddress(chainId: number, address: string): string {
  return `did:pkh:eip155:${chainId}:${address}`;
}

function parseCaip19ChainId(caip19: string): number | undefined {
  const match = /^eip155:([0-9]+)\//.exec(caip19);
  return match ? Number(match[1]) : undefined;
}

/** §7.5 step 3, before anything else is asked of a record: whether this
 * package or the host can verify its ceremony at all. `trust-core` verifies
 * `eoa` offline; `agentId` is composition, below, which is keyed on the
 * voucher, so the label must name that voucher or the leg never runs. */
async function ceremonyCanBeVerified(
  record: SealedKeyBindingRecord,
  verifyHostedCeremony: CreateBindingResolverOptions["verifyHostedCeremony"],
): Promise<boolean> {
  switch (record.binding.ceremony.type) {
    case "eoa":
      return true;
    case "agentId":
      return record.binding.voucher.kind === "agentId";
    default:
      return verifyHostedCeremony === undefined ? false : verifyHostedCeremony(record);
  }
}

const eoaCeremonyVerdicts = new WeakMap<SealedKeyBindingRecord, boolean>();

/** `trust-core`'s offline leg, once per record: recovering a signer is the
 * dearest step of a resolve, and the answer is a fact about the record. */
function eoaCeremonyVerified(record: SealedKeyBindingRecord): boolean {
  const known = eoaCeremonyVerdicts.get(record);
  if (known !== undefined) return known;
  let verified = false;
  try {
    verified = record.ceremonyEvidence !== undefined
      && ceremonyEvidenceDigest(record.ceremonyEvidence) === record.binding.ceremony.digest
      && verifyEoaCeremony(record.ceremonyEvidence, record.binding).verified;
  } catch {
    // Evidence that cannot be read verifies nothing.
  }
  eoaCeremonyVerdicts.set(record, verified);
  return verified;
}

/** §7.2 asks the composition leg for a valid account-ceremony binding, not a
 * record naming the account: an agentId ceremony is only as verified as this.
 * This reads that record's ceremony, not its own chain or revocations. */
async function accountCeremonyVerified(
  record: SealedKeyBindingRecord,
  verifyHostedCeremony: CreateBindingResolverOptions["verifyHostedCeremony"],
): Promise<boolean> {
  switch (record.binding.ceremony.type) {
    case "eoa":
      return eoaCeremonyVerified(record);
    case "safe":
      return ceremonyCanBeVerified(record, verifyHostedCeremony);
    default:
      return false;
  }
}

/** §7.2's agentId composition leg: the agentId voucher's registry owner
 * must itself hold a currently-valid account-ceremony binding to the same
 * Agent IRI, valid at `atTime` (see the module's finding re: `ownerOf`
 * having no historical block parameter). */
async function agentIdCompositionHolds(
  candidate: SealedKeyBindingRecord,
  atTime: string,
  peers: readonly EffectiveBinding[],
  options: Pick<CreateBindingResolverOptions, "chainFacts" | "verifyHostedCeremony">,
): Promise<boolean> {
  const voucher = candidate.binding.voucher;
  if (voucher.kind !== "agentId") return true; // composition applies only to agentId vouchers
  const { chainFacts } = options;
  if (chainFacts === undefined) return false;

  const chainId = parseCaip19ChainId(voucher.caip19);
  if (chainId === undefined) return false;

  let ownerAddress: string;
  try {
    ownerAddress = await chainFacts.ownerOf(voucher.caip19);
  } catch (cause) {
    if (cause instanceof TrustResolveError && cause.code === "INVALID_INPUT") return false;
    throw cause;
  }
  const ownerDid = didPkhFromAddress(chainId, ownerAddress);

  for (const { record, effectiveStart } of peers) {
    if (record.bindingDigest === candidate.bindingDigest) continue;
    if (record.binding.voucher.kind !== "account") continue;
    if (record.binding.voucher.did !== ownerDid) continue;
    if (!isWithinWindow(record.binding, effectiveStart, atTime)) continue;
    // eslint-disable-next-line no-await-in-loop -- candidate sets are small.
    if (await accountCeremonyVerified(record, options.verifyHostedCeremony)) return true;
  }
  return false;
}

/** §7.5 step 3 for a record this resolver has in hand, whatever is resolving. */
async function ceremonyVerified(
  record: SealedKeyBindingRecord,
  atTime: string,
  peers: readonly EffectiveBinding[],
  options: Pick<CreateBindingResolverOptions, "chainFacts" | "verifyHostedCeremony">,
): Promise<boolean> {
  if (!(await ceremonyCanBeVerified(record, options.verifyHostedCeremony))) return false;
  if (record.binding.ceremony.type === "eoa" && !eoaCeremonyVerified(record)) return false;
  return agentIdCompositionHolds(record, atTime, peers, options);
}

/** The order §7.3 ranks an Agent's bindings by: earliest effective start,
 * ties broken by digest, so that no stored order can decide anything. */
function compareEffective(a: EffectiveBinding, b: EffectiveBinding): number {
  return compareTimes(a.effectiveStart, b.effectiveStart)
    || compareCodeUnitStrings(a.record.bindingDigest, b.record.bindingDigest);
}

/** §7.4a option 1 (self-extension): every `controls`-relationship peer in
 * window when this candidate took effect. `effectiveStart`, not `validFrom`:
 * the minter chooses `validFrom`, and §7.3 is what stops a choice reaching
 * back. All of them are surfaced because the resolver does not judge them:
 * one chosen here would hide the rest. `verify.ts` matches the candidate's
 * voucher and requires the match to stand. */
function findIncumbentControls(
  candidate: EffectiveBinding,
  peers: readonly EffectiveBinding[],
): IncumbentControl[] {
  return peers
    .filter(({ record, effectiveStart }) => {
      if (record.bindingDigest === candidate.record.bindingDigest) return false;
      if (record.binding.relationship !== "controls") return false;
      return isWithinWindow(record.binding, effectiveStart, candidate.effectiveStart);
    })
    .sort(compareEffective)
    .map(({ record }) => ({ key: record.binding.key.didKey, voucher: record.binding.voucher }));
}

/** Whether a record could found an IRI at all: it is a binding, it claims
 * control, and it names no authority over itself. A digest must not hand the
 * founding of a batch to one that does not, and so leave the rest of the batch
 * without an incumbent. */
function claimsFounding(record: SealedKeyBindingRecord): boolean {
  return isReadableBinding(record)
    && record.binding.relationship === "controls"
    && record.binding.consent === undefined;
}

/** True only for the founding binding of the Agent IRI (§7.4a): the
 * earliest-effective binding among every binding ever asserted for it, a tie
 * going first to one that claims founding and then by digest. */
function isGenesisAmong(candidate: EffectiveBinding, allForAgent: readonly EffectiveBinding[]): boolean {
  return allForAgent.every((other) => {
    if (other.record.bindingDigest === candidate.record.bindingDigest) return true;
    const instant = compareTimes(other.effectiveStart, candidate.effectiveStart);
    if (instant !== 0) return instant > 0;
    const founding = Number(claimsFounding(candidate.record)) - Number(claimsFounding(other.record));
    return founding !== 0
      ? founding > 0
      : compareCodeUnitStrings(other.record.bindingDigest, candidate.record.bindingDigest) >= 0;
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
  const signatureVerdicts = new WeakMap<SealedKeyBindingRecord, boolean>();
  const signedByItsKey = (record: SealedKeyBindingRecord): boolean => {
    const known = signatureVerdicts.get(record);
    if (known !== undefined) return known;
    let signed = false;
    try {
      signed = options.recordSignedByItsKey(record);
    } catch {
      // An envelope that cannot be read was signed by no one.
    }
    signatureVerdicts.set(record, signed);
    return signed;
  };

  return {
    async resolveBinding(query: BindingResolverQuery, atTime: string): Promise<ResolvedBinding | null> {
      const allForAgent = await options.bindings.listBindingsForAgent(query.agent);

      const withEffectiveStart: EffectiveBinding[] = [];
      for (const record of allForAgent) {
        if (!canBePlaced(record)) continue;
        // eslint-disable-next-line no-await-in-loop -- candidate sets are small.
        const effectiveStart = await effectiveStartOf(record.binding, options.anchors);
        if (effectiveStart === undefined) {
          if (requireAnchors || typeof record.binding.validFrom !== "string") continue; // unanchored -- non-resolvable (§7.3)
          withEffectiveStart.push({ record, effectiveStart: record.binding.validFrom });
          continue;
        }
        withEffectiveStart.push({ record, effectiveStart });
      }
      const readable = withEffectiveStart.filter(({ record }) => isReadableBinding(record));

      // The ceremony gate applies to what may resolve, never to the set the
      // genesis and the incumbents are read from: a record nothing here can
      // verify may be the true genesis, and leaving it out would make the next
      // record the founder of the IRI (§7.4a).
      const forKeyAtTime: EffectiveBinding[] = [];
      for (const candidate of readable) {
        if (candidate.record.binding.key.didKey !== query.key) continue;
        if (!isWithinWindow(candidate.record.binding, candidate.effectiveStart, atTime)) continue;
        if (!signedByItsKey(candidate.record)) continue;
        // eslint-disable-next-line no-await-in-loop -- candidate sets are small.
        if (await ceremonyCanBeVerified(candidate.record, options.verifyHostedCeremony)) forKeyAtTime.push(candidate);
      }
      if (forKeyAtTime.length === 0) return null;

      const withComposition: EffectiveBinding[] = [];
      for (const candidate of forKeyAtTime) {
        // eslint-disable-next-line no-await-in-loop -- candidate sets are small.
        const holds = await agentIdCompositionHolds(candidate.record, atTime, readable, options);
        if (holds) withComposition.push(candidate);
      }
      if (withComposition.length === 0) return null;

      // §7.3's conflict is between bindings, and a record whose own ceremony fails
      // is not one: it cannot beat a record that verifies, whatever its time. Alone
      // it still resolves, so that verification can name what failed.
      const verified = withComposition.filter(
        ({ record }) => record.binding.ceremony.type !== "eoa" || eoaCeremonyVerified(record),
      );
      const winner = [...(verified.length > 0 ? verified : withComposition)].sort(compareEffective)[0]!;
      if (withComposition.length > 1 && options.onConflict) {
        options.onConflict({
          key: query.key,
          agent: query.agent,
          atTime,
          digests: withComposition.map(({ record }) => record.bindingDigest).sort(compareCodeUnitStrings),
          resolvedDigest: winner.record.bindingDigest,
        });
      }

      // A revocation ends a key's standing under a voucher, not one spelling of it: whoever
      // holds a key can seal it again, and the record that wins must not leave a revocation
      // of the one it replaced behind. Which records one reaches is read at its effective
      // time, not at `atTime`, so a record ending later lifts nothing, and a record that
      // first takes effect after it shares nothing, which is how a voucher binds a key again.
      const standing = readable.filter(({ record }) => record.binding.key.didKey === query.key
        && voucherIdentityEquals(record.binding.voucher, winner.record.binding.voucher)
        && signedByItsKey(record));
      const revocationRecords = await options.bindings.listRevocationsForTargets(
        standing.map(({ record }) => record.bindingDigest),
      );
      const revocations: ResolvedRevocation[] = [];
      for (const revocationRecord of revocationRecords) {
        if (!isReadableRevocation(revocationRecord)) continue;
        // eslint-disable-next-line no-await-in-loop -- revocation sets are small.
        const effectiveTime = await effectiveTimeOfRevocation(revocationRecord.revocation, options.anchors);
        if (effectiveTime === undefined) continue; // unanchored revocations never take effect
        // A store may hold one digest in more than one row, so none of this reads a single row.
        const { target } = revocationRecord.revocation;
        const named = standing.filter(({ record }) => record.bindingDigest === target);
        const namedInWindow = named.filter(({ record, effectiveStart }) => isWithinWindow(record.binding, effectiveStart, effectiveTime));
        if (named.length > 0 && target !== winner.record.bindingDigest && !(
          namedInWindow.length > 0 && isWithinWindow(winner.record.binding, winner.effectiveStart, effectiveTime)
        )) continue;
        const targetScope: string[] = [];
        for (const { record } of namedInWindow) {
          // eslint-disable-next-line no-await-in-loop -- revocation sets are small.
          if (await ceremonyVerified(record, effectiveTime, readable, options)) targetScope.push(...record.binding.scope);
        }
        revocations.push({
          revocation: revocationRecord.revocation,
          envelopeBytes: revocationRecord.envelopeBytes,
          effectiveTime,
          ...(targetScope.length > 0 ? { targetScope } : {}),
        });
      }
      revocations.sort((a, b) => compareTimes(a.effectiveTime, b.effectiveTime)
        || compareCodeUnitStrings(recordDigest(a.envelopeBytes), recordDigest(b.envelopeBytes)));

      const incumbentControls = findIncumbentControls(winner, readable);
      const resolved: ResolvedBinding = {
        binding: winner.record.binding,
        envelopeBytes: winner.record.envelopeBytes,
        bindingDigest: winner.record.bindingDigest,
        effectiveStart: winner.effectiveStart,
        isGenesis: isGenesisAmong(winner, withEffectiveStart),
        revocations,
        ...(winner.record.ceremonyEvidence === undefined ? {} : { ceremonyEvidence: winner.record.ceremonyEvidence }),
        ...(winner.record.witness === undefined ? {} : { witness: winner.record.witness }),
        ...(incumbentControls.length === 0 ? {} : { incumbentControls }),
      };
      return resolved;
    },
  };
}
