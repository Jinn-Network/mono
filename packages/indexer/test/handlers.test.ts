/**
 * Event-handler tests for the Jinn protocol Ponder indexer.
 *
 * Approach: Ponder 0.16.x ships no first-class unit-test util for indexing
 * functions, and `ponder:registry` / `ponder:schema` are virtual modules the
 * Ponder build resolves — not importable from Vitest. So the handler logic was
 * extracted out of the `ponder.on(...)` registrations in `src/index.ts` into
 * exported pure functions in `src/handlers.ts` (a behaviour-preserving refactor;
 * `src/index.ts` is now thin shims). Those pure functions are tested here
 * against `createInMemoryDb` (test/helpers/in-memory-db.ts), a stub that mirrors
 * the `find / insert / update / onConflictDoNothing / onConflictDoUpdate`
 * surface the handlers use. The real schema-table objects from
 * `ponder.schema.ts` are passed in for table identity.
 *
 * Coverage areas (per jinn-mono-zv80):
 *   1. MetadataSet key routing — manifest key → solverNetManifest; envelope key
 *      → envelope; unrecognized key → ignored.
 *   2. Payload decode with V2→V1 fallback — V2 path, V1 fallback, garbage.
 *   3. Most-recent-wins — later block overwrites; earlier does not; same
 *      block+tx, higher logIndex wins (the PR #138 tiebreak); idempotent replay.
 *   4. SolutionDeliveryClaimed missing-row guard — unknown taskId is skipped,
 *      not crashed; existing task is NOT finalized (finalized stays false —
 *      that event is evaluation-start, not finalization; finalization happens
 *      in VerdictDeliveryClaimed).
 *   5. Task / Attempt folding — TaskCreated → task row; TaskAttemptCreated →
 *      attempt row; shapes match the GraphQL fields operator/src/discovery/http.ts
 *      queries.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { keccak256, toBytes } from 'viem';
import { task, attempt, solverNetManifest, envelope, pluginPublication, verdict, harnessCheckpoint, attemptEnvelopeMeta, verdictEnvelopeMeta, rewardDistribution, stakingService, stakingRewardCheckpoint } from '../ponder.schema.js';
import {
  handleTaskCreated,
  handleTaskAttemptCreated,
  handleSolutionDeliveryClaimed,
  handleMetadataSet,
  handleVerdictDeliveryClaimed,
  handleTaskBudgetRefunded,
  handleRewardsDistributed,
  handleServiceStaked,
  handleStakingCheckpoint,
  parseCheckpointManifestLite,
  parseSolverNetManifestLite,
  parseVerdictEnvelopeLite,
  type HandlerContext,
} from '../src/handlers.js';
import { resolveInstanceFields } from '../src/enrichment-parse.js';
import { createInMemoryDb, type InMemoryDb, type PkMap } from './helpers/in-memory-db.js';
import type { FetchLike } from '../src/ipfs.js';
import {
  taskCreatedEvent,
  taskAttemptCreatedEvent,
  solutionDeliveryClaimedEvent,
  metadataSetEvent,
  lifecyclePayload,
  envelopePayloadV1,
  envelopePayloadV2,
  verdictDeliveryClaimedEvent,
  taskBudgetRefundedEvent,
} from './helpers/events.js';

const CHAIN_ID = 84532;
const MANIFEST_CID = 'bafymanifest';
const ENVELOPE_CID = 'bafyenvelope';
const MANIFEST_HASH = `0x${'ab'.repeat(32)}` as `0x${string}`;
const MANIFEST_HASH_2 = `0x${'cd'.repeat(32)}` as `0x${string}`;

// Primary keys, mirroring ponder.schema.ts.
const PKS: PkMap = new Map<unknown, string[]>([
  [task, ['id']],
  [attempt, ['taskId', 'attemptIndex', 'chainId']],
  [solverNetManifest, ['id']],
  [envelope, ['agentId', 'metadataKey', 'chainId']],
  [pluginPublication, ['id']],
  [verdict, ['taskId', 'attemptIndex', 'verdictIndex', 'chainId']],
  [harnessCheckpoint, ['agentId', 'cid', 'chainId']],
  [attemptEnvelopeMeta, ['requestId', 'publisherAgentId', 'manifestCid', 'chainId']],
  [verdictEnvelopeMeta, ['requestId', 'publisherAgentId', 'manifestCid', 'chainId']],
  [rewardDistribution, ['chainId', 'serviceId', 'claimedAtBlock', 'logIndex']],
  [stakingService, ['chainId', 'stakingProxy', 'serviceId']],
  [stakingRewardCheckpoint, ['chainId', 'stakingProxy', 'epoch', 'serviceId', 'checkpointAtBlock', 'logIndex']],
]);

let db: InMemoryDb;
let context: HandlerContext;

beforeEach(() => {
  db = createInMemoryDb(PKS);
  context = { db, chain: { id: CHAIN_ID } };
});

// ── Area 5: Task / Attempt folding ───────────────────────────────────────────

describe('TaskCreated → task', () => {
  it('creates a task row with the fields operator/discovery/http.ts queries', async () => {
    await handleTaskCreated({
      event: taskCreatedEvent(
        {
          taskId: 7n,
          creator: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
          manifestDigest: `0x${'11'.repeat(32)}`,
          taskCidDigest: `0x${'22'.repeat(32)}`,
          maxClaims: 3,
          requiredVerdicts: 2,
        },
        { block: 41_153_300n, txHash: `0x${'33'.repeat(32)}`, logIndex: 2 },
      ),
      context,
      task,
    });

    const row = db.get(task, { id: '7' });
    expect(row).toBeDefined();
    // Fields TASKS_QUERY in operator/src/discovery/http.ts selects:
    //   id, taskCidDigest, manifestDigest, createdAtBlock, createdAtTx,
    //   claimWindowEnd, maxClaims, chainId  (+ finalized/refunded in `where`)
    expect(row).toMatchObject({
      id: '7',
      manifestDigest: `0x${'11'.repeat(32)}`,
      taskCidDigest: `0x${'22'.repeat(32)}`,
      creator: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      maxClaims: 3,
      requiredVerdicts: 2,
      createdAtBlock: 41_153_300n,
      createdAtTx: `0x${'33'.repeat(32)}`,
      claimWindowStart: null,
      claimWindowEnd: null,
      finalized: false,
      refunded: false,
      chainId: CHAIN_ID,
    });
  });

  it('is idempotent — a replayed TaskCreated does not clobber the existing row', async () => {
    const ev = taskCreatedEvent({ taskId: 7n, maxClaims: 3 });
    await handleTaskCreated({ event: ev, context, task });
    // Replay with a different maxClaims; onConflictDoNothing must keep the first.
    await handleTaskCreated({
      event: taskCreatedEvent({ taskId: 7n, maxClaims: 99 }),
      context,
      task,
    });
    expect(db.count(task)).toBe(1);
    expect(db.get(task, { id: '7' })?.maxClaims).toBe(3);
  });

  it('issue #1304: defaults missing tokenless requiredVerdicts to 1', async () => {
    await handleTaskCreated({
      event: taskCreatedEvent({ taskId: 7n, requiredVerdicts: undefined }),
      context,
      task,
    });

    expect(db.get(task, { id: '7' })?.requiredVerdicts).toBe(1);
  });

  it('issue #1304: a tokenless task with missing requiredVerdicts finalizes on the first verdict', async () => {
    await handleTaskCreated({
      event: taskCreatedEvent({ taskId: 7n, requiredVerdicts: undefined }),
      context,
      task,
    });

    await handleVerdictDeliveryClaimed({
      event: verdictDeliveryClaimedEvent({ taskId: 7n, attemptIndex: 0, verdictIndex: 0 }, { block: 100n }),
      context,
      verdict,
      task,
    });

    expect(db.get(task, { id: '7' })?.finalized).toBe(true);
  });
});

describe('TaskAttemptCreated → attempt', () => {
  it('creates an attempt linked to its task with the fields the GraphQL query needs', async () => {
    await handleTaskCreated({ event: taskCreatedEvent({ taskId: 7n }), context, task });
    await handleTaskAttemptCreated({
      event: taskAttemptCreatedEvent(
        {
          taskId: 7n,
          attemptIndex: 2,
          requestId: `0x${'44'.repeat(32)}`,
          operator: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          priorityMech: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          deliveryRate: 12_345n,
        },
        { block: 41_153_310n },
      ),
      context,
      attempt,
    });

    const row = db.get(attempt, { taskId: '7', attemptIndex: 2, chainId: CHAIN_ID });
    expect(row).toBeDefined();
    // ATTEMPTS_FOR_TASKS_QUERY selects: taskId, operator, attemptIndex.
    expect(row).toMatchObject({
      taskId: '7',
      attemptIndex: 2,
      operator: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      requestId: `0x${'44'.repeat(32)}`,
      priorityMech: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      deliveryRate: 12_345n,
      createdAtBlock: 41_153_310n,
      chainId: CHAIN_ID,
    });
  });

  it('allows multiple attempts per task (composite PK on taskId, attemptIndex, chainId)', async () => {
    await handleTaskAttemptCreated({
      event: taskAttemptCreatedEvent({ taskId: 7n, attemptIndex: 0 }),
      context,
      attempt,
    });
    await handleTaskAttemptCreated({
      event: taskAttemptCreatedEvent({ taskId: 7n, attemptIndex: 1 }),
      context,
      attempt,
    });
    expect(db.count(attempt)).toBe(2);
  });

  it('is idempotent — a replayed TaskAttemptCreated is a no-op', async () => {
    await handleTaskAttemptCreated({
      event: taskAttemptCreatedEvent({ taskId: 7n, attemptIndex: 0, deliveryRate: 10n }),
      context,
      attempt,
    });
    await handleTaskAttemptCreated({
      event: taskAttemptCreatedEvent({ taskId: 7n, attemptIndex: 0, deliveryRate: 999n }),
      context,
      attempt,
    });
    expect(db.count(attempt)).toBe(1);
    expect(db.get(attempt, { taskId: '7', attemptIndex: 0, chainId: CHAIN_ID })?.deliveryRate).toBe(10n);
  });
});

describe('RewardsDistributed → rewardDistribution', () => {
  it('records collectorAmount as the operator OLAS reward for the service multisig', async () => {
    const event = {
      args: {
        serviceId: 42n,
        multisig: '0xabababababababababababababababababababab' as `0x${string}`,
        collectorAmount: 3n * 10n ** 18n,
        protocolAmount: 1n,
        curatingAgentAmount: 2n,
      },
      block: { number: 41_200_000n, timestamp: 1_700_000_000n },
      transaction: { hash: `0x${'77'.repeat(32)}` as `0x${string}` },
      log: { logIndex: 5 },
    };

    await handleRewardsDistributed({ event, context, rewardDistribution });
    await handleRewardsDistributed({ event, context, rewardDistribution });

    expect(db.count(rewardDistribution)).toBe(1);
    expect(db.get(rewardDistribution, {
      chainId: CHAIN_ID,
      serviceId: '42',
      claimedAtBlock: 41_200_000n,
      logIndex: 5,
    })).toMatchObject({
      serviceId: '42',
      multisig: '0xabababababababababababababababababababab',
      operatorRewarded: 3n * 10n ** 18n,
      protocolRewarded: 1n,
      curatingAgentRewarded: 2n,
      claimedAtBlock: 41_200_000n,
      claimedAtTimestamp: 1_700_000_000n,
      claimedAtTx: `0x${'77'.repeat(32)}`,
      chainId: CHAIN_ID,
    });
  });
});

describe('StolasStakingProxy staking activity → earned reward rows', () => {
  const stakingProxy = '0x4DB0Fcb877CCd92B6AeEdAaD561DaccB0CCc7E39' as `0x${string}`;
  const multisig = '0xabababababababababababababababababababab' as `0x${string}`;

  it('maps ServiceStaked service ids to the operator multisig', async () => {
    const event = {
      args: {
        epoch: 77n,
        serviceId: 42n,
        owner: '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd' as `0x${string}`,
        multisig,
        nonces: [1n, 2n],
      },
      block: { number: 41_200_000n, timestamp: 1_700_000_000n },
      transaction: { hash: `0x${'88'.repeat(32)}` as `0x${string}` },
      log: { address: stakingProxy, logIndex: 3 },
    };

    await handleServiceStaked({ event, context, stakingService });
    await handleServiceStaked({ event, context, stakingService });

    expect(db.count(stakingService)).toBe(1);
    expect(db.get(stakingService, {
      chainId: CHAIN_ID,
      stakingProxy,
      serviceId: '42',
    })).toMatchObject({
      serviceId: '42',
      stakingProxy,
      owner: '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
      multisig,
      stakedAtBlock: 41_200_000n,
      stakedAtTimestamp: 1_700_000_000n,
      stakedAtTx: `0x${'88'.repeat(32)}`,
      chainId: CHAIN_ID,
    });
  });

  it('stores Checkpoint earned OLAS allocations by mapped service multisig', async () => {
    await handleServiceStaked({
      event: {
        args: {
          epoch: 77n,
          serviceId: 42n,
          owner: '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd' as `0x${string}`,
          multisig,
          nonces: [],
        },
        block: { number: 41_199_900n, timestamp: 1_699_999_000n },
        transaction: { hash: `0x${'88'.repeat(32)}` as `0x${string}` },
        log: { address: stakingProxy, logIndex: 2 },
      },
      context,
      stakingService,
    });

    const checkpointEvent = {
      args: {
        epoch: 78n,
        availableRewards: 100n * 10n ** 18n,
        serviceIds: [42n, 43n],
        rewards: [3n * 10n ** 18n, 5n * 10n ** 18n],
        epochLength: 86_400n,
      },
      block: { number: 41_200_000n, timestamp: 1_700_000_000n },
      transaction: { hash: `0x${'99'.repeat(32)}` as `0x${string}` },
      log: { address: stakingProxy, logIndex: 6 },
    };

    await handleStakingCheckpoint({
      event: checkpointEvent,
      context,
      stakingService,
      stakingRewardCheckpoint,
    });
    await handleStakingCheckpoint({
      event: checkpointEvent,
      context,
      stakingService,
      stakingRewardCheckpoint,
    });

    expect(db.count(stakingRewardCheckpoint)).toBe(1);
    expect(db.get(stakingRewardCheckpoint, {
      chainId: CHAIN_ID,
      stakingProxy,
      epoch: '78',
      serviceId: '42',
      checkpointAtBlock: 41_200_000n,
      logIndex: 6,
    })).toMatchObject({
      serviceId: '42',
      stakingProxy,
      multisig,
      epoch: '78',
      reward: 3n * 10n ** 18n,
      epochLength: 86_400n,
      checkpointAtBlock: 41_200_000n,
      checkpointAtTimestamp: 1_700_000_000n,
      checkpointAtTx: `0x${'99'.repeat(32)}`,
      chainId: CHAIN_ID,
    });
  });

  it('recovers checkpoint multisig from mapServiceInfo when ServiceStaked was missed', async () => {
    const recoveredOwner = '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd' as `0x${string}`;
    const fallbackContext: HandlerContext = {
      ...context,
      client: {
        readContract: async (opts) => {
          expect(opts).toMatchObject({
            address: stakingProxy,
            functionName: 'mapServiceInfo',
            args: [42n],
            blockNumber: 41_200_000n,
          });
          return [multisig, recoveredOwner, 1_700_000_000n, 0n];
        },
      },
    };

    const checkpointEvent = {
      args: {
        epoch: 78n,
        availableRewards: 100n * 10n ** 18n,
        serviceIds: [42n],
        rewards: [3n * 10n ** 18n],
        epochLength: 86_400n,
      },
      block: { number: 41_200_000n, timestamp: 1_700_000_000n },
      transaction: { hash: `0x${'99'.repeat(32)}` as `0x${string}` },
      log: { address: stakingProxy, logIndex: 6 },
    };

    await handleStakingCheckpoint({
      event: checkpointEvent,
      context: fallbackContext,
      stakingService,
      stakingRewardCheckpoint,
    });

    expect(db.get(stakingService, {
      chainId: CHAIN_ID,
      stakingProxy,
      serviceId: '42',
    })).toMatchObject({
      serviceId: '42',
      stakingProxy,
      owner: recoveredOwner,
      multisig,
      stakedAtBlock: 41_200_000n,
      stakedAtTimestamp: 1_700_000_000n,
      stakedAtTx: `0x${'99'.repeat(32)}`,
      chainId: CHAIN_ID,
    });

    expect(db.get(stakingRewardCheckpoint, {
      chainId: CHAIN_ID,
      stakingProxy,
      epoch: '78',
      serviceId: '42',
      checkpointAtBlock: 41_200_000n,
      logIndex: 6,
    })).toMatchObject({
      serviceId: '42',
      stakingProxy,
      multisig,
      epoch: '78',
      reward: 3n * 10n ** 18n,
      epochLength: 86_400n,
      checkpointAtBlock: 41_200_000n,
      checkpointAtTimestamp: 1_700_000_000n,
      checkpointAtTx: `0x${'99'.repeat(32)}`,
      chainId: CHAIN_ID,
    });
  });
});

// ── Area 4: SolutionDeliveryClaimed no longer finalizes (issues #530/#1304) ───
// SolutionDeliveryClaimed is a solution-slot delivery — the START of evaluation,
// not finalization. The finalized flag is recomputed in
// handleVerdictDeliveryClaimed from delivered verdicts; this handler must leave
// finalized untouched.

describe('SolutionDeliveryClaimed', () => {
  it('does NOT mark the task finalized (it is the start of evaluation, not the end)', async () => {
    await handleTaskCreated({ event: taskCreatedEvent({ taskId: 7n }), context, task });
    expect(db.get(task, { id: '7' })?.finalized).toBe(false);
    await handleSolutionDeliveryClaimed({
      event: solutionDeliveryClaimedEvent({ taskId: 7n }),
      context,
      task,
    });
    // finalized must stay false — the task is still Open until a verdict is
    // delivered and handleVerdictDeliveryClaimed recomputes finalization.
    expect(db.get(task, { id: '7' })?.finalized).toBe(false);
  });

  it('skips (does not crash) when the task row does not exist (TaskCreated predates startBlock)', async () => {
    await expect(
      handleSolutionDeliveryClaimed({
        event: solutionDeliveryClaimedEvent({ taskId: 9999n }),
        context,
        task,
      }),
    ).resolves.toBeUndefined();
    expect(db.count(task)).toBe(0);
  });
});

// ── Area 1: MetadataSet key routing ──────────────────────────────────────────

describe('MetadataSet key routing', () => {
  it('routes a solvernet-manifest: key to the solverNetManifest table', async () => {
    await handleMetadataSet({
      event: metadataSetEvent({
        agentId: 5n,
        metadataKey: `solvernet-manifest:${MANIFEST_CID}`,
        metadataValue: lifecyclePayload({ status: 'launched', at: '2026-05-11T00:00:00Z', hash: MANIFEST_HASH }),
      }),
      context,
      solverNetManifest,
      envelope,
      pluginPublication,
      harnessCheckpoint,
      attemptEnvelopeMeta,
      enrichEnvelopes: false,
    });
    expect(db.count(solverNetManifest)).toBe(1);
    expect(db.count(envelope)).toBe(0);
    expect(db.get(solverNetManifest, { id: MANIFEST_CID })).toMatchObject({
      id: MANIFEST_CID,
      cidKeccak: keccak256(toBytes(MANIFEST_CID)),
      launcherAgentId: '5',
      status: 'launched',
      statusUpdatedAt: '2026-05-11T00:00:00Z',
      manifestHash: MANIFEST_HASH,
      chainId: CHAIN_ID,
    });
  });

  it('routes an envelope:/evaluation:/capture: key to the envelope table', async () => {
    for (const kind of ['envelope', 'evaluation', 'capture'] as const) {
      const localDb = createInMemoryDb(PKS);
      const localCtx: HandlerContext = { db: localDb, chain: { id: CHAIN_ID } };
      await handleMetadataSet({
        event: metadataSetEvent({
          agentId: 8n,
          metadataKey: `${kind}:${ENVELOPE_CID}`,
          metadataValue: envelopePayloadV2({ tier: 1, manifestHash: MANIFEST_HASH }),
        }),
        context: localCtx,
        solverNetManifest,
        envelope,
        pluginPublication,
        harnessCheckpoint,
        attemptEnvelopeMeta,
        enrichEnvelopes: false,
      });
      expect(localDb.count(envelope)).toBe(1);
      expect(localDb.count(solverNetManifest)).toBe(0);
      expect(localDb.get(envelope, { agentId: '8', metadataKey: `${kind}:${ENVELOPE_CID}`, chainId: CHAIN_ID })).toMatchObject({
        agentId: '8',
        metadataKey: `${kind}:${ENVELOPE_CID}`,
        kind,
        manifestCid: ENVELOPE_CID,
        manifestHash: MANIFEST_HASH,
        evidenceTier: 'committed',
        chainId: CHAIN_ID,
      });
    }
  });

  it('ignores an unrecognized metadata key', async () => {
    await handleMetadataSet({
      event: metadataSetEvent({
        metadataKey: 'agent-card:something',
        metadataValue: lifecyclePayload({ status: 'launched' }),
      }),
      context,
      solverNetManifest,
      envelope,
      pluginPublication,
      harnessCheckpoint,
      attemptEnvelopeMeta,
      enrichEnvelopes: false,
    });
    expect(db.count(solverNetManifest)).toBe(0);
    expect(db.count(envelope)).toBe(0);
  });
});

// ── Area 2: payload decode with V2 → V1 fallback ─────────────────────────────

describe('envelope payload decode', () => {
  it('decodes a V2-encoded payload (8-field tuple) via the V2 path', async () => {
    await handleMetadataSet({
      event: metadataSetEvent({
        agentId: 1n,
        metadataKey: `envelope:${ENVELOPE_CID}`,
        metadataValue: envelopePayloadV2({ tier: 3, manifestHash: MANIFEST_HASH, implName: 'claude-restorer' }),
      }),
      context,
      solverNetManifest,
      envelope,
      pluginPublication,
      harnessCheckpoint,
      attemptEnvelopeMeta,
      enrichEnvelopes: false,
    });
    const row = db.get(envelope, { agentId: '1', metadataKey: `envelope:${ENVELOPE_CID}`, chainId: CHAIN_ID });
    expect(row).toMatchObject({ manifestHash: MANIFEST_HASH, evidenceTier: 'attested' });
  });

  it('falls back to the V1 path for a V1-encoded payload (5-field tuple)', async () => {
    await handleMetadataSet({
      event: metadataSetEvent({
        agentId: 1n,
        metadataKey: `envelope:${ENVELOPE_CID}`,
        metadataValue: envelopePayloadV1({ tier: 0, manifestHash: MANIFEST_HASH }),
      }),
      context,
      solverNetManifest,
      envelope,
      pluginPublication,
      harnessCheckpoint,
      attemptEnvelopeMeta,
      enrichEnvelopes: false,
    });
    const row = db.get(envelope, { agentId: '1', metadataKey: `envelope:${ENVELOPE_CID}`, chainId: CHAIN_ID });
    expect(row).toMatchObject({ manifestHash: MANIFEST_HASH, evidenceTier: 'self-signed' });
  });

  it('handles a garbage payload without crashing — writes the row with the 0x sentinel hash', async () => {
    await expect(
      handleMetadataSet({
        event: metadataSetEvent({
          agentId: 1n,
          metadataKey: `envelope:${ENVELOPE_CID}`,
          metadataValue: '0xdeadbeef',
        }),
        context,
        solverNetManifest,
        envelope,
        pluginPublication,
        harnessCheckpoint,
        attemptEnvelopeMeta,
        enrichEnvelopes: false,
      }),
    ).resolves.toBeUndefined();
    const row = db.get(envelope, { agentId: '1', metadataKey: `envelope:${ENVELOPE_CID}`, chainId: CHAIN_ID });
    expect(row).toBeDefined();
    expect(row?.manifestHash).toBe('0x');
    expect(row?.evidenceTier).toBe('unknown');
  });

  it('skips a non-JSON solvernet-manifest payload (not a valid lifecycle update)', async () => {
    await expect(
      handleMetadataSet({
        event: metadataSetEvent({
          agentId: 1n,
          metadataKey: `solvernet-manifest:${MANIFEST_CID}`,
          metadataValue: '0xdeadbeef',
        }),
        context,
        solverNetManifest,
        envelope,
        pluginPublication,
        harnessCheckpoint,
        attemptEnvelopeMeta,
        enrichEnvelopes: false,
      }),
    ).resolves.toBeUndefined();
    expect(db.count(solverNetManifest)).toBe(0);
  });
});

// ── Area 3: most-recent-wins ─────────────────────────────────────────────────

describe('solverNetManifest most-recent-wins', () => {
  const manifestKey = `solvernet-manifest:${MANIFEST_CID}`;
  const setManifest = async (
    o: { block: bigint; transactionIndex?: number; logIndex?: number; status: string; hash: `0x${string}`; at?: string },
  ) =>
    handleMetadataSet({
      event: metadataSetEvent(
        {
          agentId: 5n,
          metadataKey: manifestKey,
          metadataValue: lifecyclePayload({ status: o.status, at: o.at ?? `2026-01-0${(Number(o.block) % 9) + 1}T00:00:00Z`, hash: o.hash }),
        },
        { block: o.block, transactionIndex: o.transactionIndex, logIndex: o.logIndex },
      ),
      context,
      solverNetManifest,
      envelope,
      pluginPublication,
      harnessCheckpoint,
      attemptEnvelopeMeta,
      enrichEnvelopes: false,
    });

  it('a later block overwrites an earlier one', async () => {
    await setManifest({ block: 100n, status: 'launched', hash: MANIFEST_HASH });
    await setManifest({ block: 200n, status: 'paused', hash: MANIFEST_HASH_2 });
    expect(db.get(solverNetManifest, { id: MANIFEST_CID })).toMatchObject({
      status: 'paused',
      manifestHash: MANIFEST_HASH_2,
      anchorBlock: 200n,
    });
  });

  it('an earlier block does NOT overwrite a later one', async () => {
    await setManifest({ block: 200n, status: 'paused', hash: MANIFEST_HASH_2 });
    await setManifest({ block: 100n, status: 'launched', hash: MANIFEST_HASH });
    expect(db.get(solverNetManifest, { id: MANIFEST_CID })).toMatchObject({
      status: 'paused',
      manifestHash: MANIFEST_HASH_2,
      anchorBlock: 200n,
    });
  });

  it('same block + same tx index, higher logIndex wins (PR #138 tiebreak)', async () => {
    await setManifest({ block: 100n, transactionIndex: 3, logIndex: 0, status: 'launched', hash: MANIFEST_HASH });
    await setManifest({ block: 100n, transactionIndex: 3, logIndex: 1, status: 'retired', hash: MANIFEST_HASH_2 });
    expect(db.get(solverNetManifest, { id: MANIFEST_CID })).toMatchObject({
      status: 'retired',
      manifestHash: MANIFEST_HASH_2,
      anchorLogIndex: 1,
    });
    // ...and a lower logIndex arriving after the higher one does not win.
    await setManifest({ block: 100n, transactionIndex: 3, logIndex: 0, status: 'launched', hash: MANIFEST_HASH });
    expect(db.get(solverNetManifest, { id: MANIFEST_CID })).toMatchObject({ status: 'retired', anchorLogIndex: 1 });
  });

  it('a replay of the exact same event is a non-destructive no-op', async () => {
    await setManifest({ block: 100n, transactionIndex: 3, logIndex: 1, status: 'paused', hash: MANIFEST_HASH, at: '2026-05-11T00:00:00Z' });
    const before = db.get(solverNetManifest, { id: MANIFEST_CID });
    await setManifest({ block: 100n, transactionIndex: 3, logIndex: 1, status: 'paused', hash: MANIFEST_HASH, at: '2026-05-11T00:00:00Z' });
    expect(db.get(solverNetManifest, { id: MANIFEST_CID })).toEqual(before);
    expect(db.count(solverNetManifest)).toBe(1);
  });
});

// ── VerdictDeliveryClaimed → verdict ─────────────────────────────────────────

describe('VerdictDeliveryClaimed → verdict', () => {
  it('creates a verdict row with all expected fields', async () => {
    await handleVerdictDeliveryClaimed({
      event: verdictDeliveryClaimedEvent(
        {
          taskId: 7n,
          attemptIndex: 0,
          verdictIndex: 0,
          evaluator: `0x${'aa'.repeat(20)}` as `0x${string}`,
          requestId: `0x${'bb'.repeat(32)}` as `0x${string}`,
          verdictCode: 1,
        },
        { block: 41_153_400n },
      ),
      context,
      verdict,
      task,
    });

    const row = db.get(verdict, { taskId: '7', attemptIndex: 0, verdictIndex: 0, chainId: CHAIN_ID });
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      taskId: '7',
      attemptIndex: 0,
      verdictIndex: 0,
      evaluator: `0x${'aa'.repeat(20)}`,
      requestId: `0x${'bb'.repeat(32)}`,
      verdictCode: 1,
      createdAtBlock: 41_153_400n,
      chainId: CHAIN_ID,
    });
  });

  it('is idempotent — a replayed VerdictDeliveryClaimed does not create a duplicate row', async () => {
    const ev = verdictDeliveryClaimedEvent(
      {
        taskId: 7n,
        attemptIndex: 0,
        verdictIndex: 0,
        evaluator: `0x${'aa'.repeat(20)}` as `0x${string}`,
        requestId: `0x${'bb'.repeat(32)}` as `0x${string}`,
        verdictCode: 1,
      },
      { block: 41_153_400n },
    );
    await handleVerdictDeliveryClaimed({ event: ev, context, verdict, task });
    await handleVerdictDeliveryClaimed({ event: ev, context, verdict, task });
    expect(db.count(verdict)).toBe(1);
  });

  it('issue #530: does not finalize below requiredVerdicts (1 of 2 delivered)', async () => {
    await handleTaskCreated({
      event: taskCreatedEvent({ taskId: 7n, requiredVerdicts: 2 }),
      context,
      task,
    });
    await handleVerdictDeliveryClaimed({
      event: verdictDeliveryClaimedEvent({ taskId: 7n, attemptIndex: 0, verdictIndex: 0 }, { block: 100n }),
      context,
      verdict,
      task,
    });
    expect(db.get(task, { id: '7' })?.finalized).toBe(false);
  });

  it('issue #530: finalizes when delivered verdicts reach requiredVerdicts (2 of 2)', async () => {
    await handleTaskCreated({
      event: taskCreatedEvent({ taskId: 7n, requiredVerdicts: 2 }),
      context,
      task,
    });
    await handleVerdictDeliveryClaimed({
      event: verdictDeliveryClaimedEvent({ taskId: 7n, attemptIndex: 0, verdictIndex: 0 }, { block: 100n }),
      context,
      verdict,
      task,
    });
    expect(db.get(task, { id: '7' })?.finalized).toBe(false);
    await handleVerdictDeliveryClaimed({
      event: verdictDeliveryClaimedEvent({ taskId: 7n, attemptIndex: 0, verdictIndex: 1 }, { block: 101n }),
      context,
      verdict,
      task,
    });
    expect(db.get(task, { id: '7' })?.finalized).toBe(true);
  });

  it('issue #530: stays finalized on a replayed (idempotent) verdict event', async () => {
    await handleTaskCreated({
      event: taskCreatedEvent({ taskId: 7n, requiredVerdicts: 1 }),
      context,
      task,
    });
    const ev = verdictDeliveryClaimedEvent({ taskId: 7n, attemptIndex: 0, verdictIndex: 0 }, { block: 100n });
    await handleVerdictDeliveryClaimed({ event: ev, context, verdict, task });
    expect(db.get(task, { id: '7' })?.finalized).toBe(true);
    // Replay: onConflictDoNothing keeps one verdict row; recount is order-independent
    // and must not flip finalized back to false.
    await handleVerdictDeliveryClaimed({ event: ev, context, verdict, task });
    expect(db.count(verdict)).toBe(1);
    expect(db.get(task, { id: '7' })?.finalized).toBe(true);
  });

  it('issue #1304: normalizes persisted requiredVerdicts == 0 rows to first-verdict finalization', async () => {
    await handleTaskCreated({
      event: taskCreatedEvent({ taskId: 7n, requiredVerdicts: 0 }),
      context,
      task,
    });
    await handleVerdictDeliveryClaimed({
      event: verdictDeliveryClaimedEvent({ taskId: 7n, attemptIndex: 0, verdictIndex: 0 }, { block: 100n }),
      context,
      verdict,
      task,
    });
    expect(db.get(task, { id: '7' })?.finalized).toBe(true);
  });

  it('issue #530: skips finalized recompute when the task row is absent (predates startBlock), still writes the verdict', async () => {
    // No handleTaskCreated — the task row does not exist.
    await expect(
      handleVerdictDeliveryClaimed({
        event: verdictDeliveryClaimedEvent({ taskId: 4242n, attemptIndex: 0, verdictIndex: 0 }, { block: 100n }),
        context,
        verdict,
        task,
      }),
    ).resolves.toBeUndefined();
    // Verdict row is still recorded (acceleration data is not lost)...
    expect(db.get(verdict, { taskId: '4242', attemptIndex: 0, verdictIndex: 0, chainId: CHAIN_ID })).toBeDefined();
    // ...and no task row was conjured.
    expect(db.count(task)).toBe(0);
  });

  it('issue #530: counts only the matching attempt scope (other attempts do not bleed into the count)', async () => {
    await handleTaskCreated({
      event: taskCreatedEvent({ taskId: 7n, requiredVerdicts: 2 }),
      context,
      task,
    });
    // One delivered verdict on attempt 0 and one on attempt 1 — neither attempt
    // alone reaches requiredVerdicts=2, so the task must not finalize.
    await handleVerdictDeliveryClaimed({
      event: verdictDeliveryClaimedEvent({ taskId: 7n, attemptIndex: 0, verdictIndex: 0 }, { block: 100n }),
      context,
      verdict,
      task,
    });
    await handleVerdictDeliveryClaimed({
      event: verdictDeliveryClaimedEvent({ taskId: 7n, attemptIndex: 1, verdictIndex: 0 }, { block: 101n }),
      context,
      verdict,
      task,
    });
    expect(db.get(task, { id: '7' })?.finalized).toBe(false);
  });
});

// ── TaskBudgetRefunded → task.refunded ───────────────────────────────────────

describe('TaskBudgetRefunded → task.refunded', () => {
  it('marks an existing task refunded = true', async () => {
    await handleTaskCreated({ event: taskCreatedEvent({ taskId: 7n }), context, task });
    expect(db.get(task, { id: '7' })?.refunded).toBe(false);
    await handleTaskBudgetRefunded({
      event: taskBudgetRefundedEvent({ taskId: 7n }),
      context,
      task,
    });
    expect(db.get(task, { id: '7' })?.refunded).toBe(true);
  });

  it('skips (does not crash) when the task row does not exist (TaskCreated predates startBlock)', async () => {
    await expect(
      handleTaskBudgetRefunded({
        event: taskBudgetRefundedEvent({ taskId: 999n }),
        context,
        task,
      }),
    ).resolves.toBeUndefined();
    expect(db.count(task)).toBe(0);
  });
});


describe('envelope most-recent-wins', () => {
  const key = `envelope:${ENVELOPE_CID}`;
  const setEnvelope = async (o: { block: bigint; logIndex?: number; tier: number; hash: `0x${string}` }) =>
    handleMetadataSet({
      event: metadataSetEvent(
        { agentId: 8n, metadataKey: key, metadataValue: envelopePayloadV2({ tier: o.tier, manifestHash: o.hash }) },
        { block: o.block, logIndex: o.logIndex },
      ),
      context,
      solverNetManifest,
      envelope,
      pluginPublication,
      harnessCheckpoint,
      attemptEnvelopeMeta,
      enrichEnvelopes: false,
    });
  const get = () => db.get(envelope, { agentId: '8', metadataKey: key, chainId: CHAIN_ID });

  it('a later block overwrites an earlier one', async () => {
    await setEnvelope({ block: 100n, tier: 0, hash: MANIFEST_HASH });
    await setEnvelope({ block: 200n, tier: 3, hash: MANIFEST_HASH_2 });
    expect(get()).toMatchObject({ evidenceTier: 'attested', manifestHash: MANIFEST_HASH_2, publishedAtBlock: 200n });
  });

  it('an earlier block does NOT overwrite a later one', async () => {
    await setEnvelope({ block: 200n, tier: 3, hash: MANIFEST_HASH_2 });
    await setEnvelope({ block: 100n, tier: 0, hash: MANIFEST_HASH });
    expect(get()).toMatchObject({ evidenceTier: 'attested', manifestHash: MANIFEST_HASH_2, publishedAtBlock: 200n });
  });

  it('same block, higher logIndex wins; lower logIndex arriving later does not', async () => {
    await setEnvelope({ block: 100n, logIndex: 0, tier: 0, hash: MANIFEST_HASH });
    await setEnvelope({ block: 100n, logIndex: 1, tier: 3, hash: MANIFEST_HASH_2 });
    expect(get()).toMatchObject({ evidenceTier: 'attested', logIndex: 1 });
    await setEnvelope({ block: 100n, logIndex: 0, tier: 0, hash: MANIFEST_HASH });
    expect(get()).toMatchObject({ evidenceTier: 'attested', logIndex: 1 });
  });

  it('a replay of the exact same event is non-destructive (idempotent re-sync)', async () => {
    await setEnvelope({ block: 100n, logIndex: 2, tier: 1, hash: MANIFEST_HASH });
    const before = get();
    await setEnvelope({ block: 100n, logIndex: 2, tier: 1, hash: MANIFEST_HASH });
    expect(get()).toEqual(before);
    expect(db.count(envelope)).toBe(1);
  });
});

// ── MetadataSet harness.checkpoint: → harnessCheckpoint ──────────────────────

describe('MetadataSet harness.checkpoint: → harnessCheckpoint', () => {
  const CHECKPOINT_CID = 'bafyckpt';

  it('writes a harnessCheckpoint row with on-chain anchor fields (value is ignored — CID is in the key)', async () => {
    // The on-chain value for harness.checkpoint:<cid> is the CID string itself,
    // not an ABI-encoded payload. The handler ignores the value entirely.
    await handleMetadataSet({
      event: metadataSetEvent(
        {
          agentId: 42n,
          metadataKey: `harness.checkpoint:${CHECKPOINT_CID}`,
          // value is ignored by the handler; use the raw CID bytes or anything
          metadataValue: '0x',
        },
        { block: 41_300_000n, logIndex: 1 },
      ),
      context,
      solverNetManifest,
      envelope,
      harnessCheckpoint,
      attemptEnvelopeMeta,
      enrichEnvelopes: false,
    });

    const row = db.get(harnessCheckpoint, { agentId: '42', cid: CHECKPOINT_CID, chainId: CHAIN_ID });
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      cid: CHECKPOINT_CID,
      agentId: '42',
      publishedAtBlock: 41_300_000n,
      logIndex: 1,
      chainId: CHAIN_ID,
    });
    // manifestHash and evidenceTier are no longer stored — only the anchor fields.
    expect(row).not.toHaveProperty('manifestHash');
    expect(row).not.toHaveProperty('evidenceTier');
    // Must not pollute envelope or solverNetManifest tables.
    expect(db.count(envelope)).toBe(0);
    expect(db.count(solverNetManifest)).toBe(0);
  });

  it('is idempotent — replaying the same event does not create a duplicate row', async () => {
    const ev = metadataSetEvent(
      {
        agentId: 42n,
        metadataKey: `harness.checkpoint:${CHECKPOINT_CID}`,
        metadataValue: '0x',
      },
      { block: 41_300_000n, logIndex: 1 },
    );
    await handleMetadataSet({ event: ev, context, solverNetManifest, envelope, harnessCheckpoint, attemptEnvelopeMeta, enrichEnvelopes: false });
    await handleMetadataSet({ event: ev, context, solverNetManifest, envelope, harnessCheckpoint, attemptEnvelopeMeta, enrichEnvelopes: false });
    expect(db.count(harnessCheckpoint)).toBe(1);
  });
});

// ── MetadataSet envelope: enrichment → attemptEnvelopeMeta ───────────────────

const ENVELOPE_REQUEST_ID = `0x${'aa'.repeat(32)}` as `0x${string}`;
const SYNTHETIC_ENVELOPE = {
  schemaVersion: 'jinn.execution.v1',
  solverType: 'swe-rebench-v2.v1',
  role: 'restoration',
  task: {
    cid: 'bafytask',
    onchainCreationTx: `0x${'11'.repeat(32)}`,
    onchainCreationBlock: 1,
    requestId: ENVELOPE_REQUEST_ID,
  },
  participant: {
    safeAddress: `0x${'22'.repeat(20)}`,
    agentEoa: `0x${'33'.repeat(20)}`,
  },
  executor: {
    implName: 'claude-code-learner',
    implVersion: '1.2.3',
    clientGitSha: 'abc',
    codeDigest: `sha256:${'bb'.repeat(32)}`,
    runtimeBundleDigest: `sha256:${'cc'.repeat(32)}`,
    plugins: [{ name: 'swe-rebench-v2', version: '1.0', sha256: 'dd'.repeat(32) }],
    signingKey: { kind: 'agent-eoa', pubkey: '0x' },
    mode: 'frozen',
  },
  evidenceTier: 'committed',
  attestation: null,
  trajectory: null,
  artifacts: [],
  payload: {},
  sessionProvenance: undefined,
};

describe('MetadataSet envelope: enrichment → attemptEnvelopeMeta', () => {
  const ENRICH_ENVELOPE_CID = 'bafyenv';

  it('test 1: writes attemptEnvelopeMeta and envelope rows on a successful fetch', async () => {
    const stubFetch: FetchLike = async (_url, _opts) => ({
      ok: true,
      status: 200,
      json: async () => SYNTHETIC_ENVELOPE,
    });

    await handleMetadataSet({
      event: metadataSetEvent(
        {
          agentId: 9n,
          metadataKey: `envelope:${ENRICH_ENVELOPE_CID}`,
          metadataValue: envelopePayloadV2({ tier: 1, manifestHash: MANIFEST_HASH }),
        },
        { block: 41_200_000n, logIndex: 0 },
      ),
      context,
      solverNetManifest,
      envelope,
      harnessCheckpoint,
      attemptEnvelopeMeta,
      enrichEnvelopes: true,
      ipfsGateway: 'https://stub',
      fetchImpl: stubFetch,
    });

    // envelope row must be written (enrichment is additive)
    const envRow = db.get(envelope, { agentId: '9', metadataKey: `envelope:${ENRICH_ENVELOPE_CID}`, chainId: CHAIN_ID });
    expect(envRow).toBeDefined();
    expect(envRow).toMatchObject({
      kind: 'envelope',
      manifestCid: ENRICH_ENVELOPE_CID,
      manifestHash: MANIFEST_HASH,
      evidenceTier: 'committed',
    });

    // attemptEnvelopeMeta row must be written
    const metaRow = db.get(attemptEnvelopeMeta, {
      requestId: ENVELOPE_REQUEST_ID,
      publisherAgentId: '9',
      manifestCid: ENRICH_ENVELOPE_CID,
      chainId: CHAIN_ID,
    });
    expect(metaRow).toBeDefined();
    expect(metaRow).toMatchObject({
      requestId: ENVELOPE_REQUEST_ID,
      manifestCid: ENRICH_ENVELOPE_CID,
      publisherAgentId: '9',
      manifestHash: MANIFEST_HASH,
      solverType: 'swe-rebench-v2.v1',
      implName: 'claude-code-learner',
      implVersion: '1.2.3',
      codeDigest: `sha256:${'bb'.repeat(32)}`,
      mode: 'frozen',
      model: '',
      evidenceTier: 'committed',
      sourcePublished: false,
      enrichmentStatus: 'ok',
      chainId: CHAIN_ID,
    });
    // plugins round-trip
    expect(JSON.parse(metaRow!.pluginsJson as string)).toEqual([
      { name: 'swe-rebench-v2', version: '1.0', sha256: 'dd'.repeat(32) },
    ]);
  });

  it('test 1b: materializes claude-code-learner (with version) into pluginsJson, baseline plugins preserved (#1035)', async () => {
    // A learner run's envelope carries the learner plugin alongside the
    // SolverNet's baseline runtime plugins. The indexer must round-trip all of
    // them into pluginsJson verbatim so a query can partition by
    // claude-code-learner version (AC2/AC3) without dropping the baseline (AC4).
    const learnerEnvelope = {
      ...SYNTHETIC_ENVELOPE,
      executor: {
        ...SYNTHETIC_ENVELOPE.executor,
        plugins: [
          { name: '@jinn-network/network-tools', version: '0.3.0', sha256: 'aa'.repeat(32) },
          { name: 'swe-rebench-v2', version: '1.0', sha256: 'dd'.repeat(32) },
          { name: 'claude-code-learner', version: '0.1.0', sha256: 'cc'.repeat(32) },
        ],
      },
    };
    const stubFetch: FetchLike = async (_url, _opts) => ({
      ok: true,
      status: 200,
      json: async () => learnerEnvelope,
    });

    await handleMetadataSet({
      event: metadataSetEvent(
        {
          agentId: 9n,
          metadataKey: `envelope:${ENRICH_ENVELOPE_CID}`,
          metadataValue: envelopePayloadV2({ tier: 1, manifestHash: MANIFEST_HASH }),
        },
        { block: 41_200_003n, logIndex: 0 },
      ),
      context,
      solverNetManifest,
      envelope,
      harnessCheckpoint,
      attemptEnvelopeMeta,
      enrichEnvelopes: true,
      ipfsGateway: 'https://stub',
      fetchImpl: stubFetch,
    });

    const metaRow = db.get(attemptEnvelopeMeta, {
      requestId: ENVELOPE_REQUEST_ID,
      publisherAgentId: '9',
      manifestCid: ENRICH_ENVELOPE_CID,
      chainId: CHAIN_ID,
    });
    expect(metaRow).toBeDefined();
    // Verbatim round-trip, order-preserving (the indexer does not sort).
    expect(JSON.parse(metaRow!.pluginsJson as string)).toEqual([
      { name: '@jinn-network/network-tools', version: '0.3.0', sha256: 'aa'.repeat(32) },
      { name: 'swe-rebench-v2', version: '1.0', sha256: 'dd'.repeat(32) },
      { name: 'claude-code-learner', version: '0.1.0', sha256: 'cc'.repeat(32) },
    ]);
    // AC3: claude-code-learner version is observable for version-partitioned queries.
    const plugins = JSON.parse(metaRow!.pluginsJson as string) as Array<{ name: string; version: string }>;
    expect(plugins.find((p) => p.name === 'claude-code-learner')?.version).toBe('0.1.0');
  });

  it('test 2: fetch failure — no attemptEnvelopeMeta row, no throw, envelope row IS written', async () => {
    const stubFetch: FetchLike = async (_url, _opts) => ({ ok: false, status: 500, json: async () => null });

    await expect(
      handleMetadataSet({
        event: metadataSetEvent(
          {
            agentId: 9n,
            metadataKey: `envelope:${ENRICH_ENVELOPE_CID}`,
            metadataValue: envelopePayloadV2({ tier: 1, manifestHash: MANIFEST_HASH }),
          },
          { block: 41_200_001n, logIndex: 0 },
        ),
        context,
        solverNetManifest,
        envelope,
        harnessCheckpoint,
        attemptEnvelopeMeta,
        enrichEnvelopes: true,
        ipfsGateway: 'https://stub',
        fetchImpl: stubFetch,
      }),
    ).resolves.toBeUndefined();

    // envelope row written
    expect(db.count(envelope)).toBeGreaterThan(0);
    // no attemptEnvelopeMeta row
    expect(db.count(attemptEnvelopeMeta)).toBe(0);
  });

  it('test 3: enrichEnvelopes: false — no fetch, no attemptEnvelopeMeta row, envelope row written', async () => {
    let fetchCalled = false;
    const stubFetch: FetchLike = async (_url, _opts) => {
      fetchCalled = true;
      return { ok: true, status: 200, json: async () => SYNTHETIC_ENVELOPE };
    };

    await handleMetadataSet({
      event: metadataSetEvent(
        {
          agentId: 9n,
          metadataKey: `envelope:${ENRICH_ENVELOPE_CID}`,
          metadataValue: envelopePayloadV2({ tier: 1, manifestHash: MANIFEST_HASH }),
        },
        { block: 41_200_002n, logIndex: 0 },
      ),
      context,
      solverNetManifest,
      envelope,
      harnessCheckpoint,
      attemptEnvelopeMeta,
      enrichEnvelopes: false,
      ipfsGateway: 'https://stub',
      fetchImpl: stubFetch,
    });

    expect(fetchCalled).toBe(false);
    expect(db.count(attemptEnvelopeMeta)).toBe(0);
    // envelope row still written
    expect(db.count(envelope)).toBeGreaterThan(0);
  });

  it('test 4.5: language field extracted from payload.language (SWE-rebench task carries language)', async () => {
    const bodyWithLanguage = {
      ...SYNTHETIC_ENVELOPE,
      payload: { language: 'python', repo: 'owner/repo' },
    };
    const stubFetch: FetchLike = async (_url, _opts) => ({
      ok: true,
      status: 200,
      json: async () => bodyWithLanguage,
    });

    await handleMetadataSet({
      event: metadataSetEvent(
        {
          agentId: 9n,
          metadataKey: `envelope:${ENRICH_ENVELOPE_CID}`,
          metadataValue: envelopePayloadV2({ tier: 1, manifestHash: MANIFEST_HASH }),
        },
        { block: 41_200_010n, logIndex: 0 },
      ),
      context,
      solverNetManifest,
      envelope,
      harnessCheckpoint,
      attemptEnvelopeMeta,
      enrichEnvelopes: true,
      ipfsGateway: 'https://stub',
      fetchImpl: stubFetch,
    });

    const metaRow = db.get(attemptEnvelopeMeta, {
      requestId: ENVELOPE_REQUEST_ID,
      publisherAgentId: '9',
      manifestCid: ENRICH_ENVELOPE_CID,
      chainId: CHAIN_ID,
    });
    expect(metaRow).toBeDefined();
    expect(metaRow?.language).toBe('python');
  });

  it('test 4: envelope body missing task.requestId — no attemptEnvelopeMeta row, no throw', async () => {
    const bodyWithoutTask = { ...SYNTHETIC_ENVELOPE, task: undefined };
    const stubFetch: FetchLike = async (_url, _opts) => ({
      ok: true,
      status: 200,
      json: async () => bodyWithoutTask,
    });

    await expect(
      handleMetadataSet({
        event: metadataSetEvent(
          {
            agentId: 9n,
            metadataKey: `envelope:${ENRICH_ENVELOPE_CID}`,
            metadataValue: envelopePayloadV2({ tier: 1, manifestHash: MANIFEST_HASH }),
          },
          { block: 41_200_003n, logIndex: 0 },
        ),
        context,
        solverNetManifest,
        envelope,
        harnessCheckpoint,
        attemptEnvelopeMeta,
        enrichEnvelopes: true,
        ipfsGateway: 'https://stub',
        fetchImpl: stubFetch,
      }),
    ).resolves.toBeUndefined();

    expect(db.count(attemptEnvelopeMeta)).toBe(0);
    expect(db.count(envelope)).toBeGreaterThan(0);
  });

  it('retains a later untrusted publisher/CID candidate without replacing the legitimate attempt anchor', async () => {
    const attackerCid = 'bafyattackerattempt';
    const stubFetch: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => SYNTHETIC_ENVELOPE,
    });

    for (const candidate of [
      {
        agentId: 9n,
        cid: ENRICH_ENVELOPE_CID,
        hash: MANIFEST_HASH,
        block: 41_200_020n,
      },
      {
        agentId: 666n,
        cid: attackerCid,
        hash: MANIFEST_HASH_2,
        block: 41_200_021n,
      },
    ]) {
      await handleMetadataSet({
        event: metadataSetEvent(
          {
            agentId: candidate.agentId,
            metadataKey: `envelope:${candidate.cid}`,
            metadataValue: envelopePayloadV2({ tier: 1, manifestHash: candidate.hash }),
          },
          { block: candidate.block, logIndex: 0 },
        ),
        context,
        solverNetManifest,
        envelope,
        harnessCheckpoint,
        attemptEnvelopeMeta,
        enrichEnvelopes: true,
        ipfsGateway: 'https://stub',
        fetchImpl: stubFetch,
      });
    }

    expect(db.count(attemptEnvelopeMeta)).toBe(2);
    expect(db.get(attemptEnvelopeMeta, {
      requestId: ENVELOPE_REQUEST_ID,
      publisherAgentId: '9',
      manifestCid: ENRICH_ENVELOPE_CID,
      chainId: CHAIN_ID,
    })).toMatchObject({
      publisherAgentId: '9',
      manifestCid: ENRICH_ENVELOPE_CID,
      manifestHash: MANIFEST_HASH,
    });
    expect(db.get(attemptEnvelopeMeta, {
      requestId: ENVELOPE_REQUEST_ID,
      publisherAgentId: '666',
      manifestCid: attackerCid,
      chainId: CHAIN_ID,
    })).toMatchObject({
      publisherAgentId: '666',
      manifestCid: attackerCid,
      manifestHash: MANIFEST_HASH_2,
    });
  });
});

// ── parseCheckpointManifestLite unit tests ────────────────────────────────────

describe('parseCheckpointManifestLite', () => {
  const SYNTHETIC_CHECKPOINT_MANIFEST = {
    schemaVersion: 'harness.checkpoint.v1',
    name: 'claude-code-learner',
    version: '1.0.0',
    parentCheckpointCid: null,
    harnessPackage: {
      implName: 'claude-code-learner',
      implVersion: '1.0.0',
      clientGitSha: 'abc123',
      sourceBundleCid: 'bafyreidummysourcebundle',
    },
    implStateDirCid: 'bafyreidummyimplstatedir',
    codeDigest: `sha256:${'ab'.repeat(32)}`,
    publisher: {
      agentId: '42',
      signingKey: `ed25519:${'cd'.repeat(32)}`,
      safeAddress: '0x' + 'ee'.repeat(20),
    },
    publishedAt: '2026-05-13T00:00:00Z',
    registry: {
      anchor: 'IdentityRegistry.setMetadata',
      metadataKey: 'harness.checkpoint:bafyckptcid',
      txHash: '0x' + 'ff'.repeat(32),
      blockNumber: 41_300_000,
    },
    signature: 'sig',
  };

  it('parses a valid checkpoint manifest', () => {
    const result = parseCheckpointManifestLite(SYNTHETIC_CHECKPOINT_MANIFEST);
    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      name: 'claude-code-learner',
      version: '1.0.0',
      codeDigest: `sha256:${'ab'.repeat(32)}`,
      parentCheckpointCid: null,
      implStateDirCid: 'bafyreidummyimplstatedir',
      implName: 'claude-code-learner',
      implVersion: '1.0.0',
      sourceBundleCid: 'bafyreidummysourcebundle',
    });
  });

  it('returns null for a non-object body', () => {
    expect(parseCheckpointManifestLite('string')).toBeNull();
    expect(parseCheckpointManifestLite(null)).toBeNull();
    expect(parseCheckpointManifestLite(42)).toBeNull();
  });

  it('returns null when codeDigest is missing', () => {
    const body = { ...SYNTHETIC_CHECKPOINT_MANIFEST, codeDigest: undefined };
    expect(parseCheckpointManifestLite(body)).toBeNull();
  });

  it('returns null when implStateDirCid is missing', () => {
    const body = { ...SYNTHETIC_CHECKPOINT_MANIFEST, implStateDirCid: undefined };
    expect(parseCheckpointManifestLite(body)).toBeNull();
  });

  it('handles parentCheckpointCid: non-null string', () => {
    const body = { ...SYNTHETIC_CHECKPOINT_MANIFEST, parentCheckpointCid: 'bafyparent' };
    const result = parseCheckpointManifestLite(body);
    expect(result?.parentCheckpointCid).toBe('bafyparent');
  });

  it('handles missing harnessPackage gracefully (implName/implVersion/sourceBundleCid → empty)', () => {
    const { harnessPackage: _unused, ...body } = SYNTHETIC_CHECKPOINT_MANIFEST;
    const result = parseCheckpointManifestLite(body);
    // codeDigest and implStateDirCid are still present — should still parse
    expect(result).not.toBeNull();
    expect(result?.implName).toBe('');
    expect(result?.implVersion).toBe('');
    expect(result?.sourceBundleCid).toBe('');
  });
});

// ── MetadataSet harness.checkpoint: enrichment ────────────────────────────────

const SYNTHETIC_CHECKPOINT_MANIFEST_BODY = {
  schemaVersion: 'harness.checkpoint.v1',
  name: 'claude-code-learner',
  version: '1.0.0',
  parentCheckpointCid: null,
  harnessPackage: {
    implName: 'claude-code-learner',
    implVersion: '1.0.0',
    clientGitSha: 'abc123',
    sourceBundleCid: 'bafyreidummysourcebundle',
  },
  implStateDirCid: 'bafyreidummyimplstatedir',
  codeDigest: `sha256:${'ab'.repeat(32)}`,
};

describe('MetadataSet harness.checkpoint: enrichment → harnessCheckpoint', () => {
  const CKPT_CID = 'bafycheckpointenrich';

  it('ckpt-enrich-1: successful fetch → harnessCheckpoint row has enrichmentStatus=ok + manifest fields', async () => {
    const stubFetch: FetchLike = async (_url, _opts) => ({
      ok: true,
      status: 200,
      json: async () => SYNTHETIC_CHECKPOINT_MANIFEST_BODY,
    });

    await handleMetadataSet({
      event: metadataSetEvent(
        {
          agentId: 99n,
          metadataKey: `harness.checkpoint:${CKPT_CID}`,
          metadataValue: '0x',
        },
        { block: 41_400_000n, logIndex: 0 },
      ),
      context,
      solverNetManifest,
      envelope,
      harnessCheckpoint,
      attemptEnvelopeMeta,
      enrichEnvelopes: true,
      ipfsGateway: 'https://stub',
      fetchImpl: stubFetch,
    });

    const row = db.get(harnessCheckpoint, { agentId: '99', cid: CKPT_CID, chainId: CHAIN_ID });
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      cid: CKPT_CID,
      agentId: '99',
      publishedAtBlock: 41_400_000n,
      chainId: CHAIN_ID,
      enrichmentStatus: 'ok',
      name: 'claude-code-learner',
      version: '1.0.0',
      codeDigest: `sha256:${'ab'.repeat(32)}`,
      parentCheckpointCid: null,
      implStateDirCid: 'bafyreidummyimplstatedir',
      implName: 'claude-code-learner',
      implVersion: '1.0.0',
      sourceBundleCid: 'bafyreidummysourcebundle',
    });
  });

  it('ckpt-enrich-2: fetch throws → enrichmentStatus=failed, no throw from handler', async () => {
    const stubFetch: FetchLike = async (_url, _opts) => {
      throw new Error('IPFS timeout');
    };

    await expect(
      handleMetadataSet({
        event: metadataSetEvent(
          {
            agentId: 99n,
            metadataKey: `harness.checkpoint:${CKPT_CID}`,
            metadataValue: '0x',
          },
          { block: 41_400_001n, logIndex: 0 },
        ),
        context,
        solverNetManifest,
        envelope,
        harnessCheckpoint,
        attemptEnvelopeMeta,
        enrichEnvelopes: true,
        ipfsGateway: 'https://stub',
        fetchImpl: stubFetch,
      }),
    ).resolves.toBeUndefined();

    const row = db.get(harnessCheckpoint, { agentId: '99', cid: CKPT_CID, chainId: CHAIN_ID });
    expect(row).toBeDefined();
    expect(row?.enrichmentStatus).toBe('failed');
  });

  it('ckpt-enrich-3: fetch succeeds but body is not a valid manifest → enrichmentStatus=failed', async () => {
    const stubFetch: FetchLike = async (_url, _opts) => ({
      ok: true,
      status: 200,
      json: async () => ({ schemaVersion: 'unknown', notACheckpoint: true }),
    });

    await handleMetadataSet({
      event: metadataSetEvent(
        {
          agentId: 99n,
          metadataKey: `harness.checkpoint:${CKPT_CID}`,
          metadataValue: '0x',
        },
        { block: 41_400_002n, logIndex: 0 },
      ),
      context,
      solverNetManifest,
      envelope,
      harnessCheckpoint,
      attemptEnvelopeMeta,
      enrichEnvelopes: true,
      ipfsGateway: 'https://stub',
      fetchImpl: stubFetch,
    });

    const row = db.get(harnessCheckpoint, { agentId: '99', cid: CKPT_CID, chainId: CHAIN_ID });
    expect(row).toBeDefined();
    expect(row?.enrichmentStatus).toBe('failed');
  });

  it('ckpt-enrich-4: enrichEnvelopes=false → no fetch, row has enrichmentStatus=pending', async () => {
    let fetchCalled = false;
    const stubFetch: FetchLike = async (_url, _opts) => {
      fetchCalled = true;
      return { ok: true, status: 200, json: async () => SYNTHETIC_CHECKPOINT_MANIFEST_BODY };
    };

    await handleMetadataSet({
      event: metadataSetEvent(
        {
          agentId: 99n,
          metadataKey: `harness.checkpoint:${CKPT_CID}`,
          metadataValue: '0x',
        },
        { block: 41_400_003n, logIndex: 0 },
      ),
      context,
      solverNetManifest,
      envelope,
      harnessCheckpoint,
      attemptEnvelopeMeta,
      enrichEnvelopes: false,
      ipfsGateway: 'https://stub',
      fetchImpl: stubFetch,
    });

    expect(fetchCalled).toBe(false);
    const row = db.get(harnessCheckpoint, { agentId: '99', cid: CKPT_CID, chainId: CHAIN_ID });
    expect(row).toBeDefined();
    expect(row?.enrichmentStatus).toBe('pending');
  });
});

// ─── parseSolverNetManifestLite (pure) ────────────────────────────────────────

describe('parseSolverNetManifestLite (issue #985 — full summary fields)', () => {
  const SYNTHETIC_SOLVERNET_MANIFEST = {
    schemaVersion: 'solvernet.manifest.v1',
    solverNetId: 'launcher/swe-rebench-v2',
    network: 'base-sepolia',
    name: 'SWE-rebench v2',
    description: 'A coding benchmark SolverNet.',
    launcher: {
      safeAddress: '0x' + 'ab'.repeat(20),
      agentEoa: '0x' + 'cd'.repeat(20),
      agentId: '5474',
    },
    contract: {
      id: 'swe-rebench-v2',
      version: 'v1',
    },
    solutionPriceWei: '1000000000000000',
    verdictPriceWei: '500000000000000',
    openRoles: ['solver', 'evaluator'],
  };

  it('parses all summary fields from a valid manifest body', () => {
    const result = parseSolverNetManifestLite(SYNTHETIC_SOLVERNET_MANIFEST);
    expect(result).not.toBeNull();
    expect(result).toEqual({
      name: 'SWE-rebench v2',
      description: 'A coding benchmark SolverNet.',
      solverNetId: 'launcher/swe-rebench-v2',
      network: 'base-sepolia',
      solutionPriceWei: '1000000000000000',
      verdictPriceWei: '500000000000000',
      openRoles: ['solver', 'evaluator'],
      launcherSafeAddress: '0x' + 'ab'.repeat(20),
      contractId: 'swe-rebench-v2',
      contractVersion: 'v1',
    });
  });

  it('returns null for a non-object body', () => {
    expect(parseSolverNetManifestLite('string')).toBeNull();
    expect(parseSolverNetManifestLite(null)).toBeNull();
    expect(parseSolverNetManifestLite(42)).toBeNull();
  });

  it('returns null when the required name field is missing', () => {
    const { name: _omit, ...body } = SYNTHETIC_SOLVERNET_MANIFEST;
    expect(parseSolverNetManifestLite(body)).toBeNull();
  });

  it('degrades missing nested launcher/contract to empty strings (still parses)', () => {
    const { launcher: _l, contract: _c, ...body } = SYNTHETIC_SOLVERNET_MANIFEST;
    const result = parseSolverNetManifestLite(body);
    expect(result).not.toBeNull();
    expect(result?.launcherSafeAddress).toBe('');
    expect(result?.contractId).toBe('');
    expect(result?.contractVersion).toBe('');
  });

  it('degrades non-array openRoles to an empty array', () => {
    const body = { ...SYNTHETIC_SOLVERNET_MANIFEST, openRoles: 'solver' };
    const result = parseSolverNetManifestLite(body);
    expect(result?.openRoles).toEqual([]);
  });
});

// ─── MetadataSet solvernet-manifest: enrichment → solverNetManifest ───────────
// The pure-parser tests above prove parseSolverNetManifestLite; this exercises
// the end-to-end enrichment write (handlers.ts ~968-982) with enrichEnvelopes:
// true and a mocked IPFS body, asserting the enriched columns + 'ok' status land.

describe('MetadataSet solvernet-manifest: enrichment → solverNetManifest', () => {
  const ENRICH_MANIFEST_CID = 'bafymanifestenrich';
  const SOLVERNET_MANIFEST_BODY = {
    schemaVersion: 'solvernet.manifest.v1',
    solverNetId: 'launcher/swe-rebench-v2',
    network: 'base-sepolia',
    name: 'SWE-rebench v2',
    description: 'A coding benchmark SolverNet.',
    launcher: { safeAddress: '0x' + 'ab'.repeat(20), agentEoa: '0x' + 'cd'.repeat(20), agentId: '5474' },
    contract: { id: 'swe-rebench-v2', version: 'v1' },
    solutionPriceWei: '1000000000000000',
    verdictPriceWei: '500000000000000',
    openRoles: ['solver', 'evaluator'],
  };

  it('successful fetch → row has the enriched summary fields + manifestEnrichmentStatus=ok', async () => {
    const stubFetch: FetchLike = async (_url, _opts) => ({
      ok: true,
      status: 200,
      json: async () => SOLVERNET_MANIFEST_BODY,
    });

    await handleMetadataSet({
      event: metadataSetEvent(
        {
          agentId: 5n,
          metadataKey: `solvernet-manifest:${ENRICH_MANIFEST_CID}`,
          metadataValue: lifecyclePayload({ status: 'launched', at: '2026-05-11T00:00:00Z', hash: MANIFEST_HASH }),
        },
        { block: 41_600_000n, logIndex: 0 },
      ),
      context,
      solverNetManifest,
      envelope,
      pluginPublication,
      harnessCheckpoint,
      attemptEnvelopeMeta,
      enrichEnvelopes: true,
      ipfsGateway: 'https://stub',
      fetchImpl: stubFetch,
    });

    const row = db.get(solverNetManifest, { id: ENRICH_MANIFEST_CID });
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      id: ENRICH_MANIFEST_CID,
      // The 7 enriched summary fields surfaced on the list path...
      name: 'SWE-rebench v2',
      network: 'base-sepolia',
      solutionPriceWei: '1000000000000000',
      verdictPriceWei: '500000000000000',
      openRoles: ['solver', 'evaluator'],
      launcherSafeAddress: '0x' + 'ab'.repeat(20),
      contractId: 'swe-rebench-v2',
      contractVersion: 'v1',
      // ...plus the remaining enriched columns and the status flip.
      description: 'A coding benchmark SolverNet.',
      solverNetId: 'launcher/swe-rebench-v2',
      manifestEnrichmentStatus: 'ok',
    });
  });
});

// ─── parseVerdictEnvelopeLite (pure) ──────────────────────────────────────────

describe('parseVerdictEnvelopeLite', () => {
  it('parses a SWE-rebench v2 verdict envelope (passed_match=false → FAIL)', () => {
    const body = {
      schemaVersion: 'jinn.execution.v1',
      role: 'verdict',
      solverType: 'swe-rebench-v2.v1',
      task: { requestId: `0x${'aa'.repeat(32)}`, taskId: '7', attemptIndex: 0 },
      verdictIndex: 0,
      participant: { safeAddress: `0x${'bb'.repeat(20)}`, agentEoa: '0x' },
      evidenceTier: 'committed',
      payload: { passed_match: false, score: 0 },
    };
    const m = parseVerdictEnvelopeLite(body);
    expect(m).not.toBeNull();
    expect(m!.requestId).toBe(`0x${'aa'.repeat(32)}`);
    expect(m!.solverType).toBe('swe-rebench-v2.v1');
    expect(m!.actualPassed).toBe(false);
    expect(m!.actualScore).toBe('0');
    expect(m!.evaluatorVerdict).toBe('FAIL');
    expect(m!.evidenceTier).toBe('committed');
    expect(m!.taskId).toBe('7');
    expect(m!.attemptIndex).toBe(0);
    expect(m!.verdictIndex).toBe(0);
  });

  it('parses SWE-rebench v2 passed_match=true → PASS', () => {
    const body = {
      task: { requestId: `0x${'cc'.repeat(32)}` },
      solverType: 'swe-rebench-v2.v1',
      payload: { passed_match: true, score: 1.0 },
    };
    const m = parseVerdictEnvelopeLite(body);
    expect(m!.actualPassed).toBe(true);
    expect(m!.actualScore).toBe('1');
    expect(m!.evaluatorVerdict).toBe('PASS');
  });

  it('parses a generic verdict envelope (payload.verdict=PASS)', () => {
    const body = {
      task: { requestId: `0x${'dd'.repeat(32)}` },
      solverType: 'prediction.v1',
      payload: { verdict: 'PASS' },
    };
    const m = parseVerdictEnvelopeLite(body);
    expect(m!.evaluatorVerdict).toBe('PASS');
    expect(m!.actualPassed).toBe(true);
    expect(m!.actualScore).toBe('');
  });

  it('normalizes generic verdict values (REJECTED → FAIL, UNRESOLVED → INDETERMINATE)', () => {
    const a = parseVerdictEnvelopeLite({
      task: { requestId: `0x${'ee'.repeat(32)}` },
      solverType: 'prediction.v1',
      payload: { verdict: 'REJECTED' },
    });
    expect(a!.evaluatorVerdict).toBe('FAIL');
    const b = parseVerdictEnvelopeLite({
      task: { requestId: `0x${'ff'.repeat(32)}` },
      solverType: 'prediction.v1',
      payload: { verdict: 'UNRESOLVED' },
    });
    expect(b!.evaluatorVerdict).toBe('INDETERMINATE');
  });

  it('returns null when body is null/non-object/missing task.requestId', () => {
    expect(parseVerdictEnvelopeLite(null)).toBeNull();
    expect(parseVerdictEnvelopeLite('not an object')).toBeNull();
    expect(parseVerdictEnvelopeLite([1, 2, 3])).toBeNull();
    expect(parseVerdictEnvelopeLite({})).toBeNull();
    expect(parseVerdictEnvelopeLite({ task: {} })).toBeNull();
    expect(parseVerdictEnvelopeLite({ task: { requestId: '' } })).toBeNull();
  });

  it('falls back to UNKNOWN for unrecognized payloads', () => {
    const m = parseVerdictEnvelopeLite({
      task: { requestId: `0x${'11'.repeat(32)}` },
      solverType: 'mystery.v1',
      payload: {},
    });
    expect(m!.evaluatorVerdict).toBe('UNKNOWN');
    expect(m!.actualPassed).toBe(false);
  });

  it('parses graded counts from a swe-rebench-v2 verdict.v2 envelope', () => {
    const body = {
      solverType: 'swe-rebench-v2.v1',
      task: { requestId: '0xabc', attemptIndex: 0, taskId: '1', cid: '' },
      participant: { safeAddress: '0xeval' },
      payload: { schemaVersion: 'swe-rebench-v2-verdict.v2', score: 0, passed_match: false, passedCount: 18, totalCount: 20 },
    };
    const meta = parseVerdictEnvelopeLite(body);
    expect(meta?.passedCount).toBe(18);
    expect(meta?.totalCount).toBe(20);
    expect(meta?.actualPassed).toBe(false); // binary unchanged
  });

  it('defaults graded counts to 0 for a v1 verdict envelope', () => {
    const body = {
      solverType: 'swe-rebench-v2.v1',
      task: { requestId: '0xdef', attemptIndex: 0, taskId: '1', cid: '' },
      participant: { safeAddress: '0xeval' },
      payload: { schemaVersion: 'swe-rebench-v2-verdict.v1', score: 1, passed_match: true },
    };
    const meta = parseVerdictEnvelopeLite(body);
    expect(meta?.passedCount).toBe(0);
    expect(meta?.totalCount).toBe(0);
  });

  it('falls back to snake_case keys when camelCase keys are absent', () => {
    const body = {
      solverType: 'swe-rebench-v2.v1',
      task: { requestId: '0xfed', attemptIndex: 0, taskId: '1', cid: '' },
      participant: { safeAddress: '0xeval' },
      payload: { schemaVersion: 'swe-rebench-v2-verdict.v2', score: 1, passed_match: true, passed_count: 7, total_count: 10 },
    };
    const meta = parseVerdictEnvelopeLite(body);
    expect(meta?.passedCount).toBe(7);
    expect(meta?.totalCount).toBe(10);
  });
});

// ─── resolveInstanceFields (pure, shared module #779) ─────────────────────────
// The swe-rebench-v2 task-body → instance_id + solverNetManifestCid resolver
// the enrichment worker relies on. Extracted from the inlined handler block so
// the worker and the legacy in-handler path cannot drift.

describe('resolveInstanceFields', () => {
  it('reads spec.instance_id, top-level solverNetManifestCid and restorationRequestId from a task.v1 body', () => {
    const taskBody = {
      schemaVersion: 'task.v1',
      solverNetManifestCid: 'bafyManifestSweA',
      // top-level restorationRequestId — the SOLVE-request id persisted as
      // solutionRequestId so the (task, solution, verdict) tuple joins (#1433).
      restorationRequestId: `0x${'99'.repeat(32)}`,
      spec: { instance_id: 'sympy__sympy-27510' },
    };
    expect(resolveInstanceFields(taskBody)).toEqual({
      instanceId: 'sympy__sympy-27510',
      solverNetManifestCid: 'bafyManifestSweA',
      solutionRequestId: `0x${'99'.repeat(32)}`,
    });
  });

  it('returns empty strings when the body lacks the fields', () => {
    expect(resolveInstanceFields({ spec: {} })).toEqual({
      instanceId: '',
      solverNetManifestCid: '',
      solutionRequestId: '',
    });
  });

  it('returns empty strings for a non-object body', () => {
    expect(resolveInstanceFields(null)).toEqual({ instanceId: '', solverNetManifestCid: '', solutionRequestId: '' });
    expect(resolveInstanceFields('nope')).toEqual({ instanceId: '', solverNetManifestCid: '', solutionRequestId: '' });
    expect(resolveInstanceFields(undefined)).toEqual({ instanceId: '', solverNetManifestCid: '', solutionRequestId: '' });
  });

  it('ignores a non-string / empty instance_id and non-string restorationRequestId', () => {
    expect(resolveInstanceFields({ spec: { instance_id: '' }, solverNetManifestCid: 'cid' })).toEqual({
      instanceId: '',
      solverNetManifestCid: 'cid',
      solutionRequestId: '',
    });
    expect(resolveInstanceFields({ spec: { instance_id: 123 }, restorationRequestId: 42 })).toEqual({
      instanceId: '',
      solverNetManifestCid: '',
      solutionRequestId: '',
    });
  });
});

// ─── MetadataSet evaluation: enrichment → verdictEnvelopeMeta ─────────────────

describe('MetadataSet evaluation: enrichment → verdictEnvelopeMeta', () => {
  const EVAL_CID = 'bafyevaluation';
  const REQUEST_ID = `0x${'aa'.repeat(32)}` as `0x${string}`;
  const EVALUATOR = `0x${'bb'.repeat(20)}` as `0x${string}`;
  const evalKey = `evaluation:${EVAL_CID}`;
  const SWE_REBENCH_FAIL_BODY = {
    schemaVersion: 'jinn.execution.v1',
    role: 'verdict',
    solverType: 'swe-rebench-v2.v1',
    task: { requestId: REQUEST_ID, taskId: '42', attemptIndex: 1 },
    verdictIndex: 0,
    participant: { safeAddress: EVALUATOR, agentEoa: '0x' },
    evidenceTier: 'committed',
    payload: { passed_match: false, score: 0 },
  };

  it('writes a verdictEnvelopeMeta row on successful fetch + parse', async () => {
    const stubFetch: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => SWE_REBENCH_FAIL_BODY,
    });
    await handleMetadataSet({
      event: metadataSetEvent({ agentId: 5n, metadataKey: evalKey, metadataValue: envelopePayloadV2({ manifestHash: MANIFEST_HASH, tier: 1 }) }, { block: 41_500_000n, logIndex: 0 }),
      context,
      solverNetManifest,
      envelope,
      harnessCheckpoint,
      attemptEnvelopeMeta,
      verdictEnvelopeMeta,
      enrichEnvelopes: true,
      enrichVerdicts: true,
      ipfsGateway: 'https://stub',
      fetchImpl: stubFetch,
    });
    const row = db.get(verdictEnvelopeMeta, {
      requestId: REQUEST_ID,
      publisherAgentId: '5',
      manifestCid: EVAL_CID,
      chainId: CHAIN_ID,
    });
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      requestId: REQUEST_ID,
      verdictIndex: 0,
      attemptIndex: 1,
      taskId: '42',
      evaluator: EVALUATOR,
      manifestCid: EVAL_CID,
      publisherAgentId: '5',
      manifestHash: MANIFEST_HASH,
      solverType: 'swe-rebench-v2.v1',
      evidenceTier: 'committed',
      actualPassed: false,
      actualScore: '0',
      passedCount: 0,
      totalCount: 0,
      evaluatorVerdict: 'FAIL',
      enrichmentStatus: 'ok',
      chainId: CHAIN_ID,
    });
    // The Envelope row is also still written (the existing path).
    const env = db.rows(envelope).find((e) => e.metadataKey === evalKey);
    expect(env).toBeDefined();
    expect(env?.kind).toBe('evaluation');
  });

  it('does NOT write a row when the fetch throws (resilient — no row, no throw)', async () => {
    const stubFetch: FetchLike = async () => { throw new Error('IPFS offline'); };
    await expect(
      handleMetadataSet({
        event: metadataSetEvent({ agentId: 5n, metadataKey: evalKey, metadataValue: envelopePayloadV2({ manifestHash: MANIFEST_HASH, tier: 1 }) }, { block: 41_500_000n, logIndex: 0 }),
        context,
        solverNetManifest,
        envelope,
        harnessCheckpoint,
        attemptEnvelopeMeta,
        verdictEnvelopeMeta,
        enrichEnvelopes: true,
        enrichVerdicts: true,
        ipfsGateway: 'https://stub',
        fetchImpl: stubFetch,
      })
    ).resolves.toBeUndefined();
    expect(db.count(verdictEnvelopeMeta)).toBe(0);
    // The Envelope row IS still written (the on-chain upsert is unaffected).
    expect(db.rows(envelope).some((e) => e.metadataKey === evalKey)).toBe(true);
  });

  it('does NOT fetch or write when enrichEnvelopes:false', async () => {
    let called = false;
    const stubFetch: FetchLike = async () => { called = true; return { ok: true, status: 200, json: async () => SWE_REBENCH_FAIL_BODY }; };
    await handleMetadataSet({
      event: metadataSetEvent({ agentId: 5n, metadataKey: evalKey, metadataValue: envelopePayloadV2({ manifestHash: MANIFEST_HASH, tier: 1 }) }, { block: 41_500_000n, logIndex: 0 }),
      context,
      solverNetManifest,
      envelope,
      harnessCheckpoint,
      attemptEnvelopeMeta,
      verdictEnvelopeMeta,
      enrichEnvelopes: false,
      ipfsGateway: 'https://stub',
      fetchImpl: stubFetch,
    });
    expect(called).toBe(false);
    expect(db.count(verdictEnvelopeMeta)).toBe(0);
  });

  // ── AC1 (#779): anchor-only path does no IPFS I/O, writes the CID-keyed
  // evaluation `envelope` skeleton, and returns fast. The `envelope` anchor IS
  // the discovery skeleton the worker's left-anti-join keys on — an `evaluation`
  // envelope with no `ok` verdict_envelope_meta row presents as un-enriched.
  it('AC1: anchor-only path writes the evaluation envelope skeleton, does no IPFS I/O, and is fast', async () => {
    let called = false;
    const stubFetch: FetchLike = async () => {
      called = true;
      return { ok: true, status: 200, json: async () => SWE_REBENCH_FAIL_BODY };
    };
    const start = performance.now();
    await handleMetadataSet({
      event: metadataSetEvent({ agentId: 5n, metadataKey: evalKey, metadataValue: envelopePayloadV2({ manifestHash: MANIFEST_HASH, tier: 1 }) }, { block: 41_500_000n, logIndex: 0 }),
      context,
      solverNetManifest,
      envelope,
      harnessCheckpoint,
      attemptEnvelopeMeta,
      verdictEnvelopeMeta,
      enrichEnvelopes: false,
      ipfsGateway: 'https://stub',
      fetchImpl: stubFetch,
    });
    const elapsedMs = performance.now() - start;

    // No IPFS fetch on the anchor-only path.
    expect(called).toBe(false);

    // The CID-keyed evaluation envelope anchor (the worker's discovery skeleton)
    // IS written, even with enrichment off.
    const anchor = db.rows(envelope).find((e) => e.metadataKey === evalKey);
    expect(anchor).toBeDefined();
    expect(anchor?.kind).toBe('evaluation');
    expect(anchor?.manifestCid).toBe(EVAL_CID);

    // It presents as un-enriched to the worker's left-anti-join: no
    // verdict_envelope_meta row exists for it yet.
    expect(db.count(verdictEnvelopeMeta)).toBe(0);

    // Sub-10ms guard: the anchor-only path is a single in-memory upsert + early
    // return. Loose enough not to flake, tight enough to catch a re-introduced
    // synchronous IPFS fetch.
    expect(elapsedMs).toBeLessThan(10);
  });

  it('does NOT write a row when the body has no task.requestId', async () => {
    const stubFetch: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ schemaVersion: 'jinn.execution.v1', role: 'verdict', payload: { passed_match: true } }),
    });
    await handleMetadataSet({
      event: metadataSetEvent({ agentId: 5n, metadataKey: evalKey, metadataValue: envelopePayloadV2({ manifestHash: MANIFEST_HASH, tier: 1 }) }, { block: 41_500_000n, logIndex: 0 }),
      context,
      solverNetManifest,
      envelope,
      harnessCheckpoint,
      attemptEnvelopeMeta,
      verdictEnvelopeMeta,
      enrichEnvelopes: true,
      enrichVerdicts: true,
      ipfsGateway: 'https://stub',
      fetchImpl: stubFetch,
    });
    expect(db.count(verdictEnvelopeMeta)).toBe(0);
  });

  it('does NOT enrich envelope:<cid> (execution) — only evaluation:<cid> triggers verdictEnvelopeMeta', async () => {
    const stubFetch: FetchLike = async () => ({ ok: true, status: 200, json: async () => SWE_REBENCH_FAIL_BODY });
    await handleMetadataSet({
      event: metadataSetEvent({ agentId: 5n, metadataKey: `envelope:${EVAL_CID}`, metadataValue: envelopePayloadV2({ manifestHash: MANIFEST_HASH, tier: 1 }) }, { block: 41_500_000n, logIndex: 0 }),
      context,
      solverNetManifest,
      envelope,
      harnessCheckpoint,
      attemptEnvelopeMeta,
      verdictEnvelopeMeta,
      enrichEnvelopes: true,
      enrichVerdicts: true,
      ipfsGateway: 'https://stub',
      fetchImpl: stubFetch,
    });
    // No verdictEnvelopeMeta row from an execution envelope — that path goes to attemptEnvelopeMeta.
    expect(db.count(verdictEnvelopeMeta)).toBe(0);
  });

  it('keys verdictEnvelopeMeta by requestId so missing verdictIndex does not orphan later joins', async () => {
    let body: unknown = {
      ...SWE_REBENCH_FAIL_BODY,
      verdictIndex: undefined,
    };
    const stubFetch: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => body,
    });

    await handleMetadataSet({
      event: metadataSetEvent({ agentId: 5n, metadataKey: evalKey, metadataValue: envelopePayloadV2({ manifestHash: MANIFEST_HASH, tier: 1 }) }, { block: 41_500_000n, logIndex: 0 }),
      context,
      solverNetManifest,
      envelope,
      harnessCheckpoint,
      attemptEnvelopeMeta,
      verdictEnvelopeMeta,
      enrichEnvelopes: true,
      enrichVerdicts: true,
      ipfsGateway: 'https://stub',
      fetchImpl: stubFetch,
    });

    body = {
      ...SWE_REBENCH_FAIL_BODY,
      verdictIndex: 2,
      payload: { passed_match: true, score: 1 },
    };

    await handleMetadataSet({
      event: metadataSetEvent({ agentId: 5n, metadataKey: evalKey, metadataValue: envelopePayloadV2({ manifestHash: MANIFEST_HASH, tier: 1 }) }, { block: 41_500_001n, logIndex: 0 }),
      context,
      solverNetManifest,
      envelope,
      harnessCheckpoint,
      attemptEnvelopeMeta,
      verdictEnvelopeMeta,
      enrichEnvelopes: true,
      enrichVerdicts: true,
      ipfsGateway: 'https://stub',
      fetchImpl: stubFetch,
    });

    expect(db.count(verdictEnvelopeMeta)).toBe(1);
    expect(db.get(verdictEnvelopeMeta, {
      requestId: REQUEST_ID,
      publisherAgentId: '5',
      manifestCid: EVAL_CID,
      chainId: CHAIN_ID,
    })).toMatchObject({
      requestId: REQUEST_ID,
      verdictIndex: 2,
      actualPassed: true,
      actualScore: '1',
    });
  });

  it('populates instanceId and solverNetManifestCid from the task IPFS body for swe-rebench-v2 verdicts', async () => {
    const TASK_CID = 'bafytaskbody-sympy';
    const SOLVER_NET_MANIFEST_CID = 'bafyManifestSweA';
    const verdictBody = {
      ...SWE_REBENCH_FAIL_BODY,
      task: { requestId: REQUEST_ID, taskId: '42', attemptIndex: 1, cid: TASK_CID },
      payload: { passed_match: true, score: 1 },
    };
    const taskBody = {
      schemaVersion: 'task.v1',
      id: 'task-uuid',
      solverType: 'swe-rebench-v2.v1',
      // task.v1's top-level solverNetManifestCid — the join key the launcher's
      // getInstanceSuccessCounts uses to scope per-SolverNet (#669 Finding 2).
      solverNetManifestCid: SOLVER_NET_MANIFEST_CID,
      spec: { instance_id: 'sympy__sympy-27510' },
    };
    const stubFetch: FetchLike = async (url) => {
      const u = String(url);
      // Routed via the task body's CID for the task fetch; anything else is
      // treated as the verdict body fetch.
      if (u.includes(TASK_CID)) {
        return { ok: true, status: 200, json: async () => taskBody };
      }
      return { ok: true, status: 200, json: async () => verdictBody };
    };
    await handleMetadataSet({
      event: metadataSetEvent({
        agentId: 5n,
        metadataKey: evalKey,
        metadataValue: envelopePayloadV2({ manifestHash: MANIFEST_HASH, tier: 1 }),
      }, { block: 41_500_001n, logIndex: 0 }),
      context,
      solverNetManifest,
      envelope,
      harnessCheckpoint,
      attemptEnvelopeMeta,
      verdictEnvelopeMeta,
      enrichEnvelopes: true,
      enrichVerdicts: true,
      ipfsGateway: 'https://stub',
      fetchImpl: stubFetch,
    });
    const row = db.get(verdictEnvelopeMeta, {
      requestId: REQUEST_ID,
      publisherAgentId: '5',
      manifestCid: EVAL_CID,
      chainId: CHAIN_ID,
    });
    expect(row).toMatchObject({
      instanceId: 'sympy__sympy-27510',
      solverNetManifestCid: SOLVER_NET_MANIFEST_CID,
      actualPassed: true,
      solverType: 'swe-rebench-v2.v1',
    });
  });

  it('leaves instanceId="" when the task body fetch fails (degraded but resilient)', async () => {
    const TASK_CID = 'bafytaskbody-broken';
    const verdictBody = {
      ...SWE_REBENCH_FAIL_BODY,
      task: { requestId: REQUEST_ID, taskId: '42', attemptIndex: 1, cid: TASK_CID },
    };
    let calls = 0;
    const stubFetch: FetchLike = async (url) => {
      calls += 1;
      if (String(url).includes(TASK_CID)) throw new Error('task body IPFS offline');
      return { ok: true, status: 200, json: async () => verdictBody };
    };
    await handleMetadataSet({
      event: metadataSetEvent({
        agentId: 5n,
        metadataKey: evalKey,
        metadataValue: envelopePayloadV2({ manifestHash: MANIFEST_HASH, tier: 1 }),
      }, { block: 41_500_002n, logIndex: 0 }),
      context,
      solverNetManifest,
      envelope,
      harnessCheckpoint,
      attemptEnvelopeMeta,
      verdictEnvelopeMeta,
      enrichEnvelopes: true,
      enrichVerdicts: true,
      ipfsGateway: 'https://stub',
      fetchImpl: stubFetch,
    });
    const row = db.get(verdictEnvelopeMeta, {
      requestId: REQUEST_ID,
      publisherAgentId: '5',
      manifestCid: EVAL_CID,
      chainId: CHAIN_ID,
    });
    expect(row?.instanceId).toBe('');
    // solverNetManifestCid comes from the same task body fetch as instanceId;
    // an unfetchable task body leaves both empty (#669 Finding 2).
    expect(row?.solverNetManifestCid).toBe('');
    // solutionRequestId shares the same task body fetch — empty when unfetchable (#1433).
    expect(row?.solutionRequestId).toBe('');
    expect(row?.actualPassed).toBe(false);  // verdict row still written
    expect(calls).toBeGreaterThanOrEqual(2); // verdict + task body attempt
  });

  // #1433: the verdict's own requestId is the EVALUATION request and does NOT
  // cross-match attempt.requestId (the SOLVE request). The link is the task
  // body's top-level restorationRequestId, persisted here as solutionRequestId,
  // so `verdictEnvelopeMeta.solutionRequestId = attemptEnvelopeMeta.requestId`
  // resolves the (task, solution, verdict) tuple in a single join.
  it('persists solutionRequestId from the task body so it joins attemptEnvelopeMeta.requestId (#1433)', async () => {
    const TASK_CID = 'bafytaskbody-1433';
    const SOLVE_REQUEST_ID = `0x${'ee'.repeat(32)}` as `0x${string}`;
    // The verdict's own (evaluation) requestId — deliberately DIFFERENT from the
    // solve requestId to prove the two do not cross-match (0-intersection).
    const EVAL_REQUEST_ID = REQUEST_ID;
    expect(SOLVE_REQUEST_ID).not.toBe(EVAL_REQUEST_ID);

    // Seed the solution attempt's envelope-meta row keyed by the SOLVE request.
    await context.db
      .insert(attemptEnvelopeMeta)
      .values({
        requestId: SOLVE_REQUEST_ID,
        manifestCid: 'bafy-solution-envelope',
        publisherAgentId: '',
        manifestHash: '0x',
        solverType: 'swe-rebench-v2.v1',
        implName: 'claude-code-learner',
        implVersion: '1.2.3',
        codeDigest: `sha256:${'bb'.repeat(32)}`,
        mode: 'frozen',
        pluginsJson: '[]',
        model: '',
        language: '',
        evidenceTier: 'committed',
        sourcePublished: false,
        enrichmentStatus: 'ok',
        enrichedAtBlock: 41_400_000n,
        chainId: CHAIN_ID,
      })
      .onConflictDoNothing();

    const verdictBody = {
      ...SWE_REBENCH_FAIL_BODY,
      task: { requestId: EVAL_REQUEST_ID, taskId: '42', attemptIndex: 1, cid: TASK_CID },
      payload: { passed_match: true, score: 1 },
    };
    const taskBody = {
      schemaVersion: 'task.v1',
      id: 'task-uuid',
      solverType: 'swe-rebench-v2.v1',
      // The SOLVE-request id lives on the task body's top-level
      // restorationRequestId (task.v1; operator/src/types/task.ts).
      restorationRequestId: SOLVE_REQUEST_ID,
      solverNetManifestCid: 'bafyManifestSweA',
      spec: { instance_id: 'sympy__sympy-27510' },
    };
    const stubFetch: FetchLike = async (url) => {
      const u = String(url);
      if (u.includes(TASK_CID)) {
        return { ok: true, status: 200, json: async () => taskBody };
      }
      return { ok: true, status: 200, json: async () => verdictBody };
    };
    await handleMetadataSet({
      event: metadataSetEvent({
        agentId: 5n,
        metadataKey: evalKey,
        metadataValue: envelopePayloadV2({ manifestHash: MANIFEST_HASH, tier: 1 }),
      }, { block: 41_500_003n, logIndex: 0 }),
      context,
      solverNetManifest,
      envelope,
      harnessCheckpoint,
      attemptEnvelopeMeta,
      verdictEnvelopeMeta,
      enrichEnvelopes: true,
      enrichVerdicts: true,
      ipfsGateway: 'https://stub',
      fetchImpl: stubFetch,
    });

    const verdictRow = db.get(verdictEnvelopeMeta, {
      requestId: EVAL_REQUEST_ID,
      publisherAgentId: '5',
      manifestCid: EVAL_CID,
      chainId: CHAIN_ID,
    });
    expect(verdictRow?.solutionRequestId).toBe(SOLVE_REQUEST_ID);
    // The join resolves: the verdict's solutionRequestId equals the solution
    // attempt's requestId, and that attemptEnvelopeMeta row is retrievable.
    const attemptRow = db.get(attemptEnvelopeMeta, {
      requestId: verdictRow!.solutionRequestId as `0x${string}`,
      publisherAgentId: '',
      manifestCid: 'bafy-solution-envelope',
      chainId: CHAIN_ID,
    });
    expect(attemptRow).toBeDefined();
    expect(attemptRow?.requestId).toBe(verdictRow?.solutionRequestId);
    expect(attemptRow?.manifestCid).toBe('bafy-solution-envelope');
  });

  it('retains a later untrusted publisher/CID candidate without replacing the legitimate verdict anchor', async () => {
    const attackerCid = 'bafyattackerverdict';
    const stubFetch: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => SWE_REBENCH_FAIL_BODY,
    });

    for (const candidate of [
      { agentId: 5n, cid: EVAL_CID, hash: MANIFEST_HASH, block: 41_500_010n },
      { agentId: 666n, cid: attackerCid, hash: MANIFEST_HASH_2, block: 41_500_011n },
    ]) {
      await handleMetadataSet({
        event: metadataSetEvent(
          {
            agentId: candidate.agentId,
            metadataKey: `evaluation:${candidate.cid}`,
            metadataValue: envelopePayloadV2({ manifestHash: candidate.hash, tier: 1 }),
          },
          { block: candidate.block, logIndex: 0 },
        ),
        context,
        solverNetManifest,
        envelope,
        harnessCheckpoint,
        attemptEnvelopeMeta,
        verdictEnvelopeMeta,
        enrichEnvelopes: true,
        enrichVerdicts: true,
        ipfsGateway: 'https://stub',
        fetchImpl: stubFetch,
      });
    }

    expect(db.count(verdictEnvelopeMeta)).toBe(2);
    expect(db.get(verdictEnvelopeMeta, {
      requestId: REQUEST_ID,
      publisherAgentId: '5',
      manifestCid: EVAL_CID,
      chainId: CHAIN_ID,
    })).toMatchObject({
      publisherAgentId: '5',
      manifestCid: EVAL_CID,
      manifestHash: MANIFEST_HASH,
    });
    expect(db.get(verdictEnvelopeMeta, {
      requestId: REQUEST_ID,
      publisherAgentId: '666',
      manifestCid: attackerCid,
      chainId: CHAIN_ID,
    })).toMatchObject({
      publisherAgentId: '666',
      manifestCid: attackerCid,
      manifestHash: MANIFEST_HASH_2,
    });
  });
});

// ─── AC5 (#779): verdict cutover reversibility via enrichVerdicts ──────────────
// After the cutover, the evaluation (verdict) enrichment branch is gated by a
// NEW enrichVerdicts param (default OFF), wired in index.ts from the SAME
// JINN_INDEXER_ENRICH_ENVELOPES env but defaulting off. enrichEnvelopes still
// governs the execution/manifest/checkpoint paths (out of #779 scope). This
// proves the flag is a clean rollback lever AND that the new default is
// anchor-only for verdicts.

describe('AC5: verdict cutover reversibility (enrichVerdicts)', () => {
  const EVAL_CID = 'bafyevaluation';
  const REQUEST_ID = `0x${'aa'.repeat(32)}` as `0x${string}`;
  const EVALUATOR = `0x${'bb'.repeat(20)}` as `0x${string}`;
  const evalKey = `evaluation:${EVAL_CID}`;
  const SWE_BODY = {
    schemaVersion: 'jinn.execution.v1',
    role: 'verdict',
    solverType: 'swe-rebench-v2.v1',
    task: { requestId: REQUEST_ID, taskId: '42', attemptIndex: 1 },
    verdictIndex: 0,
    participant: { safeAddress: EVALUATOR, agentEoa: '0x' },
    evidenceTier: 'committed',
    payload: { passed_match: false, score: 0 },
  };

  it.each([
    { enrichVerdicts: false as const, label: 'OFF (new default → worker owns enrichment)' },
    { enrichVerdicts: true as const, label: 'ON (rollback → in-handler enrichment)' },
  ])('enrichVerdicts=$enrichVerdicts $label', async ({ enrichVerdicts }) => {
    let called = false;
    const stubFetch: FetchLike = async () => {
      called = true;
      return { ok: true, status: 200, json: async () => SWE_BODY };
    };
    const start = performance.now();
    await handleMetadataSet({
      event: metadataSetEvent({ agentId: 5n, metadataKey: evalKey, metadataValue: envelopePayloadV2({ manifestHash: MANIFEST_HASH, tier: 1 }) }, { block: 41_500_000n, logIndex: 0 }),
      context,
      solverNetManifest,
      envelope,
      harnessCheckpoint,
      attemptEnvelopeMeta,
      verdictEnvelopeMeta,
      // Execution-path flag stays on (proving #779 scopes ONLY the verdict
      // path) — the verdict gate is the separate enrichVerdicts.
      enrichEnvelopes: true,
      enrichVerdicts,
      ipfsGateway: 'https://stub',
      fetchImpl: stubFetch,
    });
    const elapsedMs = performance.now() - start;

    // The evaluation envelope anchor is ALWAYS written (the skeleton).
    const anchor = db.rows(envelope).find((e) => e.metadataKey === evalKey);
    expect(anchor?.kind).toBe('evaluation');

    if (enrichVerdicts) {
      // Rollback path: in-handler enrichment runs, verdict row written.
      expect(called).toBe(true);
      const row = db.get(verdictEnvelopeMeta, {
        requestId: REQUEST_ID,
        publisherAgentId: '5',
        manifestCid: EVAL_CID,
        chainId: CHAIN_ID,
      });
      expect(row).toBeDefined();
      expect(row?.enrichmentStatus).toBe('ok');
      expect(row?.evaluatorVerdict).toBe('FAIL');
    } else {
      // New default: anchor-only, no IPFS fetch, no verdict row, fast.
      expect(called).toBe(false);
      expect(db.count(verdictEnvelopeMeta)).toBe(0);
      expect(elapsedMs).toBeLessThan(10);
    }
  });
});
