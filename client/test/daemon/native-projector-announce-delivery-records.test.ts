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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import {
  BASE_SEPOLIA_TODAY,
  REVISED_LEG_SOLUTION,
  REVISED_LEG_VERDICT,
  encodeRevisedRequestData,
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
} from '../../src/daemon/composition-root.js';
import { buildFleetDeliveryBytesResolver } from '../../src/daemon/native-fleet-runtime.js';
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
}) {
  const pageCounts = new Map<string, number>();
  const verified: unknown[] = [];
  return {
    verified,
    ports: buildAnnouncementProjectionPorts({
      source: { agent: 'urn:jinn:operator:test', name: 'operator-projector' },
      signer: fakeDiscoverySigner(),
      archiveRoot,
      resolveRecord: input.resolveRecord,
      verifyVerdictObservation: async (_event, material) => {
        verified.push(material);
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

    await expect(projectAnnouncements(transition, ports)).rejects.toThrow(
      NativeAnnouncementRecordError,
    );
    // No fabricated announcement, and the verdict gate never saw substitute material.
    expect(verified).toEqual([]);
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

  it('refuses a delivery role with no revised-generation anchor rather than guessing', async () => {
    const plane = servingPlane(new Map(servedAt(SELF_BASE_URL, EVALUATION_DELIVERY_BYTES)));
    const resolveRecord = nativeResolveRecord(plane);
    const verdict = settlementSequence().at(-1)!;
    const { evaluationDeliveryDigest: _dropped, ...factsWithoutAnchor } =
      verdict.facts as Record<string, unknown>;
    const v3 = { ...verdict, facts: factsWithoutAnchor } as ObservationMarketplaceEvent;

    const error = await resolveRecord(v3, 'evaluation-delivery').catch((cause) => cause);
    expect(error).toBeInstanceOf(NativeAnnouncementRecordError);
    expect(error.digest).toBeUndefined();
    expect(error.message).toContain('no revised-generation delivery anchor');
    expect(plane.requested).toEqual([]);
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
