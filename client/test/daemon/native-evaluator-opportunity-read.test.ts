/**
 * #2539, the read path — `buildNativeEvaluatorOpportunityReader(...).source.read()`, which had no
 * direct test of its own.
 *
 * Per-engagement isolation without a checkpoint hold loses a transient failure PERMANENTLY. The
 * source checkpoint is one scalar advanced per emitted event and `sequenceAfter` is strict, so
 * engagement A failing at sequence 5 on a 429 from a canonical read while B succeeds at 7 would
 * emit B, advance the checkpoint to 7, and filter A out of every later pass. Neither recovery lock
 * is open behind that: `reconcileStartup()` walks evaluations that EXIST and a never-admitted
 * opportunity has no row, and the state layer refuses late admission outright ("evaluation source
 * sequence did not advance"). For an evaluator that is a silently missing verdict.
 *
 * So the two properties here are inseparable, and both are asserted:
 *   - a readable engagement is read (the happy path — also previously untested);
 *   - when an engagement fails, nothing at or above its sequence is emitted, so the checkpoint is
 *     held and the failure is retried on the next poll rather than skipped past.
 *
 * The ingest steps are left to fail (no source is served in-process). That is deliberate and is
 * itself part of the contract under test: `read()` is derived entirely from the durable index, and
 * a failed intake must not stop it. Everything the read consumes is seeded into the two stores
 * exactly as a verified pass would have left it.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BASE_SEPOLIA_TODAY,
  deriveMarketplaceAttemptUri,
} from '@jinn-network/marketplace-binding';
import { documentDigest, sealDelivery } from '@jinn-network/task-execution-protocol';
import type {
  BindingResolver,
  DsseChainVerifier,
  PolicyCheckInput,
  WitnessVerifier,
} from '@jinn-network/trust-core';
import { Store } from '../../src/store/store.js';
import { NativeMarketplaceEventRepository } from '../../src/daemon/native-canonical-observations.js';
import {
  installAssociationSchema,
  upsertRequesterAssociation,
  type IndexedNativeRequesterAssociation,
} from '../../src/daemon/native-evaluator-association-index.js';
import { buildNativeEvaluatorOpportunityReader } from '../../src/daemon/native-evaluator-opportunity-source.js';
import type { NativeRecordSource } from '../../src/config/native-sections.js';
import type { NativeTrustAuthority } from '../../src/daemon/native-trust-catalog.js';

const COORDINATOR = BASE_SEPOLIA_TODAY.taskCoordinator as `0x${string}`;
const ROUTER = `0x${'7'.repeat(40)}` as const;
const OPERATOR = `0x${'1'.repeat(40)}` as const;
const REQUESTER_AGENT = 'urn:jinn:agent:requester-a';
const SOLVER_AGENT = 'urn:jinn:agent:solver-b';
const SOLVER_SOURCE_ID = `${SOLVER_AGENT}/solver-records`;
// The deterministic prediction specification: every posting of it seals to this one Task digest.
const TASK_DIGEST = `sha256:${'5f021ff3'.repeat(8)}` as const;

const SOURCES: readonly NativeRecordSource[] = [
  { role: 'requester', agent: REQUESTER_AGENT, name: 'requester-records', baseUrl: 'https://requester-a.example' },
  { role: 'solver', agent: SOLVER_AGENT, name: 'solver-records', baseUrl: 'https://solver-b.example' },
];

function fakeTrust(): NativeTrustAuthority {
  const bindingResolver: BindingResolver = { async resolveBinding() { return null; } };
  const witnessVerifier: WitnessVerifier = {
    async verify1271Witness() { return { verified: false, reason: 'fixture never verifies' }; },
  };
  const dsseVerifier: DsseChainVerifier = () => ({ validSignerKeyids: [] });
  return {
    bindingResolver,
    dsseVerifier,
    witnessVerifier,
    conflicts: [],
    newestPolicyVersion: 1,
    rawSignatureVerifier: { async verify() { return false; } },
    async assertFresh() { /* no-op fixture */ },
    candidateKeys() { return []; },
    policy(purpose) { return { accepted: [`accepted-for-${purpose}`], requiredStrength: 'strong' } as PolicyCheckInput; },
    async verifyRoleBinding() { return { bindingDigest: `sha256:${'0'.repeat(64)}` as const }; },
    async verifyOnchainAuthority() { return { bindingDigest: `sha256:${'0'.repeat(64)}` as const }; },
    resolverFor() { return bindingResolver; },
  } as unknown as NativeTrustAuthority;
}

/** One engagement: an on-chain posting, its Delivery bytes, and the two signed solver cards. */
interface Engagement {
  readonly taskId: bigint;
  readonly attemptIndex: number;
  readonly engagementId: string;
  readonly deliverySequence: string;
  readonly envelopeSequence: string;
  readonly deliveryBytes: Uint8Array;
  readonly deliveryDigest: `sha256:${string}`;
  readonly envelopeDigest: `sha256:${string}`;
  readonly requestId: `0x${string}`;
}

function engagement(input: {
  readonly taskId: bigint;
  readonly attemptIndex: number;
  readonly envelopeSequence: string;
  readonly deliverySequence: string;
}): Engagement {
  const deliveryBytes = sealDelivery({
    protocol: 'https://spec.jinn.network/profiles/task-execution/v1',
    attempt: deriveMarketplaceAttemptUri({
      chainId: 84532,
      coordinator: COORDINATOR,
      taskId: input.taskId,
      attemptIndex: input.attemptIndex,
    }),
    task: TASK_DIGEST,
    outputs: [],
    outcome: 'fulfilled',
    executionIds: [`urn:uuid:44444444-4444-4444-8444-${input.taskId.toString().padStart(12, '0')}`],
    evidenceRecords: [{ family: 'execution-evidence', digest: `sha256:${'2'.repeat(64)}` }],
    createdAt: '2026-08-07T00:00:00Z',
  });
  return {
    taskId: input.taskId,
    attemptIndex: input.attemptIndex,
    engagementId: `engagement-${input.taskId}`,
    deliverySequence: input.deliverySequence,
    envelopeSequence: input.envelopeSequence,
    deliveryBytes,
    deliveryDigest: documentDigest(deliveryBytes),
    envelopeDigest: `sha256:${input.taskId.toString(16).padStart(64, 'e')}` as `sha256:${string}`,
    requestId: `0x${input.taskId.toString(16).padStart(64, '2')}` as `0x${string}`,
  };
}

function association(taskId: bigint): IndexedNativeRequesterAssociation {
  return {
    taskDigest: TASK_DIGEST,
    submissionDigest: `sha256:${taskId.toString(16).padStart(64, 'a')}` as `sha256:${string}`,
    requesterEnvelopeDigest: `sha256:${taskId.toString(16).padStart(64, 'b')}` as `sha256:${string}`,
    admissionReceiptDigest: `sha256:${taskId.toString(16).padStart(64, 'c')}` as `sha256:${string}`,
    sealedAt: '2026-08-07T00:00:00.000Z',
    authorityTime: {
      chainId: 84532,
      blockNumber: '45192125',
      blockHash: `0x${'d'.repeat(64)}`,
      timestamp: '2026-08-07T00:00:00.000Z',
      finalized: true,
    },
    requesterAgent: REQUESTER_AGENT,
    chainId: 84532,
    coordinator: COORDINATOR,
    taskId,
    responseTimeoutSeconds: 3_600n,
  };
}

/** Exactly the row shape a verified solver pass leaves behind, queued and unacknowledged. */
function queueCard(store: Store, input: {
  readonly sequence: string;
  readonly announcementId: string;
  readonly card: unknown;
}): void {
  store.db.prepare(
    `INSERT INTO native_discovery_cards
       (source_agent, source_name, sequence, entry_digest, announcement_id, card_json, accepted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    SOLVER_AGENT,
    'solver-records',
    input.sequence,
    `sha256:${input.sequence.padStart(64, '0')}`,
    input.announcementId,
    JSON.stringify(input.card),
    '2026-08-07T00:00:00.000Z',
  );
}

function solverCard(input: {
  readonly digest: `sha256:${string}`;
  readonly role: 'delivery' | 'delivery-envelope';
  readonly engagementId: string;
  readonly sequence: string;
  readonly location: string;
}) {
  return {
    record: { kind: 'delivery', digest: input.digest },
    facts: {
      role: input.role,
      engagementId: input.engagementId,
      settlementDeclarationKey: 'did:key:zSolverSettlement',
      nativePublicLocations: [input.location],
    },
    discovery: {
      source: { agent: SOLVER_AGENT, name: 'solver-records' },
      sequence: input.sequence,
      entryDigest: `sha256:${input.sequence.padStart(64, '0')}`,
      signedHighWater: {
        sequence: input.sequence,
        entry: `sha256:${input.sequence.padStart(64, '0')}`,
        issuedAt: '2026-08-07T00:00:00.000Z',
        refreshBy: '2099-01-01T00:00:00.000Z',
        signature: {},
      },
    },
  };
}

function seedEngagement(store: Store, item: Engagement): void {
  upsertRequesterAssociation({
    store,
    association: association(item.taskId),
    provenance: {
      sourceId: `${REQUESTER_AGENT}/requester-records`,
      sequence: item.taskId.toString(),
      entryDigest: `sha256:${item.taskId.toString().padStart(64, '0')}`,
    },
  });
  queueCard(store, {
    sequence: item.envelopeSequence,
    announcementId: `${item.engagementId}-envelope`,
    card: solverCard({
      digest: item.envelopeDigest,
      role: 'delivery-envelope',
      engagementId: item.engagementId,
      sequence: item.envelopeSequence,
      location: `https://solver-b.example/records/${item.envelopeDigest.slice(7)}`,
    }),
  });
  queueCard(store, {
    sequence: item.deliverySequence,
    announcementId: `${item.engagementId}-delivery`,
    card: solverCard({
      digest: item.deliveryDigest,
      role: 'delivery',
      engagementId: item.engagementId,
      sequence: item.deliverySequence,
      location: `https://solver-b.example/records/${item.deliveryDigest.slice(7)}`,
    }),
  });
}

function seedCanonicalEvent(store: Store, item: Engagement): void {
  new NativeMarketplaceEventRepository(store).apply({
    events: [{
      event: 'SolutionDeliveryClaimed',
      facts: {
        operator: OPERATOR,
        requestId: item.requestId,
        taskId: item.taskId,
        attemptIndex: item.attemptIndex,
      },
      derivation: {
        chainId: 84532,
        contract: COORDINATOR,
        contractGeneration: 'today',
        event: 'SolutionDeliveryClaimed',
        blockHash: `0x${item.taskId.toString(16).padStart(64, 'a')}`,
        blockNumber: 100 + Number(item.taskId),
        txHash: `0x${item.taskId.toString(16).padStart(64, 'f')}`,
        logIndex: 4,
        finalityTier: 'safe',
      },
    } as never],
  });
}

describe('native evaluator opportunity read (#2539)', () => {
  let dir: string;
  let store: Store;
  let errors: string[];
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jinn-evaluator-read-'));
    store = new Store(join(dir, 'evaluator.db'));
    installAssociationSchema(store);
    errors = [];
    consoleError = vi.spyOn(console, 'error').mockImplementation((message: unknown) => {
      errors.push(String(message));
    });
  });

  afterEach(() => {
    consoleError.mockRestore();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function reader(input: {
    readonly readCanonicalSolutionDelivery: (expected: { readonly taskId: bigint }) => Promise<unknown>;
    readonly byDigest?: (digest: `sha256:${string}`) => Promise<Uint8Array>;
  }) {
    const bytes = new Map<`sha256:${string}`, Uint8Array>();
    for (const item of engagements) bytes.set(item.deliveryDigest, item.deliveryBytes);
    return buildNativeEvaluatorOpportunityReader({
      sources: SOURCES,
      jinnRouter: ROUTER,
      store,
      trust: fakeTrust(),
      events: new NativeMarketplaceEventRepository(store),
      syncVenue: async () => undefined,
      infrastructure: {
        records: {
          byLocation: async () => { throw new Error('no public replica in this fixture'); },
          byDigest: input.byDigest ?? (async (digest) => {
            const found = bytes.get(digest);
            if (found === undefined) throw new Error(`no bytes for ${digest}`);
            return found;
          }),
        },
        authorityTime: { verifyFinalized: async () => true },
        evaluator: {
          canonicalTaskCreated: async () => { throw new Error('unused in this fixture'); },
          readCanonicalSolutionDelivery: input.readCanonicalSolutionDelivery,
          chain: {} as never,
          preSettlementClaimTime: async () => '2026-08-07T00:00:00.000Z',
          blockTime: async () => '2026-08-07T00:00:00.000Z',
        } as never,
      },
    });
  }

  const engagements = [
    engagement({ taskId: 1220n, attemptIndex: 0, envelopeSequence: '4', deliverySequence: '5' }),
    engagement({ taskId: 1221n, attemptIndex: 0, envelopeSequence: '6', deliverySequence: '7' }),
  ];
  const [lower, higher] = engagements as [Engagement, Engagement];

  const finalized = (item: Engagement) => ({
    transactionHash: `0x${item.taskId.toString(16).padStart(64, 'f')}` as `0x${string}`,
    blockHash: `0x${item.taskId.toString(16).padStart(64, 'a')}` as `0x${string}`,
    blockNumber: BigInt(100 + Number(item.taskId)),
    finalized: true as const,
  });

  // The happy path, which had no direct test at all before this file.
  it('reads a canonically-joined engagement into one solution-available event', async () => {
    for (const item of [lower]) {
      seedEngagement(store, item);
      seedCanonicalEvent(store, item);
    }
    const built = await reader({
      readCanonicalSolutionDelivery: async () => finalized(lower),
    });

    const events = await built.source.read({});

    expect(events).toHaveLength(1);
    const [event] = events as [Extract<typeof events[number], { kind: 'solution-available' }>];
    expect(event.kind).toBe('solution-available');
    expect(event.observation.source).toBe(SOLVER_SOURCE_ID);
    expect(event.observation.sourceSequence).toBe(lower.deliverySequence);
    expect(event.observation.advertisedDeliveryDigest).toBe(lower.deliveryDigest);
    expect(event.observation.canonical).toBe(true);
    expect(event.references.deliveryEnvelope.digest).toBe(lower.envelopeDigest);
    // No source is served in-process, so the ingest brought in nothing this pass — the read is
    // derived entirely from the durable index, and nothing is held.
    expect(errors.filter((line) => line.includes('HELD'))).toStrictEqual([]);
  });

  /**
   * THE REGRESSION. Engagement 1220 fails at sequence 5 on a transient canonical read while 1221
   * succeeds at 7. Emitting 1221 would advance the checkpoint past 5 and lose 1220 forever, so
   * NOTHING is emitted: the checkpoint is held at 5 and both are re-read on the next poll.
   *
   * Delete the hold and this goes green with `[1221]` — which is the silently missing verdict.
   */
  it('holds the checkpoint at a failed engagement rather than emitting past it', async () => {
    for (const item of engagements) {
      seedEngagement(store, item);
      seedCanonicalEvent(store, item);
    }
    const built = await reader({
      readCanonicalSolutionDelivery: async (expected) => {
        if (expected.taskId === lower.taskId) throw new Error('HTTP 429 from the canonical read');
        return finalized(higher);
      },
    });

    await expect(built.source.read({})).resolves.toStrictEqual([]);

    expect(errors.some((line) => line.includes(`checkpoint is HELD at sequence ${lower.deliverySequence}`))).toBe(true);
    expect(errors.some((line) => line.includes('HTTP 429 from the canonical read'))).toBe(true);
    expect(errors.some((line) => line.includes(`holding 1 readable source event(s) at or above sequence ${lower.deliverySequence}`))).toBe(true);
  });

  // The isolation half is still real: a failure ABOVE a readable engagement costs it nothing.
  it('still emits engagements below the failure', async () => {
    for (const item of engagements) {
      seedEngagement(store, item);
      seedCanonicalEvent(store, item);
    }
    const built = await reader({
      readCanonicalSolutionDelivery: async (expected) => {
        if (expected.taskId === higher.taskId) throw new Error('HTTP 429 from the canonical read');
        return finalized(lower);
      },
    });

    const events = await built.source.read({});

    expect(events).toHaveLength(1);
    expect((events[0] as { observation: { sourceSequence: string } }).observation.sourceSequence)
      .toBe(lower.deliverySequence);
    expect(errors.some((line) => line.includes(`checkpoint is HELD at sequence ${higher.deliverySequence}`))).toBe(true);
  });

  /**
   * A failure whose position in the source sequence cannot be read holds EVERYTHING. There is no
   * safe partial answer: a failure we cannot place is a failure we cannot place a checkpoint above.
   */
  it('holds everything when a failed engagement cannot be placed in the sequence', async () => {
    seedEngagement(store, lower);
    seedCanonicalEvent(store, lower);
    // A card whose signed role is unreadable: it groups, but nothing about it can be located.
    queueCard(store, {
      sequence: '9',
      announcementId: 'broken-delivery',
      card: {
        record: { kind: 'delivery', digest: `sha256:${'9'.repeat(64)}` },
        facts: { engagementId: 'engagement-broken', nativePublicLocations: ['https://solver-b.example/x'] },
        discovery: solverCard({
          digest: `sha256:${'9'.repeat(64)}`,
          role: 'delivery',
          engagementId: 'engagement-broken',
          sequence: '9',
          location: 'https://solver-b.example/x',
        }).discovery,
      },
    });
    const built = await reader({ readCanonicalSolutionDelivery: async () => finalized(lower) });

    await expect(built.source.read({})).resolves.toStrictEqual([]);
    expect(errors.some((line) => line.includes('checkpoint is HELD at sequence 0'))).toBe(true);
  });
});
