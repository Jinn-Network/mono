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
 *      not crashed; existing task gets finalized = true.
 *   5. Task / Attempt folding — TaskCreated → task row; TaskAttemptCreated →
 *      attempt row; shapes match the GraphQL fields client/src/discovery/http.ts
 *      queries.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { keccak256, toBytes } from 'viem';
import { task, attempt, solverNetManifest, envelope, verdict, rewardDistribution, harnessCheckpoint, attemptEnvelopeMeta } from '../ponder.schema.js';
import {
  handleTaskCreated,
  handleTaskAttemptCreated,
  handleSolutionDeliveryClaimed,
  handleMetadataSet,
  handleVerdictDeliveryClaimed,
  handleTaskBudgetRefunded,
  handleClaimed,
  type HandlerContext,
} from '../src/handlers.js';
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
  claimedEvent,
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
  [verdict, ['taskId', 'attemptIndex', 'verdictIndex', 'chainId']],
  [rewardDistribution, ['chainId', 'serviceId', 'claimedAtBlock', 'logIndex']],
  [harnessCheckpoint, ['agentId', 'cid', 'chainId']],
  [attemptEnvelopeMeta, ['requestId', 'chainId']],
]);

let db: InMemoryDb;
let context: HandlerContext;

beforeEach(() => {
  db = createInMemoryDb(PKS);
  context = { db, chain: { id: CHAIN_ID } };
});

// ── Area 5: Task / Attempt folding ───────────────────────────────────────────

describe('TaskCreated → task', () => {
  it('creates a task row with the fields client/discovery/http.ts queries', async () => {
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
    // Fields TASKS_QUERY in client/src/discovery/http.ts selects:
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

// ── Area 4: SolutionDeliveryClaimed missing-row guard ────────────────────────

describe('SolutionDeliveryClaimed', () => {
  it('marks an existing task finalized = true', async () => {
    await handleTaskCreated({ event: taskCreatedEvent({ taskId: 7n }), context, task });
    expect(db.get(task, { id: '7' })?.finalized).toBe(false);
    await handleSolutionDeliveryClaimed({
      event: solutionDeliveryClaimedEvent({ taskId: 7n }),
      context,
      task,
    });
    expect(db.get(task, { id: '7' })?.finalized).toBe(true);
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
    await handleVerdictDeliveryClaimed({ event: ev, context, verdict });
    await handleVerdictDeliveryClaimed({ event: ev, context, verdict });
    expect(db.count(verdict)).toBe(1);
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

// ── Claimed → rewardDistribution ─────────────────────────────────────────────

describe('Claimed → rewardDistribution', () => {
  it('creates a rewardDistribution row with all expected fields', async () => {
    await handleClaimed({
      event: claimedEvent(
        {
          serviceId: 1n,
          multisig: ('0x' + 'cc'.repeat(20)) as `0x${string}`,
          operatorMinted: 1000n,
          daoMinted: 200n,
          totalEntitledOperator: 1000n,
          totalEntitledDao: 200n,
        },
        { block: 8_000_001n, logIndex: 3, txHash: ('0x' + 'dd'.repeat(32)) as `0x${string}` },
      ),
      context,
      rewardDistribution,
    });

    const row = db.get(rewardDistribution, { chainId: CHAIN_ID, serviceId: '1', claimedAtBlock: 8_000_001n, logIndex: 3 });
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      serviceId: '1',
      multisig: ('0x' + 'cc'.repeat(20)) as `0x${string}`,
      operatorMinted: 1000n,
      daoMinted: 200n,
      totalEntitledOperator: 1000n,
      totalEntitledDao: 200n,
      claimedAtBlock: 8_000_001n,
      logIndex: 3,
      claimedAtTx: ('0x' + 'dd'.repeat(32)) as `0x${string}`,
      chainId: CHAIN_ID,
    });
  });

  it('is idempotent — a replayed Claimed event does not create a duplicate row', async () => {
    const ev = claimedEvent(
      {
        serviceId: 1n,
        multisig: ('0x' + 'cc'.repeat(20)) as `0x${string}`,
        operatorMinted: 1000n,
        daoMinted: 200n,
        totalEntitledOperator: 1000n,
        totalEntitledDao: 200n,
      },
      { block: 8_000_001n, logIndex: 3, txHash: ('0x' + 'dd'.repeat(32)) as `0x${string}` },
    );
    await handleClaimed({ event: ev, context, rewardDistribution });
    await handleClaimed({ event: ev, context, rewardDistribution });
    expect(db.count(rewardDistribution)).toBe(1);
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
    const metaRow = db.get(attemptEnvelopeMeta, { requestId: ENVELOPE_REQUEST_ID, chainId: CHAIN_ID });
    expect(metaRow).toBeDefined();
    expect(metaRow).toMatchObject({
      requestId: ENVELOPE_REQUEST_ID,
      manifestCid: ENRICH_ENVELOPE_CID,
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
});
