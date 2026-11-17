// SPDX-License-Identifier: Apache-2.0

import {
  AnchorReferenceSchema,
  KeyBindingSchema,
  Sha256DigestSchema,
  TRUST_KEY_BINDING_MEDIA_TYPE,
  TRUST_REVOCATION_MEDIA_TYPE,
  canonicalJsonBytes,
  ceremonyCurrencyFailure,
  ceremonyEvidenceDigest,
  checkBindingStands,
  compareCalendarStrictRfc3339Instants,
  compareCodeUnitStrings,
  isCalendarStrictRfc3339,
  parseSignedRecordEnvelope,
  recordDigest,
  verifyEoaCeremony,
  voucherIdentityEquals,
} from "@jinn-network/trust-core";
import type {
  AnchorResolver,
  BindingAuthorityDeps,
  BindingResolver,
  BindingResolverQuery,
  CeremonyCurrencyProfile,
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

import { TrustResolveError, invalidInput, resolutionFailed } from "./errors.js";

// ---------------------------------------------------------------------------
// §7.3's at-time binding resolution, composed for `BindingResolver`:
// `effectiveStart = max(validFrom, anchorTime)`; unanchored bindings do
// not resolve under anchor-requiring profiles; where two bindings
// conflict over the same (key, agent) pair, the earlier-anchored one
// wins and the conflict is surfaced (§7.3 names "surfaced to policy" --
// `trust-resolve` has no policy layer of its own, so this composes the
// injected `onConflict` observability hook instead). Also composes §7.2's
// agentId account-composition leg: an agentId-voucher binding resolves
// only alongside a binding of the registry owner's account to the SAME
// Agent IRI that stands at the instant (key authority sections 4 and 6),
// the owner read via the injected `ChainFactResolver`.
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
  /** What the agentId composition leg judges the registry owner's account binding with. Key
   * authority section 4 composes only with one that stands at the instant (section 6): in window,
   * signed by the key it binds, its ceremony verified, no authorized revocation before that
   * instant, and its chain holding. That is `trust-core`'s `checkBindingStands`, which reads
   * revocations, consents and witnesses with these legs. Omit it and no agentId binding composes.
   *
   * What it costs: within one `resolveBinding` call the leg reads the registry once per agentId, and
   * answers each composition, and each owner binding's standing at an instant, once, reusing the
   * answer wherever its cycle guard would answer alike. So however records lean on one another, the
   * work grows polynomially with the records the store lists. Only compositions at one instant that
   * rest on one another in a ring can need more than one answer; a call that would answer one
   * question more than 64 times ends as an outage (`TrustResolveError`, `RESOLUTION_FAILED`). */
  readonly compositionAuthority?: Pick<BindingAuthorityDeps, "dsseVerifier" | "witnessVerifier">;
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
  /** The deployment's choice under the ceremony currency text,
   * `https://spec.jinn.network/profiles/ceremony-currency/v1`. Omit it and the
   * text is not applied: every ceremony is checked as before it. Supply it and
   * an `eoa` ceremony must also hold under the text at its record's effective
   * start, here and, because each resolved binding carries this profile, in
   * `verify.ts`. A `termsCutover` must be readable and needs `requireAnchors`,
   * since only an anchor fixes the effective start. `safe` ceremonies are the
   * host's leg: a host that verifies them in `verifyHostedCeremony` applies the
   * text there. */
  readonly ceremonyCurrency?: CeremonyCurrencyProfile;
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

/**
 * Whether a stored entry's fields are what its envelope says: the payload of that envelope,
 * sealed as `payloadType`. A key's signature is its word for one envelope's payload and
 * nothing else, so fields a store pairs with an envelope they are not the payload of are no
 * one's word, and neither is a payload sealed as another kind of record. Both sides are read
 * as JSON and compared in their RFC 8785 form, so how a store orders or spaces the fields does
 * not count. An envelope that cannot be read carries nothing.
 */
function isPayloadOf(fields: unknown, envelopeBytes: Uint8Array, payloadType: string): boolean {
  try {
    const { payloadBytes } = parseSignedRecordEnvelope(envelopeBytes, payloadType);
    const sealed = canonicalJsonBytes(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes)));
    const stored = canonicalJsonBytes(fields);
    return sealed.length === stored.length && sealed.every((byte, index) => byte === stored[index]);
  } catch {
    return false;
  }
}

/** Whether a stored entry is the record it says it is: a key binding whose fields are its
 * envelope's payload. Only one that is can resolve or give authority. */
function isReadableBinding(record: SealedKeyBindingRecord): boolean {
  return remembered(readableBindings, record, () => KeyBindingSchema.safeParse(record.binding).success
    && Sha256DigestSchema.safeParse(record.bindingDigest).success
    && record.envelopeBytes instanceof Uint8Array
    && isPayloadOf(record.binding, record.envelopeBytes, TRUST_KEY_BINDING_MEDIA_TYPE));
}

/** Whether a stored revocation has what verification reads: a place in time, a
 * signer and the bytes that signer signed, whose payload its fields are. A time
 * that cannot be read claims nothing, so the anchor stands alone, and authority
 * is settled in `verify.ts`. A revocation by someone with standing must not
 * vanish for how it is spelled. */
function isReadableRevocation(record: SealedRevocationRecord): boolean {
  return remembered(readableRevocations, record, () => hasReadableAnchors(record.revocation)
    && typeof record.revocation.revokedBy === "string"
    && record.envelopeBytes instanceof Uint8Array
    && isPayloadOf(record.revocation, record.envelopeBytes, TRUST_REVOCATION_MEDIA_TYPE));
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

/** Whether `trust-core` counts a revocation effective at `effectiveTime` when it judges authority at
 * `atTime`: one strictly before it, or one whose time cannot be read. Nothing is in window at an
 * instant that cannot be read, so nothing is counted there. */
function countedBefore(effectiveTime: string, atTime: string): boolean {
  if (!isCalendarStrictRfc3339(atTime)) return false;
  const order = compareCalendarStrictRfc3339Instants(effectiveTime, atTime);
  return order === undefined || order < 0;
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
 * dearest step of a resolve, and the answer is a fact about the record. The
 * ceremony currency text, when the deployment applies it, is read at the
 * record's effective start on top of that answer. */
function eoaCeremonyVerified(
  { record, effectiveStart }: EffectiveBinding,
  currency: CeremonyCurrencyProfile | undefined,
): boolean {
  if (!eoaSignatureAndContentVerified(record)) return false;
  if (currency === undefined) return true;
  try {
    return ceremonyCurrencyFailure(record.ceremonyEvidence!.message, record.binding, {
      profile: currency,
      effectiveStart,
    }) === undefined;
  } catch {
    return false; // Evidence that cannot be read verifies nothing.
  }
}

function eoaSignatureAndContentVerified(record: SealedKeyBindingRecord): boolean {
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

/** How many answers one resolve may give one question of the composition leg. One is enough unless
 * compositions at one instant rest on one another in a ring: the guard then answers by which of them
 * are being decided, and a ring wide enough would have that number grow exponentially. */
const ANSWERS_PER_QUESTION = 64;

/** An answer the composition leg gave in one resolve, and what it rests on: every composition whose
 * guard it consulted, itself among them when it rests on itself, and which of those were being
 * decided when it was asked. */
interface LegAnswer {
  readonly consulted: ReadonlySet<string>;
  readonly beingDecided: string;
  readonly holds: boolean;
}

/** What the composition leg has worked out in one resolve: the registry's owner of each agentId it
 * read, and its answers, by question. */
interface LegMemo {
  readonly owners: Map<string, Promise<string>>;
  readonly answers: Map<string, LegAnswer[]>;
}

/** Where a resolve stands in the composition leg: the memo of the resolve it is part of, the
 * compositions being decided on its call chain, each as its Agent, agentId and instant, and the
 * compositions the question it serves has consulted so far. */
interface LegContext {
  readonly memo: LegMemo;
  readonly composing: ReadonlySet<string>;
  readonly consulted: Set<string>;
}

/** What the agentId composition leg reads with in one resolve: the registry, what judges a
 * binding's standing, and this resolver, at the place in the leg the asking resolve stands. */
interface CompositionLeg extends LegContext {
  readonly chainFacts: ChainFactResolver | undefined;
  readonly authority: CreateBindingResolverOptions["compositionAuthority"];
  readonly resolveAt: (
    query: BindingResolverQuery,
    atTime: string,
    context: LegContext,
  ) => Promise<ResolvedBinding | null>;
}

/** Which of `consulted` are being decided on `composing`, written out so that two such sets compare as text. */
function beingDecidedOn(composing: ReadonlySet<string>, consulted: ReadonlySet<string>): string {
  return JSON.stringify([...consulted].filter((composition) => composing.has(composition)).sort(compareCodeUnitStrings));
}

/**
 * Answers `question` once per resolve where it can. What the store, the registry and the host's legs
 * say is fixed for the resolve, so an answer depends only on which of the compositions it consulted
 * were being decided: asked again while the same ones are, every guard it met answers alike, and so
 * does it. Otherwise `work` answers it afresh under `composing`, recording what it consults. Either
 * way the asking question has consulted all of it.
 */
async function answerOnce(
  asking: LegContext,
  question: string,
  composing: ReadonlySet<string>,
  work: (answering: LegContext) => Promise<boolean>,
): Promise<boolean> {
  const given = asking.memo.answers.get(question) ?? [];
  let answer = given.find(({ consulted, beingDecided }) => beingDecidedOn(asking.composing, consulted) === beingDecided);
  if (answer === undefined) {
    if (given.length >= ANSWERS_PER_QUESTION) {
      resolutionFailed(`the agentId composition leg would answer one question more than ${ANSWERS_PER_QUESTION} times in one `
        + "resolve: compositions at one instant rest on one another in a ring too wide to follow.");
    }
    const consulted = new Set<string>();
    const holds = await work({ memo: asking.memo, composing, consulted });
    answer = { consulted, beingDecided: beingDecidedOn(asking.composing, consulted), holds };
    asking.memo.answers.set(question, [...(asking.memo.answers.get(question) ?? []), answer]);
  }
  for (const composition of answer.consulted) asking.consulted.add(composition);
  return answer.holds;
}

/** The registry is read once per agentId in a resolve: what it says is one of that resolve's facts. */
function ownerOf(memo: LegMemo, chainFacts: ChainFactResolver, caip19: string): Promise<string> {
  let owner = memo.owners.get(caip19);
  if (owner === undefined) {
    owner = (async () => chainFacts.ownerOf(caip19))();
    memo.owners.set(caip19, owner);
  }
  return owner;
}

/** §7.2's agentId composition leg, as key authority section 4 states it: the account the
 * registry names as the agentId's owner holds a binding to the same Agent, under that account as
 * voucher, that stands at `atTime` (section 6). Authority is named by key, so the binding is what
 * resolves for its key at that instant, and `checkBindingStands` judges it, with this resolver
 * answering for every record its walk asks about. A composition that rests on itself holds nothing
 * up, as chains do not (section 7): asked again while it is being decided, it does not hold. Each
 * composition, and each owner binding's standing, is answered once per resolve (`answerOnce`), keyed
 * by all it reads: the composition, the owner and the owner's keys, or the Agent, owner, key and
 * instant. (See the module's finding re: `ownerOf` having no historical block parameter.) */
async function agentIdCompositionHolds(
  candidate: SealedKeyBindingRecord,
  atTime: string,
  peers: readonly EffectiveBinding[],
  leg: CompositionLeg,
): Promise<boolean> {
  const { agent, voucher } = candidate.binding;
  if (voucher.kind !== "agentId") return true; // composition applies only to agentId vouchers
  const { chainFacts, authority, resolveAt } = leg;
  if (chainFacts === undefined || authority === undefined) return false;

  const chainId = parseCaip19ChainId(voucher.caip19);
  if (chainId === undefined) return false;

  const composition = `${agent}\u001f${voucher.caip19}\u001f${atTime}`;
  leg.consulted.add(composition);
  if (leg.composing.has(composition)) return false;

  let ownerAddress: string;
  try {
    ownerAddress = await ownerOf(leg.memo, chainFacts, voucher.caip19);
  } catch (cause) {
    if (cause instanceof TrustResolveError && cause.code === "INVALID_INPUT") return false;
    throw cause;
  }
  const ownerDid = didPkhFromAddress(chainId, ownerAddress);
  const ownerKeys = [...new Set(peers
    .filter(({ record }) => record.binding.voucher.kind === "account" && record.binding.voucher.did === ownerDid)
    .map(({ record }) => record.binding.key.didKey))].sort(compareCodeUnitStrings);

  const composing = new Set([...leg.composing, composition]);
  return answerOnce(leg, JSON.stringify(["composition", composition, ownerDid, ownerKeys]), composing, async (deciding) => {
    for (const key of ownerKeys) {
      // eslint-disable-next-line no-await-in-loop -- sequential: the first that stands settles it.
      const stands = await answerOnce(deciding, JSON.stringify(["standing", agent, ownerDid, key, atTime]), deciding.composing, async (judging) => {
        const bindingResolver: BindingResolver = { resolveBinding: (query, at) => resolveAt(query, at, judging) };
        const account = await bindingResolver.resolveBinding({ key, agent }, atTime);
        if (account === null || account.binding.agent !== agent) return false;
        if (account.binding.voucher.kind !== "account" || account.binding.voucher.did !== ownerDid) return false;
        // §7.2: the account vouches through an account ceremony, not one a host verified for another kind.
        if (account.binding.ceremony.type !== "eoa" && account.binding.ceremony.type !== "safe") return false;
        return checkBindingStands(account, atTime, { ...authority, bindingResolver });
      });
      if (stands) return true;
    }
    return false;
  });
}

/** §7.5 step 3 for a record this resolver has in hand, whatever is resolving. */
async function ceremonyVerified(
  entry: EffectiveBinding,
  atTime: string,
  peers: readonly EffectiveBinding[],
  options: Pick<CreateBindingResolverOptions, "verifyHostedCeremony" | "ceremonyCurrency">,
  leg: CompositionLeg,
): Promise<boolean> {
  const { record } = entry;
  if (!(await ceremonyCanBeVerified(record, options.verifyHostedCeremony))) return false;
  if (record.binding.ceremony.type === "eoa" && !eoaCeremonyVerified(entry, options.ceremonyCurrency)) return false;
  return agentIdCompositionHolds(record, atTime, peers, leg);
}

/** The order §7.3 ranks an Agent's bindings by: earliest effective start,
 * ties broken by digest, so that no stored order can decide anything. */
function compareEffective(a: EffectiveBinding, b: EffectiveBinding): number {
  return compareTimes(a.effectiveStart, b.effectiveStart)
    || compareCodeUnitStrings(a.record.bindingDigest, b.record.bindingDigest);
}

const rowContents = new WeakMap<SealedKeyBindingRecord, string>();

/** What a stored row says, as text that tells apart any two rows a store reads
 * from JSON: a field that is absent from one that is null, and bytes from a
 * string. Values JSON cannot hold, which only a caller building rows in memory
 * can supply, are outside that and may be written out alike. A row that cannot
 * be written out at all is ranked as saying nothing. */
function rowContent(record: SealedKeyBindingRecord): string {
  const known = rowContents.get(record);
  if (known !== undefined) return known;
  let content = "";
  try {
    content = JSON.stringify(
      [
        record.binding,
        record.envelopeBytes,
        "ceremonyEvidence" in record ? [record.ceremonyEvidence] : [],
        "witness" in record ? [record.witness] : [],
      ],
      (_key, value: unknown) => {
        if (value instanceof Uint8Array) return `b${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
        return typeof value === "string" ? `s${value}` : value;
      },
    ) ?? "";
  } catch {
    // A row that cannot be written out is ranked as saying nothing.
  }
  rowContents.set(record, content);
  return content;
}

/** The order a key's candidates are ranked by: §7.3's order, and then, because
 * a store names each row's digest, rows that tie on instant and digest go by
 * what they say, a founding claim first and then their content, so that for
 * rows a store reads from JSON no stored order chooses between them. */
function compareCandidates(a: EffectiveBinding, b: EffectiveBinding): number {
  return compareEffective(a, b)
    || Number(claimsFounding(b.record)) - Number(claimsFounding(a.record))
    || compareCodeUnitStrings(rowContent(a.record), rowContent(b.record));
}

/** §7.4a option 1 (self-extension): every `controls`-relationship peer in
 * window when this candidate took effect. `effectiveStart`, not `validFrom`:
 * the minter chooses `validFrom`, and §7.3 is what stops a choice reaching
 * back. All of them are surfaced because the resolver does not judge them:
 * one chosen here would hide the rest. `verify.ts` matches the candidate's
 * voucher and requires the match to stand. Each row is weighed on its own, as
 * in `isGenesisAmong`: only the candidate row itself is passed over. */
function findIncumbentControls(
  candidate: EffectiveBinding,
  peers: readonly EffectiveBinding[],
): IncumbentControl[] {
  return peers
    .filter((peer) => {
      if (peer === candidate) return false;
      const { record, effectiveStart } = peer;
      if (record.binding.relationship !== "controls") return false;
      return isWithinWindow(record.binding, effectiveStart, candidate.effectiveStart);
    })
    .sort(compareCandidates)
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
 * going first to one that claims founding and then by digest. A digest is a
 * value its author can try again for, so it does not choose between the founding
 * claims of different vouchers: when the records that claim founding at that
 * instant name more than one voucher, none of them founds the IRI, and nothing
 * is its genesis. A store names each row's digest, so a row is weighed against
 * every other row: sharing a digest with the genesis binding makes nothing the
 * genesis. */
function isGenesisAmong(candidate: EffectiveBinding, allForAgent: readonly EffectiveBinding[]): boolean {
  return allForAgent.every((other) => {
    if (other === candidate) return true;
    const instant = compareTimes(other.effectiveStart, candidate.effectiveStart);
    if (instant !== 0) return instant > 0;
    const founding = Number(claimsFounding(candidate.record)) - Number(claimsFounding(other.record));
    if (founding !== 0) return founding > 0;
    if (claimsFounding(candidate.record)
      && !voucherIdentityEquals(candidate.record.binding.voucher, other.record.binding.voucher)) return false;
    return compareCodeUnitStrings(other.record.bindingDigest, candidate.record.bindingDigest) >= 0;
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
  const termsCutover = options.ceremonyCurrency?.termsCutover;
  if (termsCutover !== undefined) {
    if (!requireAnchors) {
      invalidInput("a terms cutover is named only under a profile that requires anchors (ceremony currency §6).");
    }
    if (!isCalendarStrictRfc3339(termsCutover)) {
      invalidInput(`terms cutover "${termsCutover}" cannot be read (ceremony currency §6).`);
    }
  }
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

  const resolveAt = async (
    query: BindingResolverQuery,
    atTime: string,
    context: LegContext,
  ): Promise<ResolvedBinding | null> => {
    const leg: CompositionLeg = { ...context, chainFacts: options.chainFacts, authority: options.compositionAuthority, resolveAt };
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
      const holds = await agentIdCompositionHolds(candidate.record, atTime, readable, leg);
      if (holds) withComposition.push(candidate);
    }
    if (withComposition.length === 0) return null;

    // §7.3's conflict is between bindings, and a record whose own ceremony fails
    // is not one: it cannot beat a record that verifies, whatever its time. Alone
    // it still resolves, so that verification can name what failed.
    const verified = withComposition.filter(
      (candidate) => candidate.record.binding.ceremony.type !== "eoa"
        || eoaCeremonyVerified(candidate, options.ceremonyCurrency),
    );
    const winner = [...(verified.length > 0 ? verified : withComposition)].sort(compareCandidates)[0]!;
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
    // first takes effect after it shares nothing, so a voucher can bind the key again once
    // what it reached has ended.
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
      // A resolve the composition leg makes is judged only at its own instant, by the revocations
      // `trust-core` counts there, so it works out the target scope of those alone. So no composition
      // reaches one at a later instant, and compositions can rest on one another only at one instant.
      for (const named of leg.composing.size === 0 || countedBefore(effectiveTime, atTime) ? namedInWindow : []) {
        // eslint-disable-next-line no-await-in-loop -- revocation sets are small.
        if (await ceremonyVerified(named, effectiveTime, readable, options, leg)) targetScope.push(...named.record.binding.scope);
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
      ...(options.ceremonyCurrency === undefined ? {} : { ceremonyCurrency: options.ceremonyCurrency }),
    };
    return resolved;
  };

  return {
    resolveBinding: (query: BindingResolverQuery, atTime: string) => resolveAt(query, atTime, {
      memo: { owners: new Map(), answers: new Map() },
      composing: new Set(),
      consulted: new Set(),
    }),
  };
}
