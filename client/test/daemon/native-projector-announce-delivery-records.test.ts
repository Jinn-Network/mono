/**
 * Defect #45 regression: the native announce path could never publish a verdict announcement.
 *
 * The ratified DR-2026-08-05 G-loop criterion is a verdict announcement with
 * `decisionGrade: true` plus a requester-side adopted delivery
 * (`log/decisions/2026-08-05-cutover-one-swap-collapse.md`). `projectAnnouncements`'s
 * `VerdictDeliveryClaimed` leg calls `resolveRecord(event, 'evaluation-delivery')` BEFORE it ever
 * runs the verdict gate, and the native composition's resolver implemented only `'submission'` —
 * it threw for both delivery roles. `projector-loop.ts` catches that throw as non-fatal and
 * advances the cursor, so every announcement was suppressed with no loud signal.
 *
 * These tests drive the PRODUCTION resolver (`buildNativeResolveRecord`), the PRODUCTION serving-
 * plane reader (`buildFleetDeliveryBytesResolver`), the PRODUCTION announce-port assembly
 * (`buildAnnouncementProjectionPorts`), and the REAL reducer + announce plane over a full
 * revised-generation settlement sequence.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import {
  BASE_SEPOLIA_TODAY,
  REVISED_LEG_SOLUTION,
  REVISED_LEG_VERDICT,
  deriveMarketplaceAttemptUri,
  encodeRevisedRequestData,
  keccakEvidenceHash,
} from '@jinn-network/marketplace-binding';
import {
  createMarketplaceProjectionState,
  projectAnnouncements,
  reduceMarketplaceProjection,
  type MarketplaceEvent,
  type ObservationMarketplaceEvent,
  type ScopedDiscoverySigner,
} from '@jinn-network/marketplace-projector';
import {
  DISCOVERY_SIGNING_SCOPE,
  RECORD_KINDS,
  recordPath,
} from '@jinn-network/record-discovery-protocol';
import { documentDigest } from '@jinn-network/task-execution-protocol';
import {
  NativeAnnouncementRecordError,
  buildNativeResolveRecord,
  buildRecordPlaneCounterpartyDeliveryResolver,
} from '../../src/daemon/composition-root.js';
import {
  buildFleetDeliveryBytesResolver,
  buildFleetOwnSolutionDeliveryResolver,
} from '../../src/daemon/native-fleet-runtime.js';
import {
  buildNativeEvaluationDeliveryRecordResolver,
  buildNativeVerdictObservationAdapter,
} from '../../src/daemon/native-verdict-observation.js';
import { buildAnnouncementProjectionPorts } from '../../src/daemon/projector-ports.js';

const COORDINATOR = BASE_SEPOLIA_TODAY.taskCoordinator;
const OPERATOR = '0x2222222222222222222222222222222222222222' satisfies Address;
const EVALUATOR = '0x3333333333333333333333333333333333333333' satisfies Address;
const CREATOR = '0x4444444444444444444444444444444444444444' satisfies Address;
const SOLUTION_REQUEST_ID = `0x${'51'.repeat(32)}` satisfies Hex;
const VERDICT_REQUEST_ID = `0x${'52'.repeat(32)}` satisfies Hex;
const TASK_ID = 42n;
const ATTEMPT_INDEX = 3;
const VERDICT_INDEX = 1;
/** `decisionGradeVerdictCode` pass. */
const VERDICT_CODE = 1;
const SELF_BASE_URL = 'https://operator-a.example/archive';
const PEER_BASE_URL = 'https://operator-b.example/archive';

// --- Documents. Every anchor below is DERIVED from the bytes, so the chain names exactly what the
// serving plane holds — the same content-addressed join the announce plane re-checks. ---

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function bytes32(digest: `sha256:${string}`): Hex {
  return `0x${digest.slice('sha256:'.length)}` as Hex;
}

const SUBMISSION_BYTES = encodeJson({
  protocol: 'https://spec.jinn.network/profiles/task-execution/v1',
  task: `sha256:${'7'.repeat(64)}`,
});
const SUBMISSION_DIGEST = documentDigest(SUBMISSION_BYTES);

function deliveryDocument(attempt: string, summary: string): Uint8Array {
  return encodeJson({
    protocol: 'https://spec.jinn.network/profiles/task-execution/v1',
    attempt,
    task: `sha256:${'7'.repeat(64)}`,
    outputs: [],
    outcome: 'fulfilled',
    summary,
    createdAt: '2026-08-05T12:00:00Z',
  });
}

const SOLUTION_DELIVERY_BYTES = deliveryDocument(
  'urn:uuid:11111111-1111-4111-8111-111111111111',
  'solution delivery',
);
const SOLUTION_DELIVERY_DIGEST = documentDigest(SOLUTION_DELIVERY_BYTES);
const EVALUATION_DELIVERY_BYTES = deliveryDocument(
  'urn:uuid:22222222-2222-4222-8222-222222222222',
  'evaluation delivery',
);
const EVALUATION_DELIVERY_DIGEST = documentDigest(EVALUATION_DELIVERY_BYTES);

// --- Event fixtures (the revised settlement sequence; see observe.ts's VerdictDeliveryClaimed
// case for every cross-check the binding must satisfy). ---

function derivation(
  event: string,
  blockNumber: number,
  logIndex = 0,
  contract: Address = BASE_SEPOLIA_TODAY.jinnRouter,
) {
  return {
    chainId: BASE_SEPOLIA_TODAY.chainId,
    contract,
    event,
    blockNumber,
    blockHash: `0x${blockNumber.toString(16).padStart(64, '0')}` as Hex,
    txHash: `0x${blockNumber.toString(16).padStart(63, '0')}f` as Hex,
    logIndex,
    finalityTier: 'finalized' as const,
    contractGeneration: 'revised' as const,
  };
}

function projectable(
  event: MarketplaceEvent,
  overrides: Record<string, unknown> = {},
): ObservationMarketplaceEvent {
  return {
    ...event,
    projection: {
      taskCoordinator: COORDINATOR,
      timestamp: '2026-08-05T12:00:00Z',
      submission: 'urn:uuid:11111111-1111-4111-8111-111111111111',
      taskDigest: `sha256:${'7'.repeat(64)}`,
      effectiveDeadline: '2026-08-06T12:00:00Z',
      dispatchContext: {
        uri: `urn:jinn:marketplace:dispatch-context:${TASK_ID}:${ATTEMPT_INDEX}`,
        digest: { sha256: '8'.repeat(64) },
      },
      ...overrides,
    },
  } as ObservationMarketplaceEvent;
}

/** The full revised settlement sequence, ending in the verdict-settlement event under test. */
function settlementSequence(): readonly ObservationMarketplaceEvent[] {
  const verdictReceipt = derivation('VerdictDeliveryPrepared', 210);
  const solutionReceipt = derivation('SolutionDeliveryPrepared', 202);
  return [
    projectable({
      event: 'TaskCreated',
      facts: {
        creator: CREATOR,
        taskCidDigest: `0x${'7'.repeat(64)}` as Hex,
        submissionDigest: bytes32(SUBMISSION_DIGEST),
        taskId: TASK_ID,
        maxTotal: 2,
        maxConcurrent: 1,
        submissionDeadline: 1_800_000_000n,
        closeAt: 0n,
        responseTimeout: 3600n,
        minVerdicts: 1,
        requireDistinctEvaluator: true,
        solutionMaxDeliveryRate: 10n,
        verdictMaxDeliveryRate: 20n,
        solutionBudget: 20n,
        verdictBudget: 40n,
      },
      derivation: derivation('TaskCreated', 200),
    } as MarketplaceEvent),
    projectable({
      event: 'TaskAttemptCreated',
      facts: {
        taskId: TASK_ID,
        attemptIndex: ATTEMPT_INDEX,
        operator: OPERATOR,
        priorityMech: OPERATOR,
        attemptDeadline: 1_800_000_001n,
        deliveryRate: 10n,
      },
      derivation: derivation('TaskAttemptCreated', 201),
    } as MarketplaceEvent),
    projectable({
      event: 'SolutionDeliveryPrepared',
      facts: {
        operator: OPERATOR,
        expectedRequestId: SOLUTION_REQUEST_ID,
        taskId: TASK_ID,
        attemptIndex: ATTEMPT_INDEX,
        nonce: 7n,
        deliveryDigest: bytes32(SOLUTION_DELIVERY_DIGEST),
      },
      derivation: solutionReceipt,
    } as MarketplaceEvent),
    projectable({
      event: 'Deliver',
      facts: {
        mech: OPERATOR,
        mechServiceMultisig: OPERATOR,
        requestId: SOLUTION_REQUEST_ID,
        deliveryRate: 10n,
        requestData: encodeRevisedRequestData({
          legKind: REVISED_LEG_SOLUTION,
          taskId: TASK_ID,
          attemptIndex: ATTEMPT_INDEX,
          verdictIndex: 0,
          deliveryDigest: bytes32(SOLUTION_DELIVERY_DIGEST),
          verdictCode: 0,
        }),
        deliveryData: `0x${'a'.repeat(64)}` as Hex,
      },
      derivation: { ...solutionReceipt, event: 'Deliver', logIndex: 1, contract: OPERATOR },
    } as MarketplaceEvent),
    projectable({
      event: 'SolutionDeliveryClaimed',
      facts: {
        operator: OPERATOR,
        requestId: SOLUTION_REQUEST_ID,
        taskId: TASK_ID,
        attemptIndex: ATTEMPT_INDEX,
        deliveryDigest: bytes32(SOLUTION_DELIVERY_DIGEST),
      },
      derivation: { ...solutionReceipt, event: 'SolutionDeliveryClaimed', logIndex: 2 },
    } as MarketplaceEvent),
    projectable({
      event: 'EvaluationAttemptCreated',
      facts: {
        taskId: TASK_ID,
        attemptIndex: ATTEMPT_INDEX,
        verdictIndex: VERDICT_INDEX,
        evaluator: EVALUATOR,
        priorityMech: EVALUATOR,
        attemptDeadline: 1_800_000_002n,
        deliveryRate: 20n,
      },
      derivation: derivation('EvaluationAttemptCreated', 205),
    } as MarketplaceEvent),
    projectable({
      event: 'VerdictDeliveryPrepared',
      facts: {
        evaluator: EVALUATOR,
        expectedRequestId: VERDICT_REQUEST_ID,
        taskId: TASK_ID,
        attemptIndex: ATTEMPT_INDEX,
        verdictIndex: VERDICT_INDEX,
        nonce: 8n,
        deliveryDigest: bytes32(EVALUATION_DELIVERY_DIGEST),
        verdictCode: VERDICT_CODE,
      },
      derivation: verdictReceipt,
    } as MarketplaceEvent),
    projectable({
      event: 'Deliver',
      facts: {
        mech: EVALUATOR,
        mechServiceMultisig: EVALUATOR,
        requestId: VERDICT_REQUEST_ID,
        deliveryRate: 20n,
        requestData: encodeRevisedRequestData({
          legKind: REVISED_LEG_VERDICT,
          taskId: TASK_ID,
          attemptIndex: ATTEMPT_INDEX,
          verdictIndex: VERDICT_INDEX,
          deliveryDigest: bytes32(EVALUATION_DELIVERY_DIGEST),
          verdictCode: VERDICT_CODE,
        }),
        deliveryData: `0x${'e'.repeat(64)}` as Hex,
      },
      derivation: { ...verdictReceipt, event: 'Deliver', logIndex: 1, contract: EVALUATOR },
    } as MarketplaceEvent),
    projectable({
      event: 'VerdictDeliveryClaimed',
      facts: {
        evaluator: EVALUATOR,
        requestId: VERDICT_REQUEST_ID,
        taskId: TASK_ID,
        attemptIndex: ATTEMPT_INDEX,
        verdictIndex: VERDICT_INDEX,
        evaluationDeliveryDigest: bytes32(EVALUATION_DELIVERY_DIGEST),
        verdictCode: VERDICT_CODE,
      },
      derivation: { ...verdictReceipt, event: 'VerdictDeliveryClaimed', logIndex: 2 },
    } as MarketplaceEvent),
  ];
}

/**
 * A native serving plane: an in-memory stand-in for the HTTP archive
 * `native-fleet-serving-plane.ts` mounts under one origin. `byLocation` is the exact seam the
 * production `NativePublicRecordTransport` exposes, so `buildFleetDeliveryBytesResolver` runs
 * unmodified against it.
 */
function servingPlane(records: ReadonlyMap<string, Uint8Array>) {
  const requested: string[] = [];
  return {
    requested,
    byLocation: async (url: string): Promise<Uint8Array> => {
      requested.push(url);
      const bytes = records.get(url);
      if (bytes === undefined) throw new Error(`404 ${url}`);
      return bytes;
    },
  };
}

function servedAt(base: string, ...documents: readonly Uint8Array[]): Map<string, Uint8Array> {
  return new Map(documents.map((bytes) => [`${base}${recordPath(documentDigest(bytes))}`, bytes]));
}

function fakeDiscoverySigner(): ScopedDiscoverySigner {
  return {
    scope: DISCOVERY_SIGNING_SCOPE,
    async sign() {
      return [{ keyid: 'test-key', sig: new Uint8Array(64) }];
    },
  };
}

let archiveRoot: string;
beforeEach(() => {
  archiveRoot = mkdtempSync(join(tmpdir(), 'native-announce-'));
});
afterEach(() => {
  rmSync(archiveRoot, { recursive: true, force: true });
});

function announcePorts(input: {
  readonly resolveRecord: ReturnType<typeof buildNativeResolveRecord>;
  readonly decisionGrade?: boolean;
  /** Drive the REAL M4b gate instead of the stub — see the today-generation suite below. */
  readonly verifyVerdictObservation?: (
    event: never,
    material: { readonly kind: string; readonly bytes: Uint8Array },
  ) => Promise<unknown>;
}) {
  const pageCounts = new Map<string, number>();
  const verified: unknown[] = [];
  const gate = input.verifyVerdictObservation;
  return {
    verified,
    ports: buildAnnouncementProjectionPorts({
      source: { agent: 'urn:jinn:operator:test', name: 'operator-projector' },
      signer: fakeDiscoverySigner(),
      archiveRoot,
      resolveRecord: input.resolveRecord,
      verifyVerdictObservation: async (event, material) => {
        verified.push(material);
        if (gate !== undefined) return await gate(event as never, material) as never;
        return {
          gate: { decisionGrade: input.decisionGrade ?? true, failures: [] },
          statementVerdict: 'pass' as const,
        };
      },
      referencedBytes: { fetch: async () => undefined },
      readPageCount: () => pageCounts.get('operator-projector') ?? 0,
      writePageCount: (count: number) => pageCounts.set('operator-projector', count),
    }, {}),
  };
}

/** The production resolver wired exactly as `native-fleet-runtime.ts` wires it. */
function nativeResolveRecord(plane: ReturnType<typeof servingPlane>) {
  return buildNativeResolveRecord(
    BASE_SEPOLIA_TODAY,
    async () => SUBMISSION_BYTES,
    buildFleetDeliveryBytesResolver(plane.byLocation, [SELF_BASE_URL, PEER_BASE_URL]),
  );
}

describe('native announce path — delivery record resolution (#45)', () => {
  it('publishes a decision-grade verdict announcement from records served on the native plane', async () => {
    const plane = servingPlane(new Map([
      ...servedAt(SELF_BASE_URL, SOLUTION_DELIVERY_BYTES),
      // The peer operator's evaluation delivery — the two-operator G-loop shape.
      ...servedAt(PEER_BASE_URL, EVALUATION_DELIVERY_BYTES),
    ]));
    const { ports, verified } = announcePorts({ resolveRecord: nativeResolveRecord(plane) });

    const transition = reduceMarketplaceProjection(
      settlementSequence(),
      createMarketplaceProjectionState(),
    );
    const result = await projectAnnouncements(transition, ports);

    // The reducer reached the verdict-settlement observation the announce leg gates on.
    expect(transition.observations.some(
      (observation) => observation.type === 'network.jinn.task-execution.attempt-terminal.v1'
        && observation.derivation.event === 'VerdictDeliveryClaimed',
    )).toBe(true);

    // RED BEFORE THIS FIX: `resolveRecord` threw for 'delivery' and 'evaluation-delivery', so
    // `projectAnnouncements` threw and the loop published nothing at all.
    expect(result.refusals).toEqual([]);
    const verdictAnnouncement = result.announcements.find(
      (announcement) => announcement.action === 'available'
        && announcement.derivation.event === 'VerdictDeliveryClaimed',
    );
    expect(verdictAnnouncement).toBeDefined();
    expect(verdictAnnouncement).toMatchObject({
      record: { kind: RECORD_KINDS.delivery, digest: EVALUATION_DELIVERY_DIGEST },
      facts: {
        'https://spec.jinn.network/facts/marketplace-verdict-correspondence/v1': {
          onChainVerdictCode: VERDICT_CODE,
          statementVerdict: 'pass',
        },
      },
    });
    // The gate ran against the EXACT resolved material, not a re-fetch.
    expect(verified).toEqual([{ kind: RECORD_KINDS.delivery, bytes: EVALUATION_DELIVERY_BYTES }]);

    // The solution delivery announcement resolves from this operator's own origin.
    expect(result.announcements.some(
      (announcement) => announcement.action === 'available'
        && announcement.derivation.event === 'SolutionDeliveryClaimed'
        && announcement.record.digest === SOLUTION_DELIVERY_DIGEST,
    )).toBe(true);
    expect(plane.requested).toContain(`${SELF_BASE_URL}${recordPath(SOLUTION_DELIVERY_DIGEST)}`);
  });

  it('refuses — loudly and by name — when the evaluation-delivery bytes are tampered with', async () => {
    const tampered = new Map(servedAt(PEER_BASE_URL, SOLUTION_DELIVERY_BYTES));
    // Same locator, different bytes: a serving plane answering the evaluation-delivery address
    // with content that does not re-derive to the on-chain anchor.
    tampered.set(
      `${PEER_BASE_URL}${recordPath(EVALUATION_DELIVERY_DIGEST)}`,
      encodeJson({ tampered: true }),
    );
    const plane = servingPlane(new Map([
      ...servedAt(SELF_BASE_URL, SOLUTION_DELIVERY_BYTES),
      ...tampered,
    ]));
    const { ports, verified } = announcePorts({ resolveRecord: nativeResolveRecord(plane) });

    const transition = reduceMarketplaceProjection(
      settlementSequence(),
      createMarketplaceProjectionState(),
    );

    const result = await projectAnnouncements(transition, ports);

    // The refusal is recorded, by name and with the anchor, rather than thrown out of the whole
    // call. `announce.ts` scopes a `resolveRecord` throw to the record that threw it, so the
    // tampered evaluation-delivery no longer drops its neighbours' announcements with it.
    expect(result.refusals).toMatchObject([{
      kind: 'announcement-record-unresolved',
      role: 'evaluation-delivery',
      reason: expect.stringContaining('NativeAnnouncementRecordError'),
    }]);
    expect((result.refusals[0] as { reason: string }).reason)
      .toContain(EVALUATION_DELIVERY_DIGEST);
    // No fabricated announcement, and the verdict gate never saw substitute material.
    expect(verified).toEqual([]);
    expect(result.announcements.find(
      (announcement) => announcement.derivation.event === 'VerdictDeliveryClaimed',
    )).toBeUndefined();
    // The solution delivery in the same tick still published — the whole point of the isolation.
    expect(result.announcements.find(
      (announcement) => announcement.derivation.event === 'SolutionDeliveryClaimed',
    )).toMatchObject({ action: 'available' });
  });

  it('names role, anchor digest and cause on every refusal so the loop can log them', async () => {
    const plane = servingPlane(new Map());
    const resolveRecord = nativeResolveRecord(plane);
    const verdict = settlementSequence().at(-1)!;

    const error = await resolveRecord(verdict, 'evaluation-delivery').catch((cause) => cause);
    expect(error).toBeInstanceOf(NativeAnnouncementRecordError);
    expect(error.role).toBe('evaluation-delivery');
    expect(error.digest).toBe(EVALUATION_DELIVERY_DIGEST);
    expect(error.message).toContain('evaluation-delivery');
    expect(error.message).toContain(EVALUATION_DELIVERY_DIGEST);
    expect(error.message).toContain('serving plane');
  });

  it('refuses a delivery role whose projection is outside the canonical coordinator', async () => {
    const plane = servingPlane(new Map(servedAt(SELF_BASE_URL, EVALUATION_DELIVERY_BYTES)));
    const resolveRecord = nativeResolveRecord(plane);
    const verdict = settlementSequence().at(-1)!;
    const foreign = {
      ...verdict,
      projection: { ...verdict.projection, taskCoordinator: '0x1111111111111111111111111111111111111111' },
    } as ObservationMarketplaceEvent;

    await expect(resolveRecord(foreign, 'evaluation-delivery'))
      .rejects.toThrow(/canonical Base Sepolia coordinator/i);
    expect(plane.requested).toEqual([]);
  });

  it('refuses a REVISED claim missing its anchor instead of falling back to the engagement key', async () => {
    // The today-generation leg keys off the engagement because the chain names no digest there.
    // A revised claim DOES name one, so a revised claim without it is a defect, not an invitation
    // to use the weaker key — this is the guard that keeps the stronger generation strong.
    const plane = servingPlane(new Map(servedAt(SELF_BASE_URL, EVALUATION_DELIVERY_BYTES)));
    const resolveRecord = buildNativeResolveRecord(
      BASE_SEPOLIA_TODAY,
      async () => SUBMISSION_BYTES,
      buildFleetDeliveryBytesResolver(plane.byLocation, [SELF_BASE_URL, PEER_BASE_URL]),
      { solutionDelivery: async () => SOLUTION_DELIVERY_BYTES, evaluationDelivery: async () => EVALUATION_DELIVERY_BYTES },
    );
    const verdict = settlementSequence().at(-1)!;
    const { evaluationDeliveryDigest: _dropped, ...factsWithoutAnchor } =
      verdict.facts as Record<string, unknown>;
    const anchorless = { ...verdict, facts: factsWithoutAnchor } as ObservationMarketplaceEvent;

    const error = await resolveRecord(anchorless, 'evaluation-delivery').catch((cause) => cause);
    expect(error).toBeInstanceOf(NativeAnnouncementRecordError);
    expect(error.digest).toBeUndefined();
    expect(error.message).toContain('revised-generation claim with no usable delivery anchor');
    expect(plane.requested).toEqual([]);
  });

  it('keeps BOTH digest checks on the revised path — the transport\'s and the resolver\'s', async () => {
    // The two checks are independently deletable and each masks the other's absence, so one
    // assertion cannot pin both. This test pins them by their DISTINCT refusal messages:
    //   - delete `buildFleetDeliveryBytesResolver`'s `documentDigest(bytes) === digest` and case
    //     one's refusal becomes the resolver's "do not re-derive" message;
    //   - delete `buildNativeResolveRecord`'s `documentDigest(bytes) !== anchorDigest` and case
    //     two resolves material instead of refusing.
    const claimed = settlementSequence().find((event) => event.event === 'SolutionDeliveryClaimed')!;
    const wrongBytes = encodeJson({ substituted: true });

    // Case one: the SERVING PLANE answers the anchor's locator with content that is not the
    // anchored record. The transport must swallow it, so the resolver reports a plain miss.
    const lying = new Map([[`${SELF_BASE_URL}${recordPath(SOLUTION_DELIVERY_DIGEST)}`, wrongBytes]]);
    const transportError = await nativeResolveRecord(servingPlane(lying))(claimed, 'delivery')
      .catch((cause) => cause);
    expect(transportError).toBeInstanceOf(NativeAnnouncementRecordError);
    expect(transportError.message).toContain('no digest-verified bytes');

    // Case two: a record-bytes resolver that returns non-matching bytes directly, with the
    // transport's own check out of the path. The resolver must not delegate the last check.
    const resolverError = await buildNativeResolveRecord(
      BASE_SEPOLIA_TODAY,
      async () => SUBMISSION_BYTES,
      async () => wrongBytes,
    )(claimed, 'delivery').catch((cause) => cause);
    expect(resolverError).toBeInstanceOf(NativeAnnouncementRecordError);
    expect(resolverError.message).toContain('do not re-derive to the on-chain anchor');
  });

  it('refuses every delivery role when no serving plane is wired into the composition', async () => {
    const resolveRecord = buildNativeResolveRecord(BASE_SEPOLIA_TODAY, async () => SUBMISSION_BYTES);
    const sequence = settlementSequence();
    const cases = [
      ['delivery', sequence.find((event) => event.event === 'SolutionDeliveryClaimed')!],
      ['evaluation-delivery', sequence.at(-1)!],
    ] as const;
    const seen: string[] = [];

    for (const [role, event] of cases) {
      // eslint-disable-next-line no-await-in-loop -- assert both roles in order.
      const error = await resolveRecord(event, role).catch((cause) => cause);
      expect(error).toBeInstanceOf(NativeAnnouncementRecordError);
      expect(error.message).toContain('no native record serving plane is wired');
      seen.push(error.role);
    }
    expect(seen).toEqual(['delivery', 'evaluation-delivery']);
  });

  it('resolves the solution delivery role from the on-chain SolutionDeliveryClaimed anchor', async () => {
    const plane = servingPlane(new Map(servedAt(SELF_BASE_URL, SOLUTION_DELIVERY_BYTES)));
    const resolveRecord = nativeResolveRecord(plane);
    const claimed = settlementSequence().find((event) => event.event === 'SolutionDeliveryClaimed')!;

    await expect(resolveRecord(claimed, 'delivery')).resolves.toEqual({
      kind: RECORD_KINDS.delivery,
      bytes: SOLUTION_DELIVERY_BYTES,
    });
  });
});

// --- TODAY generation (JinnRouterV3) — the generation the native fleet actually pins ------------
//
// `main.ts` and `native-fleet-runtime.ts` both hardcode `BASE_SEPOLIA_TODAY`, and today-generation
// `SolutionDeliveryClaimed` / `VerdictDeliveryClaimed` carry NO delivery digest at all
// (`packages/marketplace/projector/src/events.ts`'s `todayEvent`). A resolver that keys only off
// those fields refuses every live event, which is behaviorally identical to refusing every role.
// These fixtures are the real V3 fact shapes; the resolution key is the engagement, and the anchor
// check for each role is asserted where it actually lives.

const TODAY_KECCAK = `0x${'b'.repeat(64)}` satisfies Hex;

function todayDerivation(event: string, blockNumber: number, logIndex = 0, contract: Address = BASE_SEPOLIA_TODAY.jinnRouter) {
  return { ...derivation(event, blockNumber, logIndex, contract), contractGeneration: 'today' as const };
}

/** The V3 settlement sequence: no `deliveryDigest`, no `evaluationDeliveryDigest`, anywhere. */
function todaySettlementSequence(input: {
  readonly deliveredBytes?: Uint8Array;
} = {}): readonly ObservationMarketplaceEvent[] {
  const delivered = input.deliveredBytes ?? SOLUTION_DELIVERY_BYTES;
  const deliveredDigest = documentDigest(delivered);
  return [
    projectable({
      event: 'TaskCreated',
      facts: {
        creator: CREATOR,
        taskId: TASK_ID,
        manifestDigest: `0x${'0'.repeat(64)}` as Hex,
        taskCidDigest: `0x${'7'.repeat(64)}` as Hex,
        maxClaims: 2,
        solutionBudget: 100n,
        verdictBudget: 20n,
      },
      derivation: todayDerivation('TaskCreated', 300),
    } as MarketplaceEvent),
    projectable({
      event: 'TaskAttemptCreated',
      facts: {
        taskId: TASK_ID,
        attemptIndex: ATTEMPT_INDEX,
        operator: OPERATOR,
        requestId: SOLUTION_REQUEST_ID,
        priorityMech: OPERATOR,
        deliveryRate: 10n,
      },
      derivation: todayDerivation('TaskAttemptCreated', 301),
    } as MarketplaceEvent),
    projectable({
      event: 'Deliver',
      facts: {
        mech: OPERATOR,
        mechServiceMultisig: OPERATOR,
        requestId: SOLUTION_REQUEST_ID,
        deliveryRate: 10n,
        data: bytes32(deliveredDigest),
      },
      derivation: todayDerivation('Deliver', 302, 0, OPERATOR),
    } as MarketplaceEvent, {
      // The today-mode sha256<->keccak mech correspondence. `observe.ts` emits
      // `delivery-recorded.v1` with `correspondence.sha256Digest` ONLY when this checks out, and
      // that observation is what `announce.ts` then anchors the resolved delivery bytes against.
      deliveryCorrespondence: {
        sha256Digest: deliveredDigest,
        keccakEvidenceHash: TODAY_KECCAK,
        onChainSha256CidDigest: deliveredDigest,
        onChainKeccak: TODAY_KECCAK,
      },
    }),
    projectable({
      event: 'SolutionDeliveryClaimed',
      facts: {
        operator: OPERATOR,
        requestId: SOLUTION_REQUEST_ID,
        taskId: TASK_ID,
        attemptIndex: ATTEMPT_INDEX,
      },
      derivation: todayDerivation('SolutionDeliveryClaimed', 303),
    } as MarketplaceEvent),
    projectable({
      event: 'EvaluationAttemptCreated',
      facts: {
        taskId: TASK_ID,
        attemptIndex: ATTEMPT_INDEX,
        verdictIndex: VERDICT_INDEX,
        requestId: VERDICT_REQUEST_ID,
        evaluator: EVALUATOR,
        priorityMech: EVALUATOR,
        deliveryRate: 20n,
      },
      derivation: todayDerivation('EvaluationAttemptCreated', 304),
    } as MarketplaceEvent),
    projectable({
      event: 'VerdictDeliveryClaimed',
      facts: {
        evaluator: EVALUATOR,
        requestId: VERDICT_REQUEST_ID,
        taskId: TASK_ID,
        attemptIndex: ATTEMPT_INDEX,
        verdictIndex: VERDICT_INDEX,
        verdictCode: VERDICT_CODE,
      },
      derivation: todayDerivation('VerdictDeliveryClaimed', 305),
    } as MarketplaceEvent),
  ];
}

const ENGAGEMENT_ID = 'urn:jinn:native:engagement:today-fixture';
const EVALUATION_ID = 'urn:jinn:native:evaluation:today-fixture';

/** The narrow solver-state reader `buildFleetOwnSolutionDeliveryResolver` consumes. */
function solverState(input: {
  readonly deliveryBytes?: Uint8Array;
  readonly attemptIndex?: number | null;
} = {}) {
  const bytes = input.deliveryBytes ?? SOLUTION_DELIVERY_BYTES;
  return {
    listEngagements: () => [{
      engagementId: ENGAGEMENT_ID,
      chainId: BASE_SEPOLIA_TODAY.chainId,
      coordinator: COORDINATOR,
      taskId: TASK_ID,
      attemptIndex: input.attemptIndex === undefined ? ATTEMPT_INDEX : input.attemptIndex,
    }],
    listSolutionArtifacts: (engagement: string) => engagement === ENGAGEMENT_ID
      ? [
        { engagementId: ENGAGEMENT_ID, role: 'output', digest: documentDigest(bytes), bytes },
        { engagementId: ENGAGEMENT_ID, role: 'delivery', digest: documentDigest(bytes), bytes },
      ]
      : [],
  } as unknown as Parameters<typeof buildFleetOwnSolutionDeliveryResolver>[0];
}

/**
 * The narrow evaluator-state reader BOTH the today record resolver AND the real M4b gate consume.
 * One fake, two consumers, deliberately: it is the same durable row the resolver returns bytes from
 * and the gate then binds `documentDigest(material.bytes)` to.
 */
function evaluatorState(input: {
  readonly deliveryBytes?: Uint8Array;
  readonly verdictCode?: number;
} = {}) {
  const bytes = input.deliveryBytes ?? EVALUATION_DELIVERY_BYTES;
  const subjectRoles = [
    'task', 'submission', 'requester-envelope', 'admission-receipt',
    'solution-delivery', 'solution-delivery-envelope', 'evaluation-spec',
  ];
  return {
    listEvaluations: () => [{
      evaluationId: EVALUATION_ID,
      chainId: BASE_SEPOLIA_TODAY.chainId,
      coordinator: COORDINATOR,
      taskId: TASK_ID,
      solutionAttemptIndex: ATTEMPT_INDEX,
      evaluationRequestId: VERDICT_REQUEST_ID,
      verdictCode: input.verdictCode ?? VERDICT_CODE,
    }],
    listEvaluationArtifacts: (evaluation: string) => evaluation === EVALUATION_ID
      ? [{ evaluationId: EVALUATION_ID, role: 'evaluation-delivery', name: 'delivery', digest: documentDigest(bytes), bytes }]
      : [],
    listSubjectArtifacts: () => subjectRoles.map((role) => ({
      role, name: role, digest: documentDigest(SUBMISSION_BYTES), bytes: SUBMISSION_BYTES,
    })),
    getAdmissionAuthority: () => ({ ok: true }),
    getDerivedEvaluation: () => ({ ok: true }),
    getEvaluation: () => undefined,
  };
}

/** The production resolver wired for the TODAY generation, exactly as the fleet runtime wires it. */
function todayResolveRecord(input: {
  readonly solver?: ReturnType<typeof solverState>;
  readonly evaluator?: ReturnType<typeof evaluatorState>;
  readonly plane?: ReturnType<typeof servingPlane>;
} = {}) {
  const plane = input.plane ?? servingPlane(new Map());
  return buildNativeResolveRecord(
    BASE_SEPOLIA_TODAY,
    async () => SUBMISSION_BYTES,
    buildFleetDeliveryBytesResolver(plane.byLocation, [SELF_BASE_URL]),
    {
      solutionDelivery: buildFleetOwnSolutionDeliveryResolver(input.solver ?? solverState()),
      evaluationDelivery: buildNativeEvaluationDeliveryRecordResolver(
        (input.evaluator ?? evaluatorState()) as never,
      ),
    },
  );
}

/** The REAL M4b gate over the same durable rows — the today generation's integrity check. */
function m4bGate(state: ReturnType<typeof evaluatorState>) {
  const adapter = buildNativeVerdictObservationAdapter({
    state: state as never,
    verification: {
      verify: async () => ({ ok: true as const, verdictCode: VERDICT_CODE }),
    },
  });
  return async (event: never, material: { readonly kind: string; readonly bytes: Uint8Array }) =>
    adapter(event, material as never);
}

describe('native announce path — TODAY generation (V3) delivery records (#45)', () => {
  it('publishes a decision-grade verdict announcement with no on-chain delivery digest anywhere', async () => {
    const sequence = todaySettlementSequence();
    // The premise: not one V3 event names a delivery digest.
    expect(sequence.every((event) => !('deliveryDigest' in event.facts)
      && !('evaluationDeliveryDigest' in event.facts))).toBe(true);

    const evaluator = evaluatorState();
    const { ports, verified } = announcePorts({
      resolveRecord: todayResolveRecord({ evaluator }),
      verifyVerdictObservation: m4bGate(evaluator),
    });
    const transition = reduceMarketplaceProjection(sequence, createMarketplaceProjectionState());
    const result = await projectAnnouncements(transition, ports);

    // RED BEFORE THIS FIX: the resolver keyed exclusively off the revised-only digest facts, so
    // both delivery roles threw `…carries no revised-generation delivery anchor`, the loop caught
    // it, and every announcement on the live path was suppressed.
    expect(result.refusals).toEqual([]);
    expect(result.announcements.find(
      (announcement) => announcement.derivation.event === 'VerdictDeliveryClaimed',
    )).toMatchObject({
      action: 'available',
      record: { kind: RECORD_KINDS.delivery, digest: EVALUATION_DELIVERY_DIGEST },
      facts: {
        'https://spec.jinn.network/facts/marketplace-verdict-correspondence/v1': {
          onChainVerdictCode: VERDICT_CODE,
          statementVerdict: 'pass',
        },
      },
    });
    expect(result.announcements.find(
      (announcement) => announcement.derivation.event === 'SolutionDeliveryClaimed',
    )).toMatchObject({
      action: 'available',
      record: { kind: RECORD_KINDS.delivery, digest: SOLUTION_DELIVERY_DIGEST },
    });
    // The real M4b gate saw the exact resolved material.
    expect(verified).toEqual([{ kind: RECORD_KINDS.delivery, bytes: EVALUATION_DELIVERY_BYTES }]);
  });

  it('refuses a tampered today solution delivery at the delivery-recorded anchor', async () => {
    // The chain named no digest, so nothing stops the resolver returning these bytes — the anchor
    // check is `announce.ts`'s, against the `delivery-recorded.v1` observation digest, which
    // `observe.ts` derives from the mech correspondence and not from anything this operator says.
    const tampered = encodeJson({ tampered: 'solution delivery' });
    const { ports } = announcePorts({
      resolveRecord: todayResolveRecord({ solver: solverState({ deliveryBytes: tampered }) }),
    });
    const transition = reduceMarketplaceProjection(
      todaySettlementSequence(),
      createMarketplaceProjectionState(),
    );
    const result = await projectAnnouncements(transition, ports);

    expect(result.announcements.some(
      (announcement) => announcement.derivation.event === 'SolutionDeliveryClaimed',
    )).toBe(false);
    expect(result.refusals).toContainEqual(expect.objectContaining({
      kind: 'announcement-material-refused',
      role: 'delivery',
      expectedDigest: SOLUTION_DELIVERY_DIGEST,
      actualDigest: documentDigest(tampered),
    }));
  });

  it('refuses a tampered today evaluation delivery at the M4b durable-artifact bind', async () => {
    // Same shape one layer over: the resolver returns bytes the durable row does not name, and the
    // M4b gate — which re-derives `documentDigest(material.bytes)` and demands exactly one joining
    // row — refuses. The announcement is a verdict refusal, never a `decisionGrade: true`.
    const evaluator = evaluatorState();
    const substituted = encodeJson({ tampered: 'evaluation delivery' });
    const { ports } = announcePorts({
      resolveRecord: buildNativeResolveRecord(
        BASE_SEPOLIA_TODAY,
        async () => SUBMISSION_BYTES,
        undefined,
        {
          solutionDelivery: buildFleetOwnSolutionDeliveryResolver(solverState()),
          evaluationDelivery: async () => substituted,
        },
      ),
      verifyVerdictObservation: m4bGate(evaluator),
    });
    const transition = reduceMarketplaceProjection(
      todaySettlementSequence(),
      createMarketplaceProjectionState(),
    );
    const result = await projectAnnouncements(transition, ports);

    expect(result.announcements.some(
      (announcement) => announcement.derivation.event === 'VerdictDeliveryClaimed'
        && announcement.action === 'available',
    )).toBe(false);
    expect(JSON.stringify(result.refusals)).toContain('joins 0 durable evaluation aggregates');
  });

  it('refuses by name when this operator holds no durable record for the engagement', async () => {
    const sequence = todaySettlementSequence();
    const claimed = sequence.find((event) => event.event === 'SolutionDeliveryClaimed')!;
    const verdict = sequence.at(-1)!;
    // A solver engagement for a DIFFERENT attempt, and an evaluator with no rows at all.
    const resolveRecord = todayResolveRecord({
      solver: solverState({ attemptIndex: ATTEMPT_INDEX + 1 }),
      evaluator: { ...evaluatorState(), listEvaluations: () => [] } as ReturnType<typeof evaluatorState>,
    });

    const deliveryError = await resolveRecord(claimed, 'delivery').catch((cause) => cause);
    expect(deliveryError).toBeInstanceOf(NativeAnnouncementRecordError);
    expect(deliveryError.role).toBe('delivery');
    expect(deliveryError.message).toContain('no single durable solution-delivery record');
    expect(deliveryError.message).toContain(`attempt=${ATTEMPT_INDEX}`);

    const verdictError = await resolveRecord(verdict, 'evaluation-delivery').catch((cause) => cause);
    expect(verdictError).toBeInstanceOf(NativeAnnouncementRecordError);
    expect(verdictError.role).toBe('evaluation-delivery');
    expect(verdictError.message).toContain('no single durable evaluation-delivery record');
    expect(verdictError.message).toContain(`verdictCode=${VERDICT_CODE}`);
  });

  it('refuses a today delivery role when no durable record store is wired in', async () => {
    const sequence = todaySettlementSequence();
    const resolveRecord = buildNativeResolveRecord(BASE_SEPOLIA_TODAY, async () => SUBMISSION_BYTES);
    const error = await resolveRecord(sequence.at(-1)!, 'evaluation-delivery').catch((cause) => cause);
    expect(error).toBeInstanceOf(NativeAnnouncementRecordError);
    expect(error.message).toContain('no native durable record store is wired');
  });

  it('refuses to answer a today lookup off a foreign coordinator, by NAME and with the role', async () => {
    // Fix-round item 5: this refusal used to be a bare `Error`, so the loop's warn could not say
    // which role it lost.
    const resolveRecord = todayResolveRecord();
    const verdict = todaySettlementSequence().at(-1)!;
    const foreign = {
      ...verdict,
      projection: { ...verdict.projection, taskCoordinator: '0x1111111111111111111111111111111111111111' },
    } as ObservationMarketplaceEvent;

    const error = await resolveRecord(foreign, 'evaluation-delivery').catch((cause) => cause);
    expect(error).toBeInstanceOf(NativeAnnouncementRecordError);
    expect(error.role).toBe('evaluation-delivery');
    expect(error.message).toContain('canonical Base Sepolia coordinator');
  });
});

// --- The REQUESTER's today-generation shape. ---
//
// PR #2644 taught the enrich/observe path to derive a counterparty's Delivery off the record plane
// and re-verify it against the coordinator's keccak anchor. The ANNOUNCE path never learned it: its
// today leg keys `ownRecords`, i.e. this operator's OWN durable solver store, which a requester by
// definition does not have. Observed live on Base Sepolia replaying task 1236 during the
// DR-2026-08-05 gate endgame (operator A requester/evaluator svc72, operator B solver svc75):
//
//   NativeAnnouncementRecordError: native resolveRecord refused the "delivery" record: this
//   operator holds no single durable solution-delivery record for task=1236 attempt=0
//
// The five canonical events journalled and the observations emitted, so the range is SPENT
// (`docs/runbooks/projector-replay.md`) — recovering the announcements costs another rewind, and
// the same failure repeats, because the cause is not transient.

/** keccak256 over the exact sealed Delivery — `getAttempt(...).solutionCidDigest`. */
const SOLUTION_ON_CHAIN_KECCAK = keccakEvidenceHash(SOLUTION_DELIVERY_BYTES);
const REQUESTER_ATTEMPT_URI = deriveMarketplaceAttemptUri({
  chainId: BASE_SEPOLIA_TODAY.chainId,
  coordinator: COORDINATOR,
  taskId: TASK_ID,
  attemptIndex: ATTEMPT_INDEX,
});

/**
 * A Delivery record naming the on-chain attempt, so the resolver's attempt/task leg has something
 * true to check. The shared fixture's `deliveryDocument` names a random urn instead.
 */
const REQUESTER_DELIVERY_BYTES = encodeJson({
  protocol: 'https://spec.jinn.network/profiles/task-execution/v1',
  attempt: REQUESTER_ATTEMPT_URI,
  task: `sha256:${'7'.repeat(64)}`,
  outputs: [],
  outcome: 'fulfilled',
  summary: 'counterparty solution delivery',
  createdAt: '2026-08-05T12:00:00Z',
});
const REQUESTER_DELIVERY_DIGEST = documentDigest(REQUESTER_DELIVERY_BYTES);
const REQUESTER_DELIVERY_KECCAK = keccakEvidenceHash(REQUESTER_DELIVERY_BYTES);

/**
 * The five publication events the live run lost, in order. NO Mech `Deliver`: the requester's log
 * filter scans the router, the coordinator and its OWN mech only, so operator B's delivering mech
 * is invisible here. `recordPlaneDelivery` on the claim's projection is what #2644 supplies in its
 * place, and it is what makes `observe.ts` emit `delivery-recorded.v1` rather than a false
 * `rejected`/`invalid-reference` terminal.
 */
function requesterTodaySequence(input: {
  readonly deliveryBytes?: Uint8Array;
} = {}): readonly ObservationMarketplaceEvent[] {
  const bytes = input.deliveryBytes ?? REQUESTER_DELIVERY_BYTES;
  const recordPlaneDelivery = {
    sha256Digest: documentDigest(bytes),
    keccakEvidenceHash: keccakEvidenceHash(bytes),
    onChainKeccak: keccakEvidenceHash(bytes),
  };
  return [
    projectable({
      event: 'TaskCreated',
      facts: {
        creator: CREATOR,
        taskId: TASK_ID,
        manifestDigest: `0x${'0'.repeat(64)}` as Hex,
        taskCidDigest: `0x${'7'.repeat(64)}` as Hex,
        maxClaims: 2,
        solutionBudget: 100n,
        verdictBudget: 20n,
      },
      derivation: todayDerivation('TaskCreated', 400),
    } as MarketplaceEvent),
    projectable({
      event: 'TaskAttemptCreated',
      facts: {
        taskId: TASK_ID,
        attemptIndex: ATTEMPT_INDEX,
        operator: OPERATOR,
        requestId: SOLUTION_REQUEST_ID,
        priorityMech: OPERATOR,
        deliveryRate: 10n,
      },
      derivation: todayDerivation('TaskAttemptCreated', 401),
    } as MarketplaceEvent),
    projectable({
      event: 'SolutionDeliveryClaimed',
      facts: {
        operator: OPERATOR,
        requestId: SOLUTION_REQUEST_ID,
        taskId: TASK_ID,
        attemptIndex: ATTEMPT_INDEX,
      },
      derivation: todayDerivation('SolutionDeliveryClaimed', 402),
    } as MarketplaceEvent, { recordPlaneDelivery }),
    projectable({
      event: 'EvaluationAttemptCreated',
      facts: {
        taskId: TASK_ID,
        attemptIndex: ATTEMPT_INDEX,
        verdictIndex: VERDICT_INDEX,
        requestId: VERDICT_REQUEST_ID,
        evaluator: EVALUATOR,
        priorityMech: EVALUATOR,
        deliveryRate: 20n,
      },
      derivation: todayDerivation('EvaluationAttemptCreated', 403),
    } as MarketplaceEvent),
    projectable({
      event: 'VerdictDeliveryClaimed',
      facts: {
        evaluator: EVALUATOR,
        requestId: VERDICT_REQUEST_ID,
        taskId: TASK_ID,
        attemptIndex: ATTEMPT_INDEX,
        verdictIndex: VERDICT_INDEX,
        verdictCode: VERDICT_CODE,
      },
      derivation: todayDerivation('VerdictDeliveryClaimed', 404),
    } as MarketplaceEvent),
  ];
}

/** The coordinator's own anchor for the attempt, the only binding a requester holds. */
function requesterChainReads(input: { readonly onChainKeccak?: Hex } = {}) {
  return async (requestId: Hex) => (
    requestId === SOLUTION_REQUEST_ID
      ? {
        taskId: TASK_ID,
        attemptIndex: ATTEMPT_INDEX,
        onChainKeccak: input.onChainKeccak ?? REQUESTER_DELIVERY_KECCAK,
      }
      : undefined
  );
}

describe('native announce path — requester-side counterparty delivery (#2644 parity)', () => {
  it('anchors a counterparty Delivery off the record plane when this operator holds none', async () => {
    const sequence = requesterTodaySequence();
    const plane = new Map<`sha256:${string}`, Uint8Array>([
      // A decoy ahead of the real record: the catalog only decides what to TRY.
      [documentDigest(EVALUATION_DELIVERY_BYTES), EVALUATION_DELIVERY_BYTES],
      [REQUESTER_DELIVERY_DIGEST, REQUESTER_DELIVERY_BYTES],
    ]);
    const evaluator = evaluatorState();
    const { ports } = announcePorts({
      resolveRecord: buildNativeResolveRecord(
        BASE_SEPOLIA_TODAY,
        async () => SUBMISSION_BYTES,
        undefined,
        {
          // The requester's solver store is EMPTY — it never produced this delivery.
          solutionDelivery: async () => undefined,
          evaluationDelivery: buildNativeEvaluationDeliveryRecordResolver(evaluator as never),
        },
        buildRecordPlaneCounterpartyDeliveryResolver({
          readTodayDeliveryFacts: requesterChainReads(),
          fetchDeliveryBytes: async (digest) => plane.get(digest),
          listRecordPlaneDigests: () => [...plane.keys()],
        }),
      ),
      verifyVerdictObservation: m4bGate(evaluator),
    });
    const transition = reduceMarketplaceProjection(sequence, createMarketplaceProjectionState());

    // The premise: observe.ts DID emit the delivery observation off the record plane (#2644).
    expect(transition.observations.map(({ type }) => type)).toContain(
      'network.jinn.task-execution.delivery-recorded.v1',
    );

    const result = await projectAnnouncements(transition, ports);

    // RED BEFORE THIS FIX: `resolveRecord` threw `…holds no single durable solution-delivery
    // record for task=42 attempt=3`, which aborted the whole call and dropped all five events'
    // announcements — the live Base Sepolia failure.
    expect(result.refusals).toEqual([]);
    expect(result.announcements.find(
      (announcement) => announcement.derivation.event === 'SolutionDeliveryClaimed',
    )).toMatchObject({
      action: 'available',
      record: { kind: RECORD_KINDS.delivery, digest: REQUESTER_DELIVERY_DIGEST },
    });
    // The verdict announcement — the DR-2026-08-05 G-loop criterion — publishes alongside it.
    expect(result.announcements.find(
      (announcement) => announcement.derivation.event === 'VerdictDeliveryClaimed',
    )).toMatchObject({
      action: 'available',
      record: { kind: RECORD_KINDS.delivery, digest: EVALUATION_DELIVERY_DIGEST },
    });
  });

  it('prefers this operator\'s OWN durable record over the record plane', async () => {
    // A solver still answers from its own store; the fallback is strictly additive. The plane here
    // would answer with different bytes, so a resolver that reached for it would be visible.
    const resolveRecord = buildNativeResolveRecord(
      BASE_SEPOLIA_TODAY,
      async () => SUBMISSION_BYTES,
      undefined,
      {
        solutionDelivery: async () => SOLUTION_DELIVERY_BYTES,
        evaluationDelivery: async () => undefined,
      },
      buildRecordPlaneCounterpartyDeliveryResolver({
        readTodayDeliveryFacts: requesterChainReads(),
        fetchDeliveryBytes: async () => REQUESTER_DELIVERY_BYTES,
        listRecordPlaneDigests: () => [REQUESTER_DELIVERY_DIGEST],
      }),
    );
    const claimed = requesterTodaySequence().find(
      (event) => event.event === 'SolutionDeliveryClaimed',
    )!;

    const material = await resolveRecord(claimed, 'delivery');
    expect(material.bytes).toEqual(SOLUTION_DELIVERY_BYTES);
  });

  it('refuses bytes that do not hash to the coordinator\'s anchor', async () => {
    // The record plane is a HINT. A candidate that does not re-derive to the on-chain keccak is
    // never admitted, however confidently the catalog names it.
    const resolveRecord = buildNativeResolveRecord(
      BASE_SEPOLIA_TODAY,
      async () => SUBMISSION_BYTES,
      undefined,
      { solutionDelivery: async () => undefined, evaluationDelivery: async () => undefined },
      buildRecordPlaneCounterpartyDeliveryResolver({
        readTodayDeliveryFacts: requesterChainReads({ onChainKeccak: `0x${'c'.repeat(64)}` }),
        fetchDeliveryBytes: async () => REQUESTER_DELIVERY_BYTES,
        listRecordPlaneDigests: () => [REQUESTER_DELIVERY_DIGEST],
      }),
    );
    const claimed = requesterTodaySequence().find(
      (event) => event.event === 'SolutionDeliveryClaimed',
    )!;

    const error = await resolveRecord(claimed, 'delivery').catch((cause) => cause);
    expect(error).toBeInstanceOf(NativeAnnouncementRecordError);
    expect(error.role).toBe('delivery');
    expect(error.message).toContain('no single durable solution-delivery record');
  });

  it('refuses a candidate that hashes to the anchor but names a different attempt', async () => {
    // The bytes carry the coordinator's anchor yet describe another Attempt — a contradiction the
    // chain itself asserts against. Same posture as the adoption port's gate 4.
    const foreign = deliveryDocument(
      'urn:jinn:marketplace:attempt:84532:0x0000000000000000000000000000000000000000:99:0',
      'a delivery for someone else\'s attempt',
    );
    const resolveRecord = buildNativeResolveRecord(
      BASE_SEPOLIA_TODAY,
      async () => SUBMISSION_BYTES,
      undefined,
      { solutionDelivery: async () => undefined, evaluationDelivery: async () => undefined },
      buildRecordPlaneCounterpartyDeliveryResolver({
        readTodayDeliveryFacts: requesterChainReads({ onChainKeccak: keccakEvidenceHash(foreign) }),
        fetchDeliveryBytes: async () => foreign,
        listRecordPlaneDigests: () => [documentDigest(foreign)],
      }),
    );
    const claimed = requesterTodaySequence().find(
      (event) => event.event === 'SolutionDeliveryClaimed',
    )!;

    const error = await resolveRecord(claimed, 'delivery').catch((cause) => cause);
    expect(error).toBeInstanceOf(NativeAnnouncementRecordError);
    expect(error.message).toContain('no single durable solution-delivery record');
  });

  it('keeps refusing when no record-plane fallback is wired into the composition', async () => {
    // A composition without a record plane behaves exactly as it did before this fix.
    const resolveRecord = buildNativeResolveRecord(
      BASE_SEPOLIA_TODAY,
      async () => SUBMISSION_BYTES,
      undefined,
      { solutionDelivery: async () => undefined, evaluationDelivery: async () => undefined },
    );
    const claimed = requesterTodaySequence().find(
      (event) => event.event === 'SolutionDeliveryClaimed',
    )!;

    const error = await resolveRecord(claimed, 'delivery').catch((cause) => cause);
    expect(error).toBeInstanceOf(NativeAnnouncementRecordError);
    expect(error.message).toContain(`task=${TASK_ID} attempt=${ATTEMPT_INDEX}`);
  });
});

describe('the projector composition is wired with a real logger (#45)', () => {
  // Every refusal above is only useful if it reaches an operator. `CompositionRootInput.logger` is
  // OPTIONAL, so its omission at `main.ts`'s call site turned every `logger?.warn` inside
  // `ProjectorLoop` and `createProjectorEnrich` into a no-op — a verdict announcement could be
  // suppressed on every tick with nothing in the daemon log. A source scan is the cheap pin: the
  // regression is a deleted property in one object literal, not a behavior a unit test can reach
  // without booting `main()`.
  it('passes a logger into buildOperatorComposition', () => {
    const main = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../src/main.ts'),
      'utf8',
    );
    const call = main.slice(main.indexOf('buildOperatorComposition({'));
    expect(call).not.toBe('');
    // The property, inside the composition call, ahead of its closing `});`.
    const body = call.slice(0, call.indexOf('\n    });'));
    expect(body).toMatch(/\n\s+logger: \{/u);
    expect(body).toMatch(/warn: \(message\) => console\.warn\(message\)/u);
  });
});
