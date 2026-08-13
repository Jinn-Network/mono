/**
 * Defect #48 — end-to-end regression for requester-side adoption of a delivery a SECOND operator
 * produced, reproducing operator A's live task-1236 state on Base Sepolia.
 *
 * The scenario the gate hit, and what this test seeds:
 *
 *   - A posted the task and holds the sealed Submission/Task records for it (a real
 *     `buildFleetRequesterWrite.postTarget`, writing a real association to a real state dir).
 *   - B claimed it, delivered through B's OWN mech, and settled on the shared router. A therefore
 *     sees `TaskAttemptCreated` and `SolutionDeliveryClaimed` on the coordinator/router it
 *     subscribes to, and NEVER the Mech `Deliver` — A does not subscribe to B's mech.
 *   - A's evaluator claimed the verdict attempt and settled `VerdictDeliveryClaimed` with
 *     `Unresolved(4)`. A narrow replay had already journaled that event, so a second bounded replay
 *     re-offers only the four EARLIER events; the verdict observation is carried in the projector
 *     state from the first pass.
 *
 * Before the fix all three gates were shut:
 *   A. `TaskAttemptCreated` dropped in enrich (no engagement-ledger seal — A never claimed), so no
 *      `attempt-engaged` and `observe()` threw `attempt-not-found`.
 *   B. `port.deliveries(attempt)` read `attempt_deliveries`, which nothing in production writes.
 *   C. `SolutionDeliveryClaimed` with no mech fact emitted `rejected`/`invalid-reference`, a false
 *      terminal that landed beside the verdict's terminal and folded the Attempt `contradictory`.
 *
 * Everything load-bearing here is the production code path: `createProjectorEnrich` with the real
 * exported resolvers (`buildDerivedRequesterDispatchContextPort`,
 * `buildRecordPlaneSolutionDeliveryPort`, `buildReadOnChainTaskDigest`,
 * `buildReadTodayDeliveryFacts`, `createNativeRequesterSubmissionResolver`), the real reducer, the
 * real SQLite-backed `createProjectorObservePort`, and the real `adoptPostedTask` reached through
 * `buildFleetRequesterWrite.adopt()`. Only the chain (`readContract`/`getBlock`), the record-plane
 * transport and the Safe broadcast are fixtures.
 */
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BASE_SEPOLIA_TODAY,
  createInMemoryPostingIntentStore,
  deriveMarketplaceAttemptUri,
  keccakEvidenceHash,
} from '@jinn-network/marketplace-binding';
import {
  createMarketplaceProjectionState,
  reduceMarketplaceProjection,
  type MarketplaceEvent,
  type MarketplaceProjectionState,
  type MarketplaceProtocolObservation,
} from '@jinn-network/marketplace-projector';
import { createProjectorObservePort, openVenueState } from '@jinn-network/marketplace-venue-base';
import { documentDigest, sealDelivery, serializeCanonicalJson } from '@jinn-network/task-execution-protocol';
import type { Address, Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  buildDerivedRequesterDispatchContextPort,
  buildReadOnChainTaskDigest,
  buildReadTodayDeliveryFacts,
  buildRecordPlaneSolutionDeliveryPort,
} from '../../src/daemon/composition-root.js';
import { createFileAdoptionReceiptStore } from '../../src/daemon/native-adoption-receipt-store.js';
import { buildFleetRequesterWrite } from '../../src/daemon/native-fleet-requester-write.js';
import { createProjectorEnrich } from '../../src/daemon/projector-enrich.js';
import {
  createNativeRequesterSubmissionResolver,
  type NativeRequesterRoles,
} from '../../src/native-requester/requester.js';

const CHAIN = BASE_SEPOLIA_TODAY;
const REQUESTER_SAFE = '0x1111111111111111111111111111111111111111' as Address;
/** Operator B — the second operator, whose mech this requester never subscribes to. */
const SOLVER_B = '0xc679BD172f6c6bA0f6437d26361E92BD9b7995C3' as Address;
const SOLVER_MECH_B = '0x2222222222222222222222222222222222222222' as Address;
const EVALUATOR_A = '0x3333333333333333333333333333333333333333' as Address;
const EVALUATOR_MECH_A = '0x4444444444444444444444444444444444444444' as Address;
const SOLUTION_REQUEST_ID = `0x${'a1'.repeat(32)}` as Hex;
const VERDICT_REQUEST_ID = `0x${'b2'.repeat(32)}` as Hex;
const TASK_ID = 1236n;
const ATTEMPT_INDEX = 0;
const BLOCK_HASH = `0x${'cd'.repeat(32)}` as Hex;
const TX_HASH = `0x${'ef'.repeat(32)}` as Hex;
const BLOCK_TIMESTAMP = 1_786_000_000n;
const AUTHORITY_TIME = {
  chainId: 84532 as const,
  blockNumber: '45415000',
  blockHash: BLOCK_HASH,
  timestamp: '2026-08-12T11:59:00.000Z',
  finalized: true as const,
};
const TARGET = { postingKey: 'defect-48', spec: {} } as never;

const ATTEMPT_URI = deriveMarketplaceAttemptUri({
  chainId: CHAIN.chainId,
  coordinator: CHAIN.taskCoordinator,
  taskId: TASK_ID,
  attemptIndex: ATTEMPT_INDEX,
});

function roles(): NativeRequesterRoles & {
  readonly verifier: { readonly keyId: string; readonly publicKey: ReturnType<typeof generateKeyPairSync>['publicKey'] };
} {
  const byRole = new Map<string, {
    keyId: string;
    publicKey: ReturnType<typeof generateKeyPairSync>['publicKey'];
    sign: (payload: Uint8Array) => Uint8Array;
  }>();
  for (const role of ['requester-submission', 'admission', 'requester-discovery'] as const) {
    const pair = generateKeyPairSync('ed25519');
    byRole.set(role, {
      keyId: `did:key:${role}`,
      publicKey: pair.publicKey,
      sign: (payload: Uint8Array) => new Uint8Array(cryptoSign(null, payload, pair.privateKey)),
    });
  }
  const submission = byRole.get('requester-submission')!;
  return {
    get(role) {
      const identity = byRole.get(role);
      if (identity === undefined) throw new Error(`missing test role ${role}`);
      return identity;
    },
    verifier: { keyId: submission.keyId, publicKey: submission.publicKey },
  };
}

function derivation(event: string, blockNumber: number, logIndex: number): MarketplaceEvent['derivation'] {
  return {
    chainId: CHAIN.chainId,
    // Every today-generation lifecycle event is emitted by JinnRouterV3, verified against operator
    // A's own journal: `TaskCreated`, `TaskAttemptCreated`, `SolutionDeliveryClaimed`,
    // `EvaluationAttemptCreated` and `VerdictDeliveryClaimed` all carry the router as
    // `derivation.contract` (only Mech `Deliver` comes from a mech). This matters to the fold, not
    // just to realism: `sourceFor` derives the observation source FROM this address, and a split
    // across two contracts would put half the Attempt's log on a non-authoritative source.
    contract: CHAIN.jinnRouter,
    event,
    blockNumber,
    // One distinct block hash per block, as the chain actually presents them: a shared hash across
    // differing heights is exactly the shape the canonical selector reads as a reorg.
    blockHash: `0x${blockNumber.toString(16).padStart(64, '0')}` as Hex,
    txHash: `${TX_HASH.slice(0, 62)}${logIndex.toString(16).padStart(4, '0')}` as Hex,
    logIndex,
    finalityTier: 'finalized',
    contractGeneration: 'today',
  };
}

/** The verdict operator A's own evaluator settled — the event the live narrow replay journaled. */
const VERDICT_EVENT: MarketplaceEvent = {
  event: 'VerdictDeliveryClaimed',
  facts: {
    evaluator: EVALUATOR_A,
    requestId: VERDICT_REQUEST_ID,
    taskId: TASK_ID,
    attemptIndex: ATTEMPT_INDEX,
    verdictIndex: 0,
    verdictCode: 4,
  },
  derivation: derivation('VerdictDeliveryClaimed', 45_420_025, 9),
} as MarketplaceEvent;

/** The four events the wide rewind re-offers, in chain order. */
function earlierEvents(taskDigest: `sha256:${string}`): MarketplaceEvent[] {
  return [
    {
      event: 'TaskCreated',
      facts: {
        creator: REQUESTER_SAFE,
        taskId: TASK_ID,
        manifestDigest: `0x${'0'.repeat(64)}` as Hex,
        taskCidDigest: `0x${taskDigest.slice('sha256:'.length)}` as Hex,
        maxClaims: 1,
        solutionBudget: 100n,
        verdictBudget: 20n,
      },
      derivation: derivation('TaskCreated', 45_415_191, 1),
    },
    {
      event: 'TaskAttemptCreated',
      facts: {
        taskId: TASK_ID,
        attemptIndex: ATTEMPT_INDEX,
        operator: SOLVER_B,
        requestId: SOLUTION_REQUEST_ID,
        priorityMech: SOLVER_MECH_B,
        deliveryRate: 10n,
      },
      derivation: derivation('TaskAttemptCreated', 45_415_994, 2),
    },
    {
      event: 'SolutionDeliveryClaimed',
      facts: {
        operator: SOLVER_B,
        requestId: SOLUTION_REQUEST_ID,
        taskId: TASK_ID,
        attemptIndex: ATTEMPT_INDEX,
      },
      derivation: derivation('SolutionDeliveryClaimed', 45_416_858, 3),
    },
    {
      event: 'EvaluationAttemptCreated',
      facts: {
        taskId: TASK_ID,
        attemptIndex: ATTEMPT_INDEX,
        verdictIndex: 0,
        requestId: VERDICT_REQUEST_ID,
        evaluator: EVALUATOR_A,
        priorityMech: EVALUATOR_MECH_A,
        deliveryRate: 20n,
      },
      derivation: derivation('EvaluationAttemptCreated', 45_417_527, 4),
    },
  ] as MarketplaceEvent[];
}

/** `packages/marketplace/projector/src/observe.ts`'s `logIdentity`, reproduced for the journal check. */
function logIdentity(event: MarketplaceEvent): string {
  const { chainId, contract, blockHash, txHash, logIndex } = event.derivation;
  return [chainId, contract.toLowerCase(), blockHash.toLowerCase(), txHash.toLowerCase(), logIndex].join(':');
}

/**
 * The exact `readContract` surface the two exported production readers use. Nothing here is
 * hand-waved past the ABI: the readers decode these tuples themselves.
 */
function chainReads(input: {
  readonly taskDigest: `sha256:${string}`;
  readonly solutionCidDigest: Hex;
}): { readContract: (args: { functionName: string; args: readonly unknown[] }) => Promise<unknown> } {
  const taskAnchor = `0x${input.taskDigest.slice('sha256:'.length)}` as Hex;
  return {
    async readContract({ functionName, args }) {
      switch (functionName) {
        case 'getTask':
          return {
            creator: REQUESTER_SAFE,
            taskCidDigest: taskAnchor,
            manifestDigest: `0x${'0'.repeat(64)}` as Hex,
            status: 1,
            policy: 0,
            claimCount: 1,
            submittedCount: 1,
            finalizedAttemptCount: 1,
            creatorCredited: false,
          };
        case 'getRequestRef':
          return args[0] === SOLUTION_REQUEST_ID
            ? [TASK_ID, ATTEMPT_INDEX, true]
            : [0n, 0, false];
        case 'getAttempt':
          return {
            taskId: TASK_ID,
            attemptIndex: ATTEMPT_INDEX,
            operator: SOLVER_B,
            requestId: SOLUTION_REQUEST_ID,
            solutionCidDigest: input.solutionCidDigest,
            solutionWeight: 1n,
            verdictCount: 1,
            status: 2,
          };
        case 'getVerdictRequestRef':
          return args[0] === VERDICT_REQUEST_ID
            ? [TASK_ID, ATTEMPT_INDEX, 0, true]
            : [0n, 0, 0, false];
        case 'getVerdict':
          return {
            taskId: TASK_ID,
            attemptIndex: ATTEMPT_INDEX,
            verdictIndex: 0,
            evaluator: EVALUATOR_A,
            requestId: VERDICT_REQUEST_ID,
            verdictCidDigest: `0x${'9'.repeat(64)}` as Hex,
            verdictCode: 4,
            status: 1,
          };
        default:
          throw new Error(`unexpected read ${functionName}`);
      }
    },
  };
}

/** Posts one task through the real requester write path and returns everything it sealed. */
async function postTask(stateDir: string) {
  const identities = roles();
  const intents = createInMemoryPostingIntentStore();
  const state = openVenueState(join(stateDir, 'venue.db'));
  const observations: MarketplaceProtocolObservation[] = [];
  const observe = createProjectorObservePort({
    chain: CHAIN,
    state,
    logSource: { orphanedBlockHashes: () => new Set<Hex>() } as never,
    observations: async () => observations,
  });
  const write = buildFleetRequesterWrite({
    requesterAgent: 'urn:jinn:requester:defect-48',
    admissionAgent: 'urn:jinn:admission:defect-48',
    publicBaseUrl: 'https://requester.invalid',
    requesterStateDir: stateDir,
    creatorSafe: REQUESTER_SAFE,
    roles: identities,
    safeBroadcast: {
      broadcastCreateTask: async () => ({ taskId: TASK_ID, txHash: TX_HASH }),
    },
    intents,
    observe,
    ipfsPin: { pin: async () => {} },
    authorityTime: async () => AUTHORITY_TIME,
    canonicalTaskCreated: async (expected) => ({ canonical: true as const, ...expected }),
    adoptionReceipts: createFileAdoptionReceiptStore({ dir: join(stateDir, 'adoptions') }),
    now: () => new Date('2026-08-12T12:00:00.000Z'),
  });
  await write.postTarget(TARGET);
  return { identities, intents, state, observations, observe, write };
}

describe('requester-side adoption of a counterparty delivery (defect #48)', () => {
  it('derives the engagement, records the record-plane delivery, and produces the receipt', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-defect-48-'));
    try {
      const posted = await postTask(stateDir);
      const [associationName] = await readdir(join(stateDir, 'associations'));
      const association = JSON.parse(
        await readFile(join(stateDir, 'associations', associationName!), 'utf8'),
      ) as {
        taskDigest: `sha256:${string}`;
        submissionUri: `urn:uuid:${string}`;
        nonce: string;
        task: { readonly path: string; readonly digest: `sha256:${string}` };
      };

      // The Delivery record operator B published to ITS record plane. The requester never sees the
      // mech `Deliver` that carried its sha256; the coordinator holds only the keccak.
      const deliveryBytes = sealDelivery({
        protocol: 'https://spec.jinn.network/task-execution/v1',
        attempt: ATTEMPT_URI,
        task: association.taskDigest,
        outputs: [],
        outcome: 'fulfilled',
        createdAt: '2026-08-12T12:10:00.000Z',
      });
      const deliveryDigest = documentDigest(deliveryBytes);
      const solutionCidDigest = keccakEvidenceHash(deliveryBytes);

      // A decoy record on the same plane: same shape, different bytes, and NOT the one the
      // coordinator anchored. It sits ahead of the real one so the scan cannot pass by luck.
      const decoyBytes = sealDelivery({
        protocol: 'https://spec.jinn.network/task-execution/v1',
        attempt: ATTEMPT_URI,
        task: association.taskDigest,
        outputs: [],
        outcome: 'partial',
        createdAt: '2026-08-12T12:11:00.000Z',
      });
      const recordPlane = new Map<string, Uint8Array>([
        [documentDigest(decoyBytes), decoyBytes],
        [deliveryDigest, deliveryBytes],
      ]);
      // The requester published its sealed Task record to its own serving plane; the projector's
      // digest join fetches it back from there (the #2559/#2638 class).
      const taskBytes = new Uint8Array(await readFile(join(stateDir, 'discovery', association.task.path)));
      expect(documentDigest(taskBytes)).toBe(association.taskDigest);
      recordPlane.set(association.taskDigest, taskBytes);

      const publicClient = {
        getBlock: async () => ({ timestamp: BLOCK_TIMESTAMP }),
        ...chainReads({ taskDigest: association.taskDigest, solutionCidDigest }),
      } as never;
      const readOnChainTaskDigest = buildReadOnChainTaskDigest(publicClient, CHAIN.taskCoordinator);
      const readTodayDeliveryFacts = buildReadTodayDeliveryFacts(publicClient, CHAIN.taskCoordinator);
      const resolveAssociation = createNativeRequesterSubmissionResolver({
        stateDir,
        requesterSubmission: posted.identities.verifier,
      });
      const resolveSubmissionBytes = async (lookup: {
        chainId: number;
        taskCoordinator: Address;
        taskId: bigint;
        taskDigest?: `sha256:${string}`;
      }) => {
        const anchor = lookup.taskDigest ?? await readOnChainTaskDigest(lookup.taskId);
        if (anchor === undefined) return undefined;
        return resolveAssociation({
          chainId: lookup.chainId,
          coordinator: lookup.taskCoordinator,
          taskId: lookup.taskId,
          taskDigest: anchor,
        });
      };
      const fetchDeliveryBytes = async (digest: `sha256:${string}`) => recordPlane.get(digest);
      // No engagement-ledger row exists: this operator never claimed the attempt.
      const emptyLedger = { get: () => undefined } as never;
      const enrich = createProjectorEnrich({
        chain: CHAIN,
        publicClient,
        fetchIpfsBytes: async () => undefined,
        fetchDeliveryBytes,
        fetchTaskBytes: fetchDeliveryBytes,
        resolveSubmissionBytes: resolveSubmissionBytes as never,
        allowLegacySignedTaskV1: false,
        readTodayDeliveryFacts,
        resolveDispatchContext: buildDerivedRequesterDispatchContextPort({
          resolveSubmissionBytes: resolveSubmissionBytes as never,
          readOnChainTaskDigest,
          generation: 'today',
        }),
        resolveRecordPlaneDelivery: buildRecordPlaneSolutionDeliveryPort({
          resolveSubmissionBytes: resolveSubmissionBytes as never,
          readOnChainTaskDigest,
          readTodayDeliveryFacts,
          fetchDeliveryBytes,
          // Newest first, decoy ahead of the real record.
          listRecordPlaneDigests: () => [...recordPlane.keys()] as `sha256:${string}`[],
          engagementLedger: emptyLedger,
        }),
      });

      async function project(
        events: readonly MarketplaceEvent[],
        previous: MarketplaceProjectionState,
      ): Promise<MarketplaceProjectionState> {
        const enriched = [];
        for (const event of events) {
          const admitted = await enrich(event);
          if (admitted !== undefined) enriched.push(admitted);
        }
        const transition = reduceMarketplaceProjection(enriched, previous);
        posted.observations.push(...transition.observations);
        return transition.state;
      }

      // Pass 1 — the NARROW replay that already ran live: the verdict alone.
      let state = await project([VERDICT_EVENT], createMarketplaceProjectionState());
      expect(posted.observations.map(({ type }) => type)).toContain(
        'network.jinn.task-execution.attempt-terminal.v1',
      );

      // Pass 2 — the SECOND bounded replay, re-offering the four earlier events.
      state = await project(earlierEvents(association.taskDigest), state);

      // GATE A — the engagement derived: `attempt-engaged` exists for the attempt B claimed.
      const engaged = posted.observations.filter(
        ({ type }) => type === 'network.jinn.task-execution.attempt-engaged.v1',
      );
      expect(engaged).toHaveLength(1);
      expect(engaged[0]!.subject).toBe(ATTEMPT_URI);

      // GATE C — the delivery recorded from the record plane, and NO false rejection.
      const recorded = posted.observations.filter(
        ({ type }) => type === 'network.jinn.task-execution.delivery-recorded.v1',
      );
      expect(recorded).toHaveLength(1);
      expect((recorded[0]!.data as { digest: string }).digest).toBe(deliveryDigest);
      const terminals = posted.observations.filter(
        ({ type }) => type === 'network.jinn.task-execution.attempt-terminal.v1',
      );
      expect(terminals).toHaveLength(1);
      expect(terminals[0]!.data).toMatchObject({ state: 'failed', category: 'result-unavailable' });

      // The Attempt folds cleanly — one terminal, never `contradictory`.
      const snapshot = await posted.observe.observe(association.submissionUri);
      expect(snapshot.descriptor.attempt).toBe(ATTEMPT_URI);
      expect(snapshot.descriptor.derived.contradictory).toBe(false);
      expect(snapshot.descriptor.derived.deliveries).toEqual([{ digest: deliveryDigest }]);

      // GATE B + the receipt — `adopt()` reaches `adoptPostedTask` and records a durable decision.
      const adoptable = buildFleetRequesterWrite({
        requesterAgent: 'urn:jinn:requester:defect-48',
        admissionAgent: 'urn:jinn:admission:defect-48',
        publicBaseUrl: 'https://requester.invalid',
        requesterStateDir: stateDir,
        creatorSafe: REQUESTER_SAFE,
        roles: posted.identities,
        safeBroadcast: { broadcastCreateTask: async () => ({ taskId: TASK_ID, txHash: TX_HASH }) },
        intents: posted.intents,
        observe: posted.observe,
        ipfsPin: { pin: async () => {} },
        authorityTime: async () => AUTHORITY_TIME,
        canonicalTaskCreated: async (expected) => ({ canonical: true as const, ...expected }),
        adoptionReceipts: createFileAdoptionReceiptStore({ dir: join(stateDir, 'adoptions') }),
        recordPlaneBytes: fetchDeliveryBytes,
        now: () => new Date('2026-08-12T13:00:00.000Z'),
      });
      const decisions = await adoptable.adopt();
      expect(decisions).toEqual([{
        attempt: ATTEMPT_URI,
        taskId: TASK_ID.toString(10),
        disposition: 'accepted',
        deliveryDigest,
        decidedAt: '2026-08-12T13:00:00.000Z',
      }]);

      // Durable and adopt-once.
      const receipts = createFileAdoptionReceiptStore({ dir: join(stateDir, 'adoptions') });
      expect(await receipts.has(TASK_ID.toString(10))).toBe(true);
      expect(await adoptable.adopt()).toEqual([]);

      // TAMPER — a record-plane replica serving bytes that do not hash to the ref's digest is
      // refused; adoption never runs on unverified bytes.
      const tamperedPlane = new Map(recordPlane);
      tamperedPlane.set(deliveryDigest, new TextEncoder().encode('{"not":"the delivery"}'));
      const tamperedPort = {
        ...posted.observe,
        deliveries: async () => [{ attempt: ATTEMPT_URI, digest: deliveryDigest }],
        fetchDelivery: async () => tamperedPlane.get(deliveryDigest)!,
      };
      const { verifyDeliveryRef } = await import('../../src/native-requester/work-client/delivery.js');
      await expect(
        verifyDeliveryRef({ attempt: ATTEMPT_URI, digest: deliveryDigest }, ATTEMPT_URI, tamperedPort as never),
      ).rejects.toThrow(/refusing tampered delivery/u);

      posted.state.close();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  /**
   * The fix round's own blocker, pinned. Everything above is the HAPPY path — the serving plane was
   * up. Take it down for the delivery record alone and the first #48 fix produced the exact defect
   * it was written to remove: gates 1-3 passed (this operator IS the requester), gate 4 could not
   * fetch, the resolver answered with the same `undefined` the not-the-requester path returns, and
   * the reducer emitted `rejected`/`invalid-reference` beside the verdict's terminal — folding the
   * Attempt `contradictory` and wedging `adoptPostedTask` on `attempt-contradictory` FOREVER, since
   * the terminal journals the log id and a later rewind re-offers nothing.
   *
   * A transient network condition must never become a permanent content verdict. The requester
   * signal makes `enrich` DROP instead, which keeps the canonical log clean and the event
   * replayable — and the recovery leg below runs on the SAME resolver instance, so it also pins
   * that a failed fetch is not memoized as "not a Delivery" for the life of the process.
   */
  it('drops (never rejects) when the requester cannot witness, and recovers on the next replay', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-defect-48-outage-'));
    try {
      const posted = await postTask(stateDir);
      const [associationName] = await readdir(join(stateDir, 'associations'));
      const association = JSON.parse(
        await readFile(join(stateDir, 'associations', associationName!), 'utf8'),
      ) as {
        taskDigest: `sha256:${string}`;
        submissionUri: `urn:uuid:${string}`;
        task: { readonly path: string };
      };

      const deliveryBytes = sealDelivery({
        protocol: 'https://spec.jinn.network/task-execution/v1',
        attempt: ATTEMPT_URI,
        task: association.taskDigest,
        outputs: [],
        outcome: 'fulfilled',
        createdAt: '2026-08-12T12:10:00.000Z',
      });
      const deliveryDigest = documentDigest(deliveryBytes);
      const recordPlane = new Map<string, Uint8Array>([[deliveryDigest, deliveryBytes]]);
      const taskBytes = new Uint8Array(await readFile(join(stateDir, 'discovery', association.task.path)));
      recordPlane.set(association.taskDigest, taskBytes);

      // The outage: operator B's serving plane refuses exactly one record — the Delivery. The Task
      // record (this operator's own) keeps serving, so the digest join still resolves and the
      // ONLY thing missing is the counterparty witness.
      let deliveryPlaneDown = true;
      const fetchDeliveryBytes = async (digest: `sha256:${string}`) => {
        if (digest === deliveryDigest && deliveryPlaneDown) {
          throw new Error('ECONNREFUSED 127.0.0.1:7402');
        }
        return recordPlane.get(digest);
      };

      const publicClient = {
        getBlock: async () => ({ timestamp: BLOCK_TIMESTAMP }),
        ...chainReads({ taskDigest: association.taskDigest, solutionCidDigest: keccakEvidenceHash(deliveryBytes) }),
      } as never;
      const readOnChainTaskDigest = buildReadOnChainTaskDigest(publicClient, CHAIN.taskCoordinator);
      const readTodayDeliveryFacts = buildReadTodayDeliveryFacts(publicClient, CHAIN.taskCoordinator);
      const resolveAssociation = createNativeRequesterSubmissionResolver({
        stateDir,
        requesterSubmission: posted.identities.verifier,
      });
      const resolveSubmissionBytes = (async (lookup: {
        chainId: number;
        taskCoordinator: Address;
        taskId: bigint;
        taskDigest?: `sha256:${string}`;
      }) => {
        const anchor = lookup.taskDigest ?? await readOnChainTaskDigest(lookup.taskId);
        if (anchor === undefined) return undefined;
        return resolveAssociation({
          chainId: lookup.chainId,
          coordinator: lookup.taskCoordinator,
          taskId: lookup.taskId,
          taskDigest: anchor,
        });
      }) as never;
      const warnings: string[] = [];
      const enrich = createProjectorEnrich({
        chain: CHAIN,
        publicClient,
        fetchIpfsBytes: async () => undefined,
        fetchDeliveryBytes,
        fetchTaskBytes: fetchDeliveryBytes,
        resolveSubmissionBytes,
        allowLegacySignedTaskV1: false,
        readTodayDeliveryFacts,
        resolveDispatchContext: buildDerivedRequesterDispatchContextPort({
          resolveSubmissionBytes,
          readOnChainTaskDigest,
          generation: 'today',
        }),
        resolveRecordPlaneDelivery: buildRecordPlaneSolutionDeliveryPort({
          resolveSubmissionBytes,
          readOnChainTaskDigest,
          readTodayDeliveryFacts,
          fetchDeliveryBytes,
          listRecordPlaneDigests: () => [...recordPlane.keys()] as `sha256:${string}`[],
          engagementLedger: { get: () => undefined } as never,
          logger: { warn: (message) => warnings.push(message) },
        }),
        logger: { warn: (message) => warnings.push(message) },
      });

      async function project(
        events: readonly MarketplaceEvent[],
        previous: MarketplaceProjectionState,
      ): Promise<MarketplaceProjectionState> {
        const enriched = [];
        for (const event of events) {
          const admitted = await enrich(event);
          if (admitted !== undefined) enriched.push(admitted);
        }
        const transition = reduceMarketplaceProjection(enriched, previous);
        posted.observations.push(...transition.observations);
        return transition.state;
      }

      let state = await project([VERDICT_EVENT], createMarketplaceProjectionState());
      const earlier = earlierEvents(association.taskDigest);
      state = await project(earlier, state);

      // The engagement still derives — only the delivery leg is blind.
      expect(posted.observations.filter(
        ({ type }) => type === 'network.jinn.task-execution.attempt-engaged.v1',
      )).toHaveLength(1);

      // NO false rejection. The only terminal is the verdict's own, exactly as on the happy path.
      const terminals = posted.observations.filter(
        ({ type }) => type === 'network.jinn.task-execution.attempt-terminal.v1',
      );
      expect(terminals).toHaveLength(1);
      expect(terminals[0]!.data).toMatchObject({ state: 'failed', category: 'result-unavailable' });
      expect(terminals.some(({ data }) => (data as { category?: string }).category === 'invalid-reference'))
        .toBe(false);

      // The Attempt does NOT fold contradictory — the state that made adoption unrecoverable.
      const blindSnapshot = await posted.observe.observe(association.submissionUri);
      expect(blindSnapshot.descriptor.derived.contradictory).toBe(false);
      expect(blindSnapshot.descriptor.derived.deliveries).toEqual([]);

      // REPLAYABLE: the dropped `SolutionDeliveryClaimed` never entered the journal, so a later
      // rewind re-offers it. Its three siblings did journal.
      const solutionClaimed = earlier.find(({ event }) => event === 'SolutionDeliveryClaimed')!;
      expect(state.processedLogIds).not.toContain(logIdentity(solutionClaimed));
      for (const sibling of earlier.filter(({ event }) => event !== 'SolutionDeliveryClaimed')) {
        expect(state.processedLogIds).toContain(logIdentity(sibling));
      }

      // Loud and diagnosable: role, the anchor to search the plane for, and the cause.
      const drop = warnings.find((line) => line.includes('role=requester DROPPING'));
      expect(drop).toBeDefined();
      expect(drop).toContain(keccakEvidenceHash(deliveryBytes));
      expect(drop).toContain('unfetchable');

      // ---- Plane back up; the SAME process, the SAME resolver instance, one more rewind. ----
      deliveryPlaneDown = false;
      state = await project([solutionClaimed], state);

      const recorded = posted.observations.filter(
        ({ type }) => type === 'network.jinn.task-execution.delivery-recorded.v1',
      );
      expect(recorded).toHaveLength(1);
      expect((recorded[0]!.data as { digest: string }).digest).toBe(deliveryDigest);
      expect(state.processedLogIds).toContain(logIdentity(solutionClaimed));

      const healed = await posted.observe.observe(association.submissionUri);
      expect(healed.descriptor.derived.contradictory).toBe(false);
      expect(healed.descriptor.derived.deliveries).toEqual([{ digest: deliveryDigest }]);

      // And adoption, the whole point, now completes.
      const adoptable = buildFleetRequesterWrite({
        requesterAgent: 'urn:jinn:requester:defect-48',
        admissionAgent: 'urn:jinn:admission:defect-48',
        publicBaseUrl: 'https://requester.invalid',
        requesterStateDir: stateDir,
        creatorSafe: REQUESTER_SAFE,
        roles: posted.identities,
        safeBroadcast: { broadcastCreateTask: async () => ({ taskId: TASK_ID, txHash: TX_HASH }) },
        intents: posted.intents,
        observe: posted.observe,
        ipfsPin: { pin: async () => {} },
        authorityTime: async () => AUTHORITY_TIME,
        canonicalTaskCreated: async (expected) => ({ canonical: true as const, ...expected }),
        adoptionReceipts: createFileAdoptionReceiptStore({ dir: join(stateDir, 'adoptions') }),
        recordPlaneBytes: fetchDeliveryBytes,
        now: () => new Date('2026-08-12T13:00:00.000Z'),
      });
      expect(await adoptable.adopt()).toEqual([{
        attempt: ATTEMPT_URI,
        taskId: TASK_ID.toString(10),
        disposition: 'accepted',
        deliveryDigest,
        decidedAt: '2026-08-12T13:00:00.000Z',
      }]);

      posted.state.close();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('keeps the SOLVER mech-fact requirement: a claimed attempt resolves no record-plane delivery', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-defect-48-solver-'));
    try {
      const posted = await postTask(stateDir);
      const [associationName] = await readdir(join(stateDir, 'associations'));
      const association = JSON.parse(
        await readFile(join(stateDir, 'associations', associationName!), 'utf8'),
      ) as { taskDigest: `sha256:${string}` };

      const deliveryBytes = sealDelivery({
        protocol: 'https://spec.jinn.network/task-execution/v1',
        attempt: ATTEMPT_URI,
        task: association.taskDigest,
        outputs: [],
        outcome: 'fulfilled',
        createdAt: '2026-08-12T12:10:00.000Z',
      });
      const deliveryDigest = documentDigest(deliveryBytes);
      const publicClient = {
        getBlock: async () => ({ timestamp: BLOCK_TIMESTAMP }),
        ...chainReads({
          taskDigest: association.taskDigest,
          solutionCidDigest: keccakEvidenceHash(deliveryBytes),
        }),
      } as never;
      const readOnChainTaskDigest = buildReadOnChainTaskDigest(publicClient, CHAIN.taskCoordinator);
      const resolveAssociation = createNativeRequesterSubmissionResolver({
        stateDir,
        requesterSubmission: posted.identities.verifier,
      });
      const resolveSubmissionBytes = (async (lookup: {
        chainId: number;
        taskCoordinator: Address;
        taskId: bigint;
      }) => resolveAssociation({
        chainId: lookup.chainId,
        coordinator: lookup.taskCoordinator,
        taskId: lookup.taskId,
        taskDigest: association.taskDigest,
      })) as never;
      const port = (engagementLedger: unknown) => buildRecordPlaneSolutionDeliveryPort({
        resolveSubmissionBytes,
        readOnChainTaskDigest,
        readTodayDeliveryFacts: buildReadTodayDeliveryFacts(publicClient, CHAIN.taskCoordinator),
        fetchDeliveryBytes: async (digest) => (digest === deliveryDigest ? deliveryBytes : undefined),
        listRecordPlaneDigests: () => [deliveryDigest],
        engagementLedger: engagementLedger as never,
      });
      const lookup = {
        chainId: CHAIN.chainId,
        taskCoordinator: CHAIN.taskCoordinator,
        taskId: TASK_ID,
        attemptIndex: ATTEMPT_INDEX,
        requestId: SOLUTION_REQUEST_ID,
        operator: SOLVER_B,
      };

      // Requester (no ledger row): resolves, so the reducer gets its record-plane witness.
      await expect(port({ get: () => undefined })(lookup)).resolves.toMatchObject({
        role: 'requester',
        witness: { sha256Digest: deliveryDigest },
      });

      // SOLVER (a ledger row naming this exact attempt): refuses with a PLAIN `undefined`, the
      // ROLE-half answer. That is what routes the reducer back to its untouched mech-fact logic,
      // and it must stay distinguishable from the requester-without-witness signal (asserted in
      // the outage test below), which routes to a drop instead.
      await expect(
        port({ get: () => ({ attemptUri: ATTEMPT_URI }) })(lookup),
      ).resolves.toBeUndefined();

      // A ledger row for a DIFFERENT attempt of the same task does not suppress the requester leg.
      await expect(
        port({ get: () => ({ attemptUri: 'urn:uuid:00000000-0000-4000-8000-000000000000' }) })(lookup),
      ).resolves.toMatchObject({ role: 'requester', witness: { sha256Digest: deliveryDigest } });

      posted.state.close();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('refuses a record-plane candidate whose bytes do not hash to the coordinator anchor', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-defect-48-tamper-'));
    try {
      const posted = await postTask(stateDir);
      const [associationName] = await readdir(join(stateDir, 'associations'));
      const association = JSON.parse(
        await readFile(join(stateDir, 'associations', associationName!), 'utf8'),
      ) as { taskDigest: `sha256:${string}` };

      const realBytes = sealDelivery({
        protocol: 'https://spec.jinn.network/task-execution/v1',
        attempt: ATTEMPT_URI,
        task: association.taskDigest,
        outputs: [],
        outcome: 'fulfilled',
        createdAt: '2026-08-12T12:10:00.000Z',
      });
      // A different, well-formed Delivery for the same Attempt — a substitution attempt. It is on
      // the record plane; it is simply not the one the coordinator anchored.
      const substituteBytes = sealDelivery({
        protocol: 'https://spec.jinn.network/task-execution/v1',
        attempt: ATTEMPT_URI,
        task: association.taskDigest,
        outputs: [],
        outcome: 'partial',
        createdAt: '2026-08-12T12:12:00.000Z',
      });
      const substituteDigest = documentDigest(substituteBytes);
      const publicClient = {
        getBlock: async () => ({ timestamp: BLOCK_TIMESTAMP }),
        ...chainReads({
          taskDigest: association.taskDigest,
          solutionCidDigest: keccakEvidenceHash(realBytes),
        }),
      } as never;
      const readOnChainTaskDigest = buildReadOnChainTaskDigest(publicClient, CHAIN.taskCoordinator);
      const resolveAssociation = createNativeRequesterSubmissionResolver({
        stateDir,
        requesterSubmission: posted.identities.verifier,
      });
      const resolved = await buildRecordPlaneSolutionDeliveryPort({
        resolveSubmissionBytes: (async (lookup: { chainId: number; taskCoordinator: Address; taskId: bigint }) =>
          resolveAssociation({
            chainId: lookup.chainId,
            coordinator: lookup.taskCoordinator,
            taskId: lookup.taskId,
            taskDigest: association.taskDigest,
          })) as never,
        readOnChainTaskDigest,
        readTodayDeliveryFacts: buildReadTodayDeliveryFacts(publicClient, CHAIN.taskCoordinator),
        // The plane serves ONLY the substitute; the anchored bytes are unreachable.
        fetchDeliveryBytes: async (digest) => (digest === substituteDigest ? substituteBytes : undefined),
        listRecordPlaneDigests: () => [substituteDigest],
        engagementLedger: { get: () => undefined } as never,
      })({
        chainId: CHAIN.chainId,
        taskCoordinator: CHAIN.taskCoordinator,
        taskId: TASK_ID,
        attemptIndex: ATTEMPT_INDEX,
        requestId: SOLUTION_REQUEST_ID,
        operator: SOLVER_B,
      });
      // Refused — no witness. But the refusal is REQUESTER-shaped, not the solver's plain
      // `undefined`: this operator did post the task, so `enrich` must drop the event rather than
      // hand it to the reducer's mech-fact path and get a permanent false rejection.
      expect(resolved).toMatchObject({ role: 'requester', witness: undefined });
      expect((resolved as { onChainKeccak: Hex }).onChainKeccak).toBe(keccakEvidenceHash(realBytes));

      posted.state.close();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('Gate A: the sealed-ledger resolver alone cannot serve a task this operator did not claim', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-defect-48-gate-a-'));
    try {
      const posted = await postTask(stateDir);
      const [associationName] = await readdir(join(stateDir, 'associations'));
      const association = JSON.parse(
        await readFile(join(stateDir, 'associations', associationName!), 'utf8'),
      ) as { taskDigest: `sha256:${string}`; submissionUri: `urn:uuid:${string}`; nonce: string };

      const publicClient = {
        getBlock: async () => ({ timestamp: BLOCK_TIMESTAMP }),
        ...chainReads({
          taskDigest: association.taskDigest,
          solutionCidDigest: `0x${'b'.repeat(64)}` as Hex,
        }),
      } as never;
      const lookup = {
        chainId: CHAIN.chainId,
        taskCoordinator: CHAIN.taskCoordinator,
        taskId: TASK_ID,
        attemptIndex: ATTEMPT_INDEX,
        actor: SOLVER_B,
      };

      // THE PRE-#48 BEHAVIOR, pinned: the claim-time seal is the only source, and a requester has
      // no row for an attempt another operator claimed. `enrich` drops `TaskAttemptCreated` on
      // exactly this `undefined`, which is why `attempt-engaged` never existed.
      const { buildEngagementLedgerDispatchContextPort } = await import('../../src/daemon/composition-root.js');
      const sealedOnly = buildEngagementLedgerDispatchContextPort({ get: () => undefined } as never);
      expect(await sealedOnly(lookup)).toBeUndefined();

      // The derivation covers it, and reproduces the SOLVER's sealed document bit-for-bit: the
      // digest below is `documentDigest(serializeCanonicalJson({taskDigest, submission, nonce,
      // attempt}))` — the same four fields `claim.ts` seals, canonicalized the same way.
      const derived = await buildDerivedRequesterDispatchContextPort({
        resolveSubmissionBytes: (async (input: { chainId: number; taskCoordinator: Address; taskId: bigint }) =>
          createNativeRequesterSubmissionResolver({
            stateDir,
            requesterSubmission: posted.identities.verifier,
          })({
            chainId: input.chainId,
            coordinator: input.taskCoordinator,
            taskId: input.taskId,
            taskDigest: association.taskDigest,
          })) as never,
        readOnChainTaskDigest: buildReadOnChainTaskDigest(publicClient, CHAIN.taskCoordinator),
        generation: 'today',
      })(lookup);
      const expected = documentDigest(serializeCanonicalJson({
        taskDigest: association.taskDigest,
        submission: association.submissionUri,
        nonce: association.nonce,
        attempt: ATTEMPT_URI,
      } as never));
      expect(derived).toEqual({
        uri: `urn:jinn:marketplace:dispatch-context:${ATTEMPT_URI}`,
        digest: { sha256: expected.slice('sha256:'.length) },
      });

      posted.state.close();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
