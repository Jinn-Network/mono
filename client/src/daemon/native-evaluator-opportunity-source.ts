import {
  decodeRawCodecCidDigestHex,
  deriveMarketplaceAttemptUri,
} from '@jinn-network/marketplace-binding';
import { recordPath } from '@jinn-network/record-discovery-protocol';
import { createHttpTransport } from '@jinn-network/record-discovery-transport-http';
import {
  DeliveryRecordSchema,
  documentDigest,
} from '@jinn-network/task-execution-protocol';
import {
  NATIVE_REQUESTER_ASSOCIATION_FACT,
  decodeNativeRequesterAnnouncement,
  isAwaitingFinality,
  parseNativeAuthorityTimeAnchor,
  type NativeAuthorityTimeAnchor,
} from '../native-requester/requester.js';
import type { FetchBytesByDigest, SubjectMaterialReferences } from '../evaluator/subject-material.js';
import type { Store } from '../store/store.js';
import type { NativeMarketplaceEventRepository } from './native-canonical-observations.js';
import { buildNativeDiscoverySources } from './native-discovery-trust.js';
// One shared chain-id reader across all three readers of the signed requester association
// (#2529). The other primitives below stay local to this module deliberately — only `chainId`
// had drifted, and only `chainId` is unified here.
import { chainId } from './native-assembly.js';
import {
  NativeDiscoveryLocalAuthorityError,
  createNativeDiscoveryConsumer,
  type NativeDiscoveryQueuedCard,
} from './native-discovery.js';
import type { NativeEvaluatorOpportunitySource } from './native-evaluator-composition.js';
import type {
  NativeAuthorityTimePrimitives,
  NativeEvaluatorReadPrimitives,
  NativePublicRecordTransport,
} from './native-infrastructure-bundle.js';
import type { NativeRecordSource } from '../config/native-sections.js';
import type { NativeTrustAuthority } from './native-trust-catalog.js';
import type { NativeDiscoveryCardProvenance } from './native-submission-facts.js';
// #2533: the requester-association index — posting-keyed, with the tamper guard — lives in its
// own module now. See its docstring for the collision this fixed and the discriminator it uses.
import { runIsolatedIngest, runIsolatedItems, runIsolatedPasses } from './native-isolated-passes.js';
// #2539: the public-record location index — signed-statement-keyed, with the tamper guard — lives
// in its own module now. See its docstring for the collision this fixed and the key it uses.
import {
  installPublicRecordSchema,
  publicRecordLocations,
  upsertPublicRecordLocation,
} from './native-evaluator-public-record-index.js';
import {
  associationForPosting,
  associationsForTaskDigest,
  installAssociationSchema,
  upsertRequesterAssociation,
  type IndexedNativeRequesterAssociation,
  type NativePostingIdentity,
} from './native-evaluator-association-index.js';

export type { IndexedNativeRequesterAssociation, NativePostingIdentity };

const ASSOCIATION = NATIVE_REQUESTER_ASSOCIATION_FACT;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;

interface NativePublicRecordCard {
  readonly record: {
    readonly kind: string;
    readonly digest: `sha256:${string}`;
  };
  readonly facts: Record<string, unknown>;
  readonly discovery?: NativeDiscoveryCardProvenance;
}

type NativePublicRecordQueueItem = NativeDiscoveryQueuedCard<NativePublicRecordCard>;

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function digest(value: unknown, label: string): `sha256:${string}` {
  if (typeof value !== 'string' || !DIGEST.test(value)) throw new Error(`${label} is not a canonical digest`);
  return value as `sha256:${string}`;
}

function uint(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`${label} is not a canonical unsigned integer`);
  }
  return BigInt(value);
}

function sourceId(source: NativeRecordSource): string {
  return `${source.agent}/${source.name}`;
}

function exactLocation(base: string, expected: `sha256:${string}`): string {
  return new URL(recordPath(expected), `${base.replace(/\/+$/u, '')}/`).toString();
}

function sequenceAfter(sequence: string, after?: string): boolean {
  return after === undefined || BigInt(sequence) > BigInt(after);
}

function exactDelivery(bytes: Uint8Array, expected: `sha256:${string}`) {
  if (documentDigest(bytes) !== expected) throw new Error('signed solver Delivery location changed digest');
  const parsed = DeliveryRecordSchema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  if (!parsed.success) throw new Error('signed solver Delivery is not a native DeliveryRecord');
  return parsed.data;
}

function cardLocations(card: NativePublicRecordQueueItem): readonly string[] {
  const value = card.card.facts['nativePublicLocations'];
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string')) {
    throw new Error('signed native record has no exact public location');
  }
  return value as string[];
}

function provenance(card: NativeDiscoveryQueuedCard<{ readonly discovery?: NativeDiscoveryCardProvenance }>) {
  const value = card.card.discovery;
  if (value === undefined) throw new Error('native evaluator card has no signed provenance');
  return value;
}

function role(card: NativePublicRecordQueueItem): string {
  const value = card.card.facts['role'];
  if (typeof value !== 'string' || value.length === 0) throw new Error('solver record has no signed role');
  return value;
}

function engagement(card: NativePublicRecordQueueItem): string {
  const value = card.card.facts['engagementId'];
  if (typeof value !== 'string' || value.length === 0) throw new Error('solver record has no engagement identity');
  return value;
}

function parseAssociation(card: NativeDiscoveryQueuedCard): IndexedNativeRequesterAssociation {
  const facts = object(card.card.facts, 'requester facts');
  const value = object(facts[ASSOCIATION], 'requester association');
  const discovery = provenance(card);
  const declaredChainId = chainId(value['chainId'], 'chainId');
  if (declaredChainId !== 84532) throw new Error('requester association is not Base Sepolia');
  const coordinator = value['coordinator'];
  const sealedAt = value['sealedAt'];
  const authorityTime = parseNativeAuthorityTimeAnchor(value['authorityTime']);
  const terms = object(value['postingTerms'], 'requester posting terms');
  if (typeof coordinator !== 'string' || !/^0x[0-9a-fA-F]{40}$/u.test(coordinator)
    || sealedAt !== authorityTime.timestamp) {
    throw new Error('requester association has invalid coordinator/sealing time');
  }
  return {
    taskDigest: digest(value['taskDigest'], 'Task digest'),
    submissionDigest: card.card.record.digest,
    requesterEnvelopeDigest: digest(value['requesterEnvelopeDigest'], 'requester envelope digest'),
    admissionReceiptDigest: digest(value['admissionReceiptDigest'], 'admission receipt digest'),
    sealedAt,
    authorityTime,
    requesterAgent: discovery.source.agent,
    chainId: 84532,
    coordinator: coordinator as `0x${string}`,
    taskId: uint(value['taskId'], 'task id'),
    responseTimeoutSeconds: uint(terms['responseTimeoutSeconds'], 'response timeout'),
  };
}

function installSchema(store: Store): void {
  installPublicRecordSchema(store);
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS native_evaluator_settlement_declarations (
      delivery_digest TEXT PRIMARY KEY,
      declaration_key TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_sequence TEXT NOT NULL,
      entry_digest TEXT NOT NULL
    );
  `);
  installAssociationSchema(store);
}

function indexSettlementDeclaration(store: Store, card: NativePublicRecordQueueItem): void {
  const value = card.card.facts['settlementDeclarationKey'];
  if (typeof value !== 'string' || !value.startsWith('did:key:')) {
    throw new Error('solver Delivery has no signed settlement declaration key');
  }
  const origin = provenance(card);
  const source = `${origin.source.agent}/${origin.source.name}`;
  const existing = store.db.prepare(
    `SELECT declaration_key, source_id, source_sequence, entry_digest
       FROM native_evaluator_settlement_declarations WHERE delivery_digest = ?`,
  ).get(card.card.record.digest) as {
    declaration_key: string;
    source_id: string;
    source_sequence: string;
    entry_digest: string;
  } | undefined;
  if (existing !== undefined) {
    if (existing.declaration_key !== value || existing.source_id !== source
      || existing.source_sequence !== origin.sequence || existing.entry_digest !== origin.entryDigest) {
      throw new Error('solver settlement declaration changed signed provenance');
    }
    return;
  }
  store.db.prepare(
    `INSERT INTO native_evaluator_settlement_declarations
      (delivery_digest, declaration_key, source_id, source_sequence, entry_digest)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(card.card.record.digest, value, source, origin.sequence, origin.entryDigest);
}

function indexLocation(store: Store, card: NativePublicRecordQueueItem, location: string): void {
  const origin = provenance(card);
  upsertPublicRecordLocation({
    store,
    digest: card.card.record.digest,
    location,
    provenance: {
      sourceId: `${origin.source.agent}/${origin.source.name}`,
      sequence: origin.sequence,
      entryDigest: origin.entryDigest,
    },
  });
}

function indexRequester(store: Store, card: NativeDiscoveryQueuedCard, configuredBase: string): void {
  const association = parseAssociation(card);
  const origin = provenance(card);
  upsertRequesterAssociation({
    store,
    association,
    provenance: {
      sourceId: `${origin.source.agent}/${origin.source.name}`,
      sequence: origin.sequence,
      entryDigest: origin.entryDigest,
    },
  });
  for (const expected of [
    association.taskDigest,
    association.submissionDigest,
    association.requesterEnvelopeDigest,
    association.admissionReceiptDigest,
  ]) {
    indexLocation(store, {
      ...card,
      card: { ...card.card, record: { ...card.card.record, digest: expected } },
    }, exactLocation(configuredBase, expected));
  }
}


/**
 * The exact I/O the evaluator opportunity reader needs, narrowed off the full
 * `NativeInfrastructurePrimitives` (one-swap M4a, #2461). The standalone host passes the whole
 * primitive object (its `evaluator` is guaranteed present by an earlier guard); the fleet path
 * builds these three directly from a plain viem `PublicClient` — the same "one reader, two callers"
 * seam `createSolverReads`/`createBaseSepoliaEvaluatorReads` already establish. `evaluator` is
 * REQUIRED here (not optional as on the full bundle): a reader with no chain correspondence has
 * nothing to prove signed source facts against.
 */
export interface NativeEvaluatorOpportunityInfrastructure {
  readonly records: Pick<NativePublicRecordTransport, 'byLocation' | 'byDigest'>;
  readonly authorityTime: Pick<NativeAuthorityTimePrimitives, 'verifyFinalized'>;
  readonly evaluator: NativeEvaluatorReadPrimitives;
}

function recordFetcher(input: {
  readonly store: Store;
  readonly infrastructure: NativeEvaluatorOpportunityInfrastructure;
  readonly publicBases: readonly string[];
}): FetchBytesByDigest {
  const byDigest = async (expected: `sha256:${string}`): Promise<Uint8Array> => {
    const locations = [...new Set([
      ...publicRecordLocations(input.store, expected),
      ...input.publicBases.map((base) => exactLocation(base, expected)),
    ])];
    for (const location of locations) {
      try {
        // eslint-disable-next-line no-await-in-loop -- alternate content-addressed public replicas.
        const bytes = await input.infrastructure.records.byLocation(location);
        if (documentDigest(bytes) === expected) return bytes;
      } catch {
        // Continue through signed/public replicas before falling back to IPFS.
      }
    }
    const bytes = await input.infrastructure.records.byDigest(expected);
    if (documentDigest(bytes) !== expected) throw new Error(`public record ${expected} changed digest`);
    return bytes;
  };
  return {
    byDigest,
    byCid: (cid) => byDigest(`sha256:${decodeRawCodecCidDigestHex(cid)}`),
  };
}

export interface NativeEvaluatorOpportunityReader {
  readonly source: NativeEvaluatorOpportunitySource;
  readonly fetcher: FetchBytesByDigest;
  /**
   * #2533: takes the POSTING, not a Task digest. A deterministic specification means several
   * postings share one Task digest, so a digest alone cannot select an association. Every caller
   * already holds the posting identity — the durable evaluation row carries `chainId`,
   * `coordinator` and `taskId` — so no caller had to reach for anything it did not have.
   */
  association(posting: NativePostingIdentity): IndexedNativeRequesterAssociation | undefined;
  settlementDeclarationKey(deliveryDigest: `sha256:${string}`): string;
  deadline(posting: NativePostingIdentity, admittedAt: string): string;
  syncSignedSources(): Promise<void>;
}

/**
 * Product-owned evaluator ingestion. Signed source facts select exact bytes; canonical venue
 * reads only prove their chain correspondence. Neither side can substitute authority for the
 * other.
 */
export async function buildNativeEvaluatorOpportunityReader(input: {
  /** Every configured signed source; exactly one `requester` and one `solver` are consumed. */
  readonly sources: readonly NativeRecordSource[];
  /** The JinnRouter the canonical solution-delivery join is scoped to. */
  readonly jinnRouter: `0x${string}`;
  /** Shared Store: the evaluator index tables + the `native_evaluations` join live here. */
  readonly store: Store;
  /**
   * The Store the two `createNativeDiscoveryConsumer` instances checkpoint and queue against. On
   * the standalone host this is `input.store` (a private per-evaluator sqlite, no other consumer).
   * On the ONE fleet daemon it MUST be a DISTINCT store, because the fleet WorkLoop already runs a
   * `createNativeDiscoveryConsumer` over the SAME requester source and the SAME shared Store's
   * `native_discovery_*` tables (M3): sharing the source-identity checkpoint there would let the
   * WorkLoop's acknowledgement/checkpoint advancement starve the evaluator's requester consumer,
   * and the decode-that-wrote-first would win the shared `card_json` row (M3 review N6). Keying the
   * evaluator's discovery queue distinctly is the separation; defaults to `store` for the
   * collision-free standalone path.
   */
  readonly discoveryStore?: Store;
  readonly trust: NativeTrustAuthority;
  readonly infrastructure: NativeEvaluatorOpportunityInfrastructure;
  readonly events: NativeMarketplaceEventRepository;
  readonly syncVenue: () => Promise<void>;
}): Promise<NativeEvaluatorOpportunityReader> {
  const discoveryStore = input.discoveryStore ?? input.store;
  installSchema(input.store);
  const requesterConfigured = input.sources.filter(({ role }) => role === 'requester');
  const solverConfigured = input.sources.filter(({ role }) => role === 'solver');
  if (requesterConfigured.length !== 1 || solverConfigured.length !== 1) {
    throw new Error('Phase B evaluator requires exactly one requester and one solver signed source');
  }
  const transport = createHttpTransport('');
  // Neither pair is resolved here (#2521 F2). In the gate's two-operator topology the requester
  // source belongs to one operator and the solver source to the other, so resolving both at
  // construction made A's boot wait on B's listener and B's on A's — a deadlock with no valid
  // start order. Both resolve at the first `syncSignedSources()`, under the same verification.
  const requesterSources = buildNativeDiscoverySources({
    configured: requesterConfigured,
    store: discoveryStore,
    transport,
    trust: input.trust,
  });
  const solverSources = buildNativeDiscoverySources({
    configured: solverConfigured,
    store: discoveryStore,
    transport,
    trust: input.trust,
  });
  const requester = createNativeDiscoveryConsumer({
    store: discoveryStore,
    sources: requesterSources,
    transport,
    async decode(discovery) {
      // This operator's own catalog changing under it stays fatal rather than degrading the
      // source it was about to read (#2529) — same marking as `native-requester-decode.ts`.
      try {
        await input.trust.assertFresh();
      } catch (cause) {
        throw new NativeDiscoveryLocalAuthorityError({ cause });
      }
      const locations = discovery.announcement.locations ?? [];
      if (locations.length !== 1) {
        throw new Error('requester Submission must advertise exactly one public location');
      }
      const submissionBytes = await input.infrastructure.records.byLocation(
        locations[0]!.locator,
      );
      const signedFacts = object(discovery.announcement.facts ?? {}, 'requester facts');
      const association = object(signedFacts[ASSOCIATION], 'requester association');
      const authorityTime = parseNativeAuthorityTimeAnchor(association['authorityTime']);
      if (!await input.infrastructure.authorityTime.verifyFinalized(authorityTime)) {
        throw new Error('requester authority time is not canonical and finalized');
      }
      const terms = object(association['postingTerms'], 'requester posting terms');
      const canonical = await input.infrastructure.evaluator.canonicalTaskCreated({
        chainId: chainId(association['chainId'], 'chainId'),
        coordinator: association['coordinator'] as `0x${string}`,
        creator: association['creator'] as `0x${string}`,
        taskId: uint(association['taskId'], 'requester task id'),
        taskDigest: digest(association['taskDigest'], 'requester Task digest'),
        txHash: association['txHash'] as `0x${string}`,
        terms: {
          solutionMaxDeliveryRateWei: uint(terms['solutionMaxDeliveryRateWei'], 'solution rate'),
          verdictMaxDeliveryRateWei: uint(terms['verdictMaxDeliveryRateWei'], 'verdict rate'),
          responseTimeoutSeconds: uint(terms['responseTimeoutSeconds'], 'response timeout'),
          allowSolverSelfEvaluation: false,
        },
        maxClaims: 1,
      });
      // #2531 F4, evaluator read side: same split as `native-requester-decode.ts`. Both throw and
      // both degrade the source for the poll; only one of them is evidence of anything wrong.
      if (isAwaitingFinality(canonical)) {
        throw new Error(
          `requester association is mined at block ${canonical.blockNumber} but this evaluator's `
          + `finalized head is ${canonical.finalizedBlock}; re-reading at the next poll`,
        );
      }
      if (canonical === null) throw new Error('requester association has no canonical finalized TaskCreated');
      return decodeNativeRequesterAnnouncement({
        discovery,
        canonicalTaskCreated: canonical,
        submissionBytes,
      });
    },
  });
  const solver = createNativeDiscoveryConsumer({
    store: discoveryStore,
    sources: solverSources,
    transport,
    async decode(discovery): Promise<NativePublicRecordCard> {
      const locations = (discovery.announcement.locations ?? []).map(({ locator }) => locator);
      if (locations.length !== 1) throw new Error('solver record must advertise exactly one public location');
      return {
        record: {
          kind: discovery.announcement.record.kind,
          digest: discovery.announcement.record.digest,
        },
        facts: { ...(discovery.announcement.facts ?? {}), nativePublicLocations: locations },
      };
    },
  });
  const fetcher = recordFetcher({
    store: input.store,
    infrastructure: input.infrastructure,
    publicBases: input.sources.map(({ baseUrl }) => baseUrl),
  });

  /**
   * #2533, pass-level isolation — the same structural lesson as #2529/#2530, one layer up.
   *
   * These two passes were sequential and unguarded, so ANY requester-side throw skipped the
   * solver sync entirely. Live, the association-key collision threw on every tick, so operator A
   * never ingested a single one of B's records: 802 consecutive aborted ticks, the association
   * table pinned to task 1218, and leg 6 blocked no matter what B delivered. One source's problem
   * must not take out its sibling.
   *
   * Isolation, not suppression: both failures are still raised. The first is rethrown after both
   * passes have had their turn, so the caller sees a failing sync and the loop still reports the
   * problem — it just no longer costs the other source its progress.
   */
  const syncSignedSources = async () => runIsolatedPasses([
    {
      name: 'requester',
      run: async () => {
        await requester.sync();
        // #2539: per-CARD isolation inside the pass. Nothing acknowledges a card that failed to
        // index, so the queue is re-walked from the front every tick — one permanently-refusing
        // card at the head is a permanent wall in front of every card behind it. Live, card 2 of
        // the requester queue refused on the digest-keyed collision and cards 3+ were never
        // reached, which is why task 1221 was never enqueued at all.
        const failures = runIsolatedItems(requester.takePending(), {
          label: 'native-evaluator/requester',
          name: (card) => `announcement ${card.announcementId}`,
          run: (card) => { indexRequester(input.store, card, requesterConfigured[0]!.baseUrl); },
        });
        if (failures.length > 0) throw failures[0];
      },
    },
    {
      name: 'solver',
      run: async () => {
        await solver.sync();
        const failures = runIsolatedItems(solver.takePending(), {
          label: 'native-evaluator/solver',
          name: (card) => `announcement ${card.announcementId}`,
          run: (card) => {
            for (const location of cardLocations(card)) indexLocation(input.store, card, location);
          },
        });
        if (failures.length > 0) throw failures[0];
      },
    },
  ], { label: 'native-evaluator' });

  return {
    fetcher,
    syncSignedSources,
    association: (posting) => associationForPosting(input.store, posting),
    settlementDeclarationKey(deliveryDigest) {
      const row = input.store.db.prepare(
        `SELECT declaration_key FROM native_evaluator_settlement_declarations WHERE delivery_digest = ?`,
      ).get(deliveryDigest) as { declaration_key: string } | undefined;
      if (row === undefined) throw new Error(`no signed settlement declaration for ${deliveryDigest}`);
      return row.declaration_key;
    },
    deadline(posting, admittedAt) {
      const association = associationForPosting(input.store, posting);
      if (association === undefined) {
        throw new Error(
          `no signed requester deadline authority for task ${posting.taskId} on ${posting.coordinator}`,
        );
      }
      const base = Date.parse(admittedAt);
      if (!Number.isFinite(base)) throw new Error('evaluation admission time is invalid');
      const deadline = base + Number(association.responseTimeoutSeconds) * 1_000;
      if (!Number.isSafeInteger(deadline)) throw new Error('evaluation deadline exceeds JavaScript time bounds');
      return new Date(deadline).toISOString();
    },
    source: {
      sourceId: sourceId(solverConfigured[0]!),
      async read({ after }) {
        // #2539: ingest is isolated from the read it feeds — see `runIsolatedIngest` for why a
        // failed intake must not cost the checkpoint the material already verified into the index.
        await runIsolatedIngest([
          { name: 'signed-source ingest', run: syncSignedSources },
          { name: 'canonical venue sync', run: input.syncVenue },
        ], { label: 'native-evaluator' });
        const pending = solver.takePending();
        const groups = new Map<string, NativePublicRecordQueueItem[]>();
        for (const card of pending) {
          const key = engagement(card);
          groups.set(key, [...(groups.get(key) ?? []), card]);
        }
        const result: Array<Awaited<ReturnType<NativeEvaluatorOpportunitySource['read']>>[number]> = [];
        for (const withdrawal of solver.takePendingWithdrawals()) {
          if (!sequenceAfter(withdrawal.sequence, after?.sequence)) continue;
          const target = discoveryStore.db.prepare(
            `SELECT card_json FROM native_discovery_cards
              WHERE source_agent = ? AND source_name = ? AND announcement_id = ?
              ORDER BY id DESC LIMIT 1`,
          ).get(withdrawal.source.agent, withdrawal.source.name, withdrawal.retracts) as { card_json: string } | undefined;
          if (target === undefined) throw new Error('signed withdrawal target is absent from the authenticated source history');
          const targetCard = JSON.parse(target.card_json) as { record?: { digest?: unknown }; facts?: Record<string, unknown> };
          if (targetCard.facts?.['role'] !== 'delivery' || typeof targetCard.record?.digest !== 'string') continue;
          const evaluation = input.store.db.prepare(
            `SELECT canonical_event_identity FROM native_evaluations
              WHERE advertised_delivery_digest = ? ORDER BY created_at DESC LIMIT 1`,
          ).get(targetCard.record.digest) as { canonical_event_identity: string } | undefined;
          if (evaluation === undefined) continue;
          result.push({
            kind: 'solution-withdrawn',
            source: sourceId(solverConfigured[0]!),
            sourceSequence: withdrawal.sequence,
            sourceEntryDigest: withdrawal.entryDigest,
            canonicalEventIdentity: evaluation.canonical_event_identity,
            reason: withdrawal.reason,
          });
        }
        /**
         * One engagement's delivery/envelope pair, resolved to at most one source event.
         *
         * #2539: this is a function so its failures can be isolated per engagement. Everything it
         * refuses is refused for that engagement alone — a Delivery published before its envelope,
         * an attempt URI matching two postings, an ambiguous canonical correspondence. Every one of
         * those is a statement about ONE engagement's evidence, and every one of them used to take
         * the whole pass down with it, along with the checkpoint of every unrelated engagement in
         * the same tick.
         *
         * Those three refusals are deterministic, but this function also awaits two NETWORK reads —
         * `fetcher.byDigest` and `readCanonicalSolutionDelivery` — and those fail transiently and
         * independently per engagement, which is exactly the distribution that produces "A fails
         * while B succeeds". Isolation on its own would then lose A forever, so it is paired with
         * the checkpoint hold below; neither half is correct without the other.
         */
        const readGroup = async (cards: readonly NativePublicRecordQueueItem[]): Promise<void> => {
          const deliveries = cards.filter((card) => role(card) === 'delivery');
          const envelopes = cards.filter((card) => role(card) === 'delivery-envelope');
          if (deliveries.length !== 1 || envelopes.length !== 1) return;
          const deliveryCard = deliveries[0]!;
          indexSettlementDeclaration(input.store, deliveryCard);
          const deliveryProvenance = provenance(deliveryCard);
          if (!sequenceAfter(deliveryProvenance.sequence, after?.sequence)) return;
          const envelope = envelopes[0]!;
          if (BigInt(provenance(envelope).sequence) >= BigInt(deliveryProvenance.sequence)) {
            throw new Error('solver Delivery was not published after its exact envelope');
          }
          const deliveryBytes = await fetcher.byDigest(deliveryCard.card.record.digest);
          const delivery = exactDelivery(deliveryBytes, deliveryCard.card.record.digest);
          // #2533: a Delivery names only its Task digest, and a deterministic specification means
          // several postings share one. The attempt URI is the disambiguator — it is derived from
          // (chainId, coordinator, taskId, attemptIndex), so exactly one posting can produce the
          // attempt this Delivery claims. Nothing here selects a posting by recency or by "the
          // only row"; a candidate is kept only if the chain-derived attempt URI matches.
          const postings = associationsForTaskDigest(input.store, digest(delivery.task, 'Delivery Task digest'));
          if (postings.length === 0) return;
          const matched = postings.flatMap((candidate) =>
            input.events.solutionCandidates()
              .filter((event) => {
                const facts = event.facts as {
                  readonly taskId: bigint;
                  readonly attemptIndex: number;
                };
                return facts.taskId === candidate.taskId
                  && deriveMarketplaceAttemptUri({
                    chainId: candidate.chainId,
                    coordinator: candidate.coordinator,
                    taskId: candidate.taskId,
                    attemptIndex: facts.attemptIndex,
                  }) === delivery.attempt;
              })
              .map((event) => ({ association: candidate, event })));
          if (matched.length === 0) return;
          // Two postings answering one attempt URI would mean the derivation is not injective.
          // That is a substitution risk, not a routing detail, so it refuses rather than picking.
          const distinctPostings = new Set(matched.map(({ association: a }) => `${a.chainId}/${a.coordinator}/${a.taskId}`));
          if (distinctPostings.size !== 1) {
            throw new Error(
              `solver Delivery attempt ${delivery.attempt} matches ${distinctPostings.size} distinct postings`,
            );
          }
          const association = matched[0]!.association;
          const candidates = matched.map(({ event }) => event);
          const canonical = [] as Array<{
            readonly event: typeof candidates[number];
            readonly fact: NonNullable<Awaited<ReturnType<NonNullable<typeof input.infrastructure.evaluator>['readCanonicalSolutionDelivery']>>>;
          }>;
          for (const event of candidates) {
            const facts = event.facts as {
              readonly taskId: bigint;
              readonly attemptIndex: number;
              readonly requestId: `0x${string}`;
              readonly operator: `0x${string}`;
            };
            // eslint-disable-next-line no-await-in-loop -- ambiguity is security-sensitive and bounded by one Task.
            const fact = await input.infrastructure.evaluator.readCanonicalSolutionDelivery({
              chainId: 84532,
              coordinator: association.coordinator,
              router: input.jinnRouter,
              taskId: facts.taskId,
              attemptIndex: facts.attemptIndex,
              requestId: facts.requestId,
              operator: facts.operator,
              advertisedDeliveryDigest: deliveryCard.card.record.digest,
            });
            if (fact !== null) canonical.push({ event, fact });
          }
          if (canonical.length === 0) return;
          if (canonical.length !== 1) throw new Error('solution Delivery has ambiguous canonical chain correspondence');
          const joined = canonical[0]!;
          const facts = joined.event.facts as {
            readonly requestId: `0x${string}`;
            readonly operator: `0x${string}`;
          };
          const event = {
            ...joined.event,
            derivation: {
              ...joined.event.derivation,
              blockHash: joined.fact.blockHash,
              blockNumber: Number(joined.fact.blockNumber),
              txHash: joined.fact.transactionHash,
              finalityTier: 'finalized' as const,
            },
          };
          const references: SubjectMaterialReferences = {
            submission: { digest: association.submissionDigest },
            requesterEnvelope: { digest: association.requesterEnvelopeDigest },
            admissionReceipt: { digest: association.admissionReceiptDigest },
            deliveryEnvelope: { digest: envelope.card.record.digest },
          };
          result.push({
            kind: 'solution-available',
            observation: {
              source: sourceId(solverConfigured[0]!),
              sourceSequence: deliveryProvenance.sequence,
              sourceEntryDigest: deliveryProvenance.entryDigest,
              advertisedDeliveryDigest: deliveryCard.card.record.digest,
              canonical: true,
              event: {
                ...event,
                facts: { ...event.facts, requestId: facts.requestId, operator: facts.operator },
              },
            },
            references,
          });
        };
        /**
         * Where a failed engagement sits in the source's sequence, so the checkpoint can be held
         * at it. `0n` — hold everything — is the deliberate answer whenever that position cannot
         * be read, because a failure we cannot place is a failure we cannot safely skip past.
         */
        const groupSequence = (cards: readonly NativePublicRecordQueueItem[]): bigint => {
          try {
            const delivery = cards.find((card) => role(card) === 'delivery');
            return delivery === undefined ? 0n : BigInt(provenance(delivery).sequence);
          } catch {
            return 0n;
          }
        };
        const held: bigint[] = [];
        for (const [engagementId, cards] of groups.entries()) {
          try {
            // eslint-disable-next-line no-await-in-loop -- engagements share one store and one venue read.
            await readGroup(cards);
          } catch (cause) {
            const at = groupSequence(cards);
            held.push(at);
            console.error(
              `[native-evaluator] engagement ${engagementId} could not be read this pass — every `
              + `other engagement still ran, and the source checkpoint is HELD at sequence ${at} `
              + `until it does, so nothing at or above it is emitted: `
              + `${cause instanceof Error ? cause.message : String(cause)}`,
            );
          }
        }
        /**
         * The checkpoint hold — the half that makes per-engagement isolation safe.
         *
         * Isolation alone would lose a transient failure PERMANENTLY. The source checkpoint is one
         * scalar advanced per emitted event, and `sequenceAfter` is strict: engagement A failing at
         * sequence 5 on a 429 from a canonical read while B succeeds at 7 would emit B, advance the
         * checkpoint to 7, and filter A out of every subsequent pass. Both recovery locks are shut
         * behind that — `reconcileStartup()` walks evaluations that exist, and a never-admitted
         * opportunity has no row; and the state layer refuses late admission outright ("evaluation
         * source sequence did not advance"). For an evaluator that is a silently missing verdict,
         * which is strictly worse than the wedge the isolation removes.
         *
         * So: unrelated engagements BELOW a failure still progress, and nothing at or above one is
         * emitted. A permanently-refusing engagement therefore walls the ones above it — loudly,
         * with its sequence named on every pass — which is the stance `native-discovery.ts` already
         * takes for an announcement this consumer cannot decode: loud and stuck beats silent and
         * lossy. The retry story is simply the next poll.
         */
        const holdFrom = held.length === 0
          ? undefined
          : held.reduce((lowest, at) => (at < lowest ? at : lowest));
        const sequenceOf = (event: typeof result[number]): bigint =>
          BigInt(event.kind === 'solution-available' ? event.observation.sourceSequence : event.sourceSequence);
        const emitted = holdFrom === undefined
          ? result
          : result.filter((event) => sequenceOf(event) < holdFrom);
        if (holdFrom !== undefined && emitted.length !== result.length) {
          console.error(
            `[native-evaluator] holding ${result.length - emitted.length} readable source event(s) `
            + `at or above sequence ${holdFrom} until the engagement that failed there can be read`,
          );
        }
        return emitted.sort((left, right) => {
          const leftSequence = sequenceOf(left);
          const rightSequence = sequenceOf(right);
          return leftSequence < rightSequence ? -1 : leftSequence > rightSequence ? 1 : 0;
        });
      },
    },
  };
}
