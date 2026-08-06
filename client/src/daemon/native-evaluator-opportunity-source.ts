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
  parseNativeAuthorityTimeAnchor,
  type NativeAuthorityTimeAnchor,
} from '../native-requester/requester.js';
import type { FetchBytesByDigest, SubjectMaterialReferences } from '../evaluator/subject-material.js';
import type { Store } from '../store/store.js';
import type { NativeMarketplaceEventRepository } from './native-canonical-observations.js';
import { buildNativeDiscoverySources } from './native-discovery-trust.js';
import {
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

export interface IndexedNativeRequesterAssociation {
  readonly taskDigest: `sha256:${string}`;
  readonly submissionDigest: `sha256:${string}`;
  readonly requesterEnvelopeDigest: `sha256:${string}`;
  readonly admissionReceiptDigest: `sha256:${string}`;
  readonly sealedAt: string;
  readonly authorityTime: NativeAuthorityTimeAnchor;
  readonly requesterAgent: string;
  readonly chainId: 84532;
  readonly coordinator: `0x${string}`;
  readonly taskId: bigint;
  readonly responseTimeoutSeconds: bigint;
}

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
  const chainId = Number(value['chainId']);
  if (chainId !== 84532) throw new Error('requester association is not Base Sepolia');
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
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS native_evaluator_public_records (
      record_digest TEXT NOT NULL,
      location      TEXT NOT NULL,
      source_id     TEXT NOT NULL,
      source_sequence TEXT NOT NULL,
      entry_digest  TEXT NOT NULL,
      PRIMARY KEY (record_digest, location)
    );
    CREATE TABLE IF NOT EXISTS native_evaluator_requester_associations (
      task_digest TEXT PRIMARY KEY,
      association_json TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_sequence TEXT NOT NULL,
      entry_digest TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS native_evaluator_settlement_declarations (
      delivery_digest TEXT PRIMARY KEY,
      declaration_key TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_sequence TEXT NOT NULL,
      entry_digest TEXT NOT NULL
    );
  `);
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
  const existing = store.db.prepare(
    `SELECT source_id, source_sequence, entry_digest FROM native_evaluator_public_records
      WHERE record_digest = ? AND location = ?`,
  ).get(card.card.record.digest, location) as {
    source_id: string;
    source_sequence: string;
    entry_digest: string;
  } | undefined;
  const signedSource = `${origin.source.agent}/${origin.source.name}`;
  if (existing !== undefined) {
    if (existing.source_id !== signedSource
      || existing.source_sequence !== origin.sequence
      || existing.entry_digest !== origin.entryDigest) {
      throw new Error(`public record ${card.card.record.digest} changed signed provenance`);
    }
    return;
  }
  store.db.prepare(
    `INSERT INTO native_evaluator_public_records
      (record_digest, location, source_id, source_sequence, entry_digest) VALUES (?, ?, ?, ?, ?)`,
  ).run(card.card.record.digest, location, signedSource, origin.sequence, origin.entryDigest);
}

function indexRequester(store: Store, card: NativeDiscoveryQueuedCard, configuredBase: string): void {
  const association = parseAssociation(card);
  const origin = provenance(card);
  const id = `${origin.source.agent}/${origin.source.name}`;
  const encoded = JSON.stringify({
    ...association,
    taskId: association.taskId.toString(10),
    responseTimeoutSeconds: association.responseTimeoutSeconds.toString(10),
  });
  const existing = store.db.prepare(
    `SELECT association_json, source_id, source_sequence, entry_digest
       FROM native_evaluator_requester_associations WHERE task_digest = ?`,
  ).get(association.taskDigest) as {
    association_json: string;
    source_id: string;
    source_sequence: string;
    entry_digest: string;
  } | undefined;
  if (existing !== undefined && (existing.association_json !== encoded
    || existing.source_id !== id
    || existing.source_sequence !== origin.sequence
    || existing.entry_digest !== origin.entryDigest)) {
    throw new Error(`requester association ${association.taskDigest} changed signed facts`);
  }
  if (existing === undefined) {
    store.db.prepare(
      `INSERT INTO native_evaluator_requester_associations
        (task_digest, association_json, source_id, source_sequence, entry_digest)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(association.taskDigest, encoded, id, origin.sequence, origin.entryDigest);
  }
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

function associationFor(store: Store, taskDigest: `sha256:${string}`): IndexedNativeRequesterAssociation | undefined {
  const row = store.db.prepare(
    `SELECT association_json FROM native_evaluator_requester_associations WHERE task_digest = ?`,
  ).get(taskDigest) as { association_json: string } | undefined;
  if (row === undefined) return undefined;
  const value = JSON.parse(row.association_json) as Omit<IndexedNativeRequesterAssociation, 'taskId' | 'responseTimeoutSeconds'> & {
    readonly taskId: string;
    readonly responseTimeoutSeconds: string;
  };
  return {
    ...value,
    taskId: BigInt(value.taskId),
    responseTimeoutSeconds: BigInt(value.responseTimeoutSeconds),
  };
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
    const rows = input.store.db.prepare(
      `SELECT location FROM native_evaluator_public_records WHERE record_digest = ? ORDER BY location`,
    ).all(expected) as Array<{ location: string }>;
    const locations = [...new Set([
      ...rows.map(({ location }) => location),
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
  association(taskDigest: `sha256:${string}`): IndexedNativeRequesterAssociation | undefined;
  settlementDeclarationKey(deliveryDigest: `sha256:${string}`): string;
  deadline(taskDigest: `sha256:${string}`, admittedAt: string): string;
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
  const requesterSources = await buildNativeDiscoverySources({
    configured: requesterConfigured,
    store: discoveryStore,
    transport,
    trust: input.trust,
  });
  const solverSources = await buildNativeDiscoverySources({
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
      await input.trust.assertFresh();
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
        chainId: Number(association['chainId']),
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

  const syncSignedSources = async () => {
    await requester.sync();
    for (const card of requester.takePending()) {
      indexRequester(input.store, card, requesterConfigured[0]!.baseUrl);
    }
    await solver.sync();
    for (const card of solver.takePending()) {
      for (const location of cardLocations(card)) indexLocation(input.store, card, location);
    }
  };

  return {
    fetcher,
    syncSignedSources,
    association: (taskDigest) => associationFor(input.store, taskDigest),
    settlementDeclarationKey(deliveryDigest) {
      const row = input.store.db.prepare(
        `SELECT declaration_key FROM native_evaluator_settlement_declarations WHERE delivery_digest = ?`,
      ).get(deliveryDigest) as { declaration_key: string } | undefined;
      if (row === undefined) throw new Error(`no signed settlement declaration for ${deliveryDigest}`);
      return row.declaration_key;
    },
    deadline(taskDigest, admittedAt) {
      const association = associationFor(input.store, taskDigest);
      if (association === undefined) throw new Error(`no signed requester deadline authority for ${taskDigest}`);
      const base = Date.parse(admittedAt);
      if (!Number.isFinite(base)) throw new Error('evaluation admission time is invalid');
      const deadline = base + Number(association.responseTimeoutSeconds) * 1_000;
      if (!Number.isSafeInteger(deadline)) throw new Error('evaluation deadline exceeds JavaScript time bounds');
      return new Date(deadline).toISOString();
    },
    source: {
      sourceId: sourceId(solverConfigured[0]!),
      async read({ after }) {
        await syncSignedSources();
        await input.syncVenue();
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
        for (const cards of groups.values()) {
          const deliveries = cards.filter((card) => role(card) === 'delivery');
          const envelopes = cards.filter((card) => role(card) === 'delivery-envelope');
          if (deliveries.length !== 1 || envelopes.length !== 1) continue;
          const deliveryCard = deliveries[0]!;
          indexSettlementDeclaration(input.store, deliveryCard);
          const deliveryProvenance = provenance(deliveryCard);
          if (!sequenceAfter(deliveryProvenance.sequence, after?.sequence)) continue;
          const envelope = envelopes[0]!;
          if (BigInt(provenance(envelope).sequence) >= BigInt(deliveryProvenance.sequence)) {
            throw new Error('solver Delivery was not published after its exact envelope');
          }
          const deliveryBytes = await fetcher.byDigest(deliveryCard.card.record.digest);
          const delivery = exactDelivery(deliveryBytes, deliveryCard.card.record.digest);
          const association = associationFor(input.store, digest(delivery.task, 'Delivery Task digest'));
          if (association === undefined) continue;
          const candidates = input.events.solutionCandidates().filter((event) => {
            const facts = event.facts as {
              readonly taskId: bigint;
              readonly attemptIndex: number;
            };
            return facts.taskId === association.taskId
              && deriveMarketplaceAttemptUri({
                chainId: association.chainId,
                coordinator: association.coordinator,
                taskId: association.taskId,
                attemptIndex: facts.attemptIndex,
              }) === delivery.attempt;
          });
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
          if (canonical.length === 0) continue;
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
        }
        return result.sort((left, right) => {
          const leftSequence = left.kind === 'solution-available' ? left.observation.sourceSequence : left.sourceSequence;
          const rightSequence = right.kind === 'solution-available' ? right.observation.sourceSequence : right.sourceSequence;
          return BigInt(leftSequence) < BigInt(rightSequence) ? -1 : BigInt(leftSequence) > BigInt(rightSequence) ? 1 : 0;
        });
      },
    },
  };
}
