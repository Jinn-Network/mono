/**
 * Issue #2647 — the last sibling of defect #48: a transient chain-read failure must never be
 * reported as "this operator is not the requester".
 *
 * #2644 split the record-plane delivery resolver's answer into a ROLE half (`undefined` = not the
 * requester, the reducer's untouched mech-fact path decides) and a CONTENT half
 * (`{ role: 'requester', witness: undefined }` = drop, replayable). It left one leg on the wrong
 * side of that split: gate 1's `readTodayDeliveryFacts` ran BEFORE the role was settled and
 * swallowed every read error into the same `undefined` the not-the-requester answer uses. A
 * momentary RPC failure on `getRequestRef`/`getAttempt` therefore produced the exact permanent
 * false `rejected`/`invalid-reference` terminal the #2644 fix exists to prevent — folding the
 * Attempt `contradictory` beside the verdict's terminal and wedging `adoptPostedTask` forever.
 *
 * The remedy is an ORDERING fact plus a CLASSIFICATION fact, and both are pinned here:
 *
 *   - Gate 3 (free) → the on-chain Task anchor → gate 2 (own signed Submission; the role settles)
 *     → gate 1 (delivery facts) → gate 4 (content). Everything that can fail transiently now runs
 *     with the role already known, so its failure is a drop.
 *   - Every `TaskCoordinator` view this path reads is a plain mapping read that CANNOT revert for
 *     an unknown key (`contracts/src/tasks/TaskCoordinator.sol:437-465`): an unknown task returns
 *     an all-zero record, an unknown requestId returns `exists: false`. A THROW from any of them is
 *     therefore unambiguously transport, never absence — which is what makes the classification
 *     below sound rather than a guess.
 *
 * The scenario and its fixtures mirror `requester-adoption-defect-48.test.ts` (operator A posted
 * task 1236, operator B claimed/delivered/settled through B's own mech) so the two files pin the
 * same live shape from opposite failure directions: there the RECORD PLANE is down, here the RPC
 * is. Everything load-bearing is the production path — the real exported resolvers, the real
 * reducer, the real SQLite-backed observe port.
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
import { documentDigest, sealDelivery } from '@jinn-network/task-execution-protocol';
import type { Address, Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import {
  buildDerivedRequesterDispatchContextPort,
  buildReadOnChainTaskDigest,
  buildReadTodayDeliveryFacts,
  buildRecordPlaneSolutionDeliveryPort,
} from '../../src/daemon/composition-root.js';
import { buildFleetRequesterWrite } from '../../src/daemon/native-fleet-requester-write.js';
import { createProjectorEnrich } from '../../src/daemon/projector-enrich.js';
import { createFileAdoptionReceiptStore } from '../../src/daemon/native-adoption-receipt-store.js';
import {
  createNativeRequesterSubmissionResolver,
  type NativeRequesterRoles,
} from '../../src/native-requester/requester.js';

const CHAIN = BASE_SEPOLIA_TODAY;
const REQUESTER_SAFE = '0x1111111111111111111111111111111111111111' as Address;
const SOLVER_B = '0xc679BD172f6c6bA0f6437d26361E92BD9b7995C3' as Address;
const SOLVER_MECH_B = '0x2222222222222222222222222222222222222222' as Address;
const EVALUATOR_A = '0x3333333333333333333333333333333333333333' as Address;
const EVALUATOR_MECH_A = '0x4444444444444444444444444444444444444444' as Address;
const SOLUTION_REQUEST_ID = `0x${'a1'.repeat(32)}` as Hex;
const VERDICT_REQUEST_ID = `0x${'b2'.repeat(32)}` as Hex;
const TASK_ID = 1236n;
const ATTEMPT_INDEX = 0;
const TX_HASH = `0x${'ef'.repeat(32)}` as Hex;
const BLOCK_HASH = `0x${'cd'.repeat(32)}` as Hex;
const BLOCK_TIMESTAMP = 1_786_000_000n;
const AUTHORITY_TIME = {
  chainId: 84532 as const,
  blockNumber: '45415000',
  blockHash: BLOCK_HASH,
  timestamp: '2026-08-12T11:59:00.000Z',
  finalized: true as const,
};
const TARGET = { postingKey: 'issue-2647', spec: {} } as never;

const ATTEMPT_URI = deriveMarketplaceAttemptUri({
  chainId: CHAIN.chainId,
  coordinator: CHAIN.taskCoordinator,
  taskId: TASK_ID,
  attemptIndex: ATTEMPT_INDEX,
});

/** The RPC outage this file is about: an isolated failure of the two delivery-fact reads. */
class RpcFailure extends Error {
  constructor(functionName: string) {
    super(`HTTP request failed: 503 Service Unavailable (${functionName})`);
  }
}

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
    contract: CHAIN.jinnRouter,
    event,
    blockNumber,
    blockHash: `0x${blockNumber.toString(16).padStart(64, '0')}` as Hex,
    txHash: `${TX_HASH.slice(0, 62)}${logIndex.toString(16).padStart(4, '0')}` as Hex,
    logIndex,
    finalityTier: 'finalized',
    contractGeneration: 'today',
  };
}

/** The verdict operator A's own evaluator settled — journaled by the narrow replay that ran live. */
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

/** `packages/marketplace/projector/src/observe.ts`'s `logIdentity`, for the journal check. */
function logIdentity(event: MarketplaceEvent): string {
  const { chainId, contract, blockHash, txHash, logIndex } = event.derivation;
  return [chainId, contract.toLowerCase(), blockHash.toLowerCase(), txHash.toLowerCase(), logIndex].join(':');
}

/**
 * The exact `readContract` surface the production readers decode, with a per-view failure switch.
 * `failing` names the views that are currently unreachable — the RPC outage, not a contract state.
 */
function chainReads(input: {
  readonly taskDigest: `sha256:${string}`;
  readonly solutionCidDigest: Hex;
  readonly failing?: () => ReadonlySet<string>;
}): { readContract: (args: { functionName: string; args: readonly unknown[] }) => Promise<unknown> } {
  const taskAnchor = `0x${input.taskDigest.slice('sha256:'.length)}` as Hex;
  return {
    async readContract({ functionName, args }) {
      if (input.failing?.().has(functionName) === true) throw new RpcFailure(functionName);
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
          return args[0] === SOLUTION_REQUEST_ID ? [TASK_ID, ATTEMPT_INDEX, true] : [0n, 0, false];
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
          return args[0] === VERDICT_REQUEST_ID ? [TASK_ID, ATTEMPT_INDEX, 0, true] : [0n, 0, 0, false];
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
    requesterAgent: 'urn:jinn:requester:issue-2647',
    admissionAgent: 'urn:jinn:admission:issue-2647',
    publicBaseUrl: 'https://requester.invalid',
    requesterStateDir: stateDir,
    creatorSafe: REQUESTER_SAFE,
    roles: identities,
    safeBroadcast: { broadcastCreateTask: async () => ({ taskId: TASK_ID, txHash: TX_HASH }) },
    intents,
    observe,
    ipfsPin: { pin: async () => {} },
    authorityTime: async () => AUTHORITY_TIME,
    canonicalTaskCreated: async (expected) => ({ canonical: true as const, ...expected }),
    adoptionReceipts: createFileAdoptionReceiptStore({ dir: join(stateDir, 'adoptions') }),
    now: () => new Date('2026-08-12T12:00:00.000Z'),
  });
  await write.postTarget(TARGET);
  return { identities, intents, state, observations, observe };
}

describe('buildReadTodayDeliveryFacts classification (#2647)', () => {
  const COORDINATOR = '0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98' as Address;
  const ANCHOR = `0x${'7'.repeat(64)}` as Hex;

  function reader(readContract: (args: { functionName: string; args: readonly unknown[] }) => Promise<unknown>) {
    return buildReadTodayDeliveryFacts({ readContract } as never, COORDINATOR);
  }

  it('resolves the solution leg when the request reference exists', async () => {
    const read = reader(async ({ functionName }) => (functionName === 'getRequestRef'
      ? [TASK_ID, ATTEMPT_INDEX, true]
      : { solutionCidDigest: ANCHOR }));

    await expect(read(SOLUTION_REQUEST_ID)).resolves.toEqual({
      taskId: TASK_ID,
      attemptIndex: ATTEMPT_INDEX,
      onChainKeccak: ANCHOR,
    });
  });

  it('reports a genuine absence — the requestId is in NEITHER map — as `undefined`', async () => {
    // Both views are plain mapping reads: an unknown requestId returns `exists: false`, never a
    // revert. This is the one shape that legitimately means "not this operator's attempt".
    const read = reader(async ({ functionName }) => (functionName === 'getRequestRef'
      ? [0n, 0, false]
      : [0n, 0, 0, false]));

    await expect(read(SOLUTION_REQUEST_ID)).resolves.toBeUndefined();
  });

  it('reports a THROWN read as `unavailable`, never as the same absence', async () => {
    // The solution leg throws; the verdict leg answers "not mine" (correctly — this requestId is a
    // solution request). Before #2647 those two facts collapsed into one `undefined`.
    const read = reader(async ({ functionName }) => {
      if (functionName === 'getRequestRef') throw new RpcFailure(functionName);
      return [0n, 0, 0, false];
    });

    await expect(read(SOLUTION_REQUEST_ID)).resolves.toBe('unavailable');
  });

  it('reports a thrown SECOND-hop read (`getAttempt`) as `unavailable` too', async () => {
    const read = reader(async ({ functionName }) => {
      if (functionName === 'getRequestRef') return [TASK_ID, ATTEMPT_INDEX, true];
      if (functionName === 'getAttempt') throw new RpcFailure(functionName);
      return [0n, 0, 0, false];
    });

    await expect(read(SOLUTION_REQUEST_ID)).resolves.toBe('unavailable');
  });

  it('still answers off the VERDICT leg when only the solution leg is unreachable', async () => {
    // The fall-through the original catch exists for: the two maps are disjoint, so a solution-leg
    // failure must not hide a verdict-leg answer. Widening the failure signal must not cost this.
    const read = reader(async ({ functionName }) => {
      if (functionName === 'getRequestRef') throw new RpcFailure(functionName);
      if (functionName === 'getVerdictRequestRef') return [TASK_ID, ATTEMPT_INDEX, 0, true];
      return { verdictCidDigest: ANCHOR };
    });

    await expect(read(VERDICT_REQUEST_ID)).resolves.toEqual({
      taskId: TASK_ID,
      attemptIndex: ATTEMPT_INDEX,
      onChainKeccak: ANCHOR,
    });
  });
});

describe('the requester role settles before the delivery-facts anchor read (#2647)', () => {
  /**
   * (a) THE DEFECT. Gate 1's chain read fails while the record plane is perfectly healthy. The
   * role is knowable — this operator posted the task and holds the signed Submission — so the
   * answer must be the requester's DROP, never the not-the-requester miss that lets the reducer
   * emit a permanent false rejection.
   *
   * RED before the reorder: gate 1 ran first, its failure returned `undefined`, and this test saw
   * a second `attempt-terminal` with `category: 'invalid-reference'`, `contradictory: true`, and
   * the event JOURNALED — unrecoverable.
   */
  it('drops (never rejects) when the anchor read fails, and recovers on the next replay', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-2647-anchor-read-'));
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
      const solutionCidDigest = keccakEvidenceHash(deliveryBytes);
      const recordPlane = new Map<string, Uint8Array>([[deliveryDigest, deliveryBytes]]);
      const taskBytes = new Uint8Array(await readFile(join(stateDir, 'discovery', association.task.path)));
      recordPlane.set(association.taskDigest, taskBytes);
      // The plane is UP throughout: the only thing broken is the RPC, and only for the two
      // delivery-fact views. Everything the role determination needs still reads.
      const fetchDeliveryBytes = async (digest: `sha256:${string}`) => recordPlane.get(digest);

      let rpcDown = true;
      const publicClient = {
        getBlock: async () => ({ timestamp: BLOCK_TIMESTAMP }),
        ...chainReads({
          taskDigest: association.taskDigest,
          solutionCidDigest,
          failing: () => (rpcDown ? new Set(['getRequestRef', 'getAttempt']) : new Set<string>()),
        }),
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
        if (anchor === undefined || anchor === 'unavailable') return undefined;
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

      // NO false rejection: the only terminal is the verdict's own.
      const terminals = posted.observations.filter(
        ({ type }) => type === 'network.jinn.task-execution.attempt-terminal.v1',
      );
      expect(terminals).toHaveLength(1);
      expect(terminals[0]!.data).toMatchObject({ state: 'failed', category: 'result-unavailable' });
      expect(terminals.some(({ data }) => (data as { category?: string }).category === 'invalid-reference'))
        .toBe(false);

      // The Attempt does NOT fold contradictory — the state that made adoption unrecoverable.
      const blind = await posted.observe.observe(association.submissionUri);
      expect(blind.descriptor.derived.contradictory).toBe(false);
      expect(blind.descriptor.derived.deliveries).toEqual([]);

      // REPLAYABLE: the dropped claim never entered the journal; its siblings did.
      const solutionClaimed = earlier.find(({ event }) => event === 'SolutionDeliveryClaimed')!;
      expect(state.processedLogIds).not.toContain(logIdentity(solutionClaimed));
      for (const sibling of earlier.filter(({ event }) => event !== 'SolutionDeliveryClaimed')) {
        expect(state.processedLogIds).toContain(logIdentity(sibling));
      }

      // Loud and diagnosable, and it names the CHAIN read rather than the record plane: an operator
      // reading this line must not go looking at the counterparty's serving plane.
      const drop = warnings.find((line) => line.includes('DROPPING'));
      expect(drop).toBeDefined();
      expect(drop).toContain('role=requester');
      expect(drop).toContain('on-chain delivery facts');
      expect(drop).toContain('unavailable');

      // ---- RPC back; SAME process, SAME resolver instance, one more rewind. ----
      rpcDown = false;
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

      posted.state.close();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  /**
   * (b) The solver path, and the genuine third party, are untouched. Both must keep answering with
   * the PLAIN `undefined` that routes the reducer back to its mech-fact logic — otherwise this fix
   * would trade one false terminal for a fleet-wide stall on every solver's own settlement.
   */
  it('keeps the not-the-requester MISS for the solver and for a third party', async () => {
    const deliveryBytes = sealDelivery({
      protocol: 'https://spec.jinn.network/task-execution/v1',
      attempt: ATTEMPT_URI,
      task: `sha256:${'4'.repeat(64)}`,
      outputs: [],
      outcome: 'fulfilled',
      createdAt: '2026-08-12T12:10:00.000Z',
    });
    const readContract = vi.fn(chainReads({
      taskDigest: `sha256:${'4'.repeat(64)}`,
      solutionCidDigest: keccakEvidenceHash(deliveryBytes),
    }).readContract);
    const publicClient = { readContract } as never;
    const lookup = {
      chainId: CHAIN.chainId,
      taskCoordinator: CHAIN.taskCoordinator,
      taskId: TASK_ID,
      attemptIndex: ATTEMPT_INDEX,
      requestId: SOLUTION_REQUEST_ID,
      operator: SOLVER_B,
    };
    const port = (input: {
      readonly ledgerAttempt?: string;
      readonly submission?: Uint8Array;
    }) => buildRecordPlaneSolutionDeliveryPort({
      resolveSubmissionBytes: (async () => input.submission) as never,
      readOnChainTaskDigest: buildReadOnChainTaskDigest(publicClient, CHAIN.taskCoordinator),
      readTodayDeliveryFacts: buildReadTodayDeliveryFacts(publicClient, CHAIN.taskCoordinator),
      fetchDeliveryBytes: async (digest) => (digest === documentDigest(deliveryBytes) ? deliveryBytes : undefined),
      listRecordPlaneDigests: () => [documentDigest(deliveryBytes)],
      engagementLedger: {
        get: () => (input.ledgerAttempt === undefined ? undefined : { attemptUri: input.ledgerAttempt }),
      } as never,
    });

    // SOLVER — the free gate still runs first, so it costs no chain read at all. That ordering is
    // load-bearing now that the two remaining role gates BOTH read the chain.
    await expect(port({ ledgerAttempt: ATTEMPT_URI })(lookup)).resolves.toBeUndefined();
    expect(readContract).not.toHaveBeenCalled();

    // THIRD PARTY — neither claimant nor poster: no Submission resolves, so the role never settles
    // as requester and the answer stays the plain miss.
    await expect(port({})(lookup)).resolves.toBeUndefined();

    // And the requester, on the same wiring, still resolves its witness.
    await expect(port({ submission: new TextEncoder().encode('{}') })(lookup))
      .resolves.toMatchObject({ role: 'requester', witness: { sha256Digest: documentDigest(deliveryBytes) } });
  });

  /**
   * (c) The other chain read the role determination now depends on. `readOnChainTaskDigest` runs
   * BEFORE the role is settled — it is the anchor gate 2 keys the association on — so its own
   * failure cannot be reported as "not the requester" either. It has no role to claim yet, so it
   * reports `undetermined` with no witness, which `enrich` treats exactly like the requester's
   * drop: replayable, never a rejection.
   */
  it('never reports not-the-requester when the pre-role task-anchor read fails', async () => {
    const deliveryBytes = sealDelivery({
      protocol: 'https://spec.jinn.network/task-execution/v1',
      attempt: ATTEMPT_URI,
      task: `sha256:${'4'.repeat(64)}`,
      outputs: [],
      outcome: 'fulfilled',
      createdAt: '2026-08-12T12:10:00.000Z',
    });
    let taskReadDown = true;
    const publicClient = {
      ...chainReads({
        taskDigest: `sha256:${'4'.repeat(64)}`,
        solutionCidDigest: keccakEvidenceHash(deliveryBytes),
        failing: () => (taskReadDown ? new Set(['getTask']) : new Set<string>()),
      }),
    } as never;
    const warnings: string[] = [];
    const resolve = buildRecordPlaneSolutionDeliveryPort({
      resolveSubmissionBytes: (async () => new TextEncoder().encode('{}')) as never,
      readOnChainTaskDigest: buildReadOnChainTaskDigest(publicClient, CHAIN.taskCoordinator),
      readTodayDeliveryFacts: buildReadTodayDeliveryFacts(publicClient, CHAIN.taskCoordinator),
      fetchDeliveryBytes: async (digest) => (digest === documentDigest(deliveryBytes) ? deliveryBytes : undefined),
      listRecordPlaneDigests: () => [documentDigest(deliveryBytes)],
      engagementLedger: { get: () => undefined } as never,
      logger: { warn: (message) => warnings.push(message) },
    });
    const lookup = {
      chainId: CHAIN.chainId,
      taskCoordinator: CHAIN.taskCoordinator,
      taskId: TASK_ID,
      attemptIndex: ATTEMPT_INDEX,
      requestId: SOLUTION_REQUEST_ID,
      operator: SOLVER_B,
    };

    const blind = await resolve(lookup);
    // NOT `undefined`: that is the one answer that would send the reducer down the mech-fact path
    // and produce the permanent false rejection.
    expect(blind).toBeDefined();
    expect(blind).toMatchObject({ role: 'undetermined', witness: undefined });
    expect((blind as { reason: string }).reason).toContain('unavailable');
    // No anchor to report — gate 1 has not run. The drop log must survive that.
    expect((blind as { onChainKeccak?: Hex }).onChainKeccak).toBeUndefined();

    // Not memoized as a negative: the same resolver instance resolves once the RPC is back.
    taskReadDown = false;
    await expect(resolve(lookup)).resolves.toMatchObject({
      role: 'requester',
      witness: { sha256Digest: documentDigest(deliveryBytes) },
    });
  });
});
