import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';
import type { AutopilotAdoptionReceipt } from '@jinn-network/sdk/solvernets/jinn-repo';
import { Store } from '../../../src/store/store.js';
import {
  TaskEngine,
  type TaskEngineOptions,
} from '../../../src/harnesses/engine/engine.js';
import {
  TaskRunPersistence,
  type PersistedTaskRunInput,
} from '../../../src/harnesses/engine/persistence.js';
import { TaskRunState } from '../../../src/harnesses/engine/state.js';
import type {
  AdoptionObservation,
  AdoptionReceiptObserver,
} from '../../../src/types/task-run.js';

vi.mock('../../../src/adapters/mech/ipfs.js', () => ({
  cidToDigestHex: vi.fn().mockReturnValue(`0x${'ab'.repeat(32)}` as Hex),
  uploadToIpfs: vi.fn(),
  fetchFromIpfs: vi.fn(),
  fetchFromDigest: vi.fn(),
  digestHexToGatewayUrl: vi.fn(),
}));

vi.mock('../../../src/adapters/mech/contracts.js', () => ({
  callDeliverToMarketplace: vi.fn().mockResolvedValue(`0x${'cd'.repeat(32)}` as Hex),
  claimDelivery: vi.fn().mockResolvedValue(`0x${'ef'.repeat(32)}` as Hex),
  submitTask: vi.fn(),
  submitEvaluationJob: vi.fn(),
  claimJob: vi.fn(),
  getJobClaim: vi.fn(),
  getMechDeliveryRate: vi.fn(),
  getTimeoutBounds: vi.fn(),
  pollDeliverEvents: vi.fn(),
  decodeMarketplaceRequestLogs: vi.fn(),
  decodeDeliverLogs: vi.fn(),
  scanTasks: vi.fn(),
  scanEvaluationJobs: vi.fn(),
}));

const REQUEST_ID = `0x${'11'.repeat(32)}`;
const TASK_ID = 'task-17';
const ATTEMPT_INDEX = 2;
const PR_NUMBER = 1942;
const MANIFEST_CID = 'bafy-autopilot-result';
const EVIDENCE_HASH = `0x${'22'.repeat(32)}`;
const DELIVERY_DIGEST = `0x${'ab'.repeat(32)}`;
const DELIVERY_TX_HASH = `0x${'cd'.repeat(32)}`;

function autopilotSpec() {
  return {
    schemaVersion: 'jinn-repo.v1',
    source: 'autopilot-session',
    instance_id: 'autopilot:attempt',
    repo: 'Jinn-Network/mono',
    base_commit: '1'.repeat(40),
    language: 'typescript',
    problem_statement: 'Implement the claimed issue.',
    session: {
      schemaVersion: 'jinn-autopilot-session.v1',
      workflow: 'implement',
      repository: 'Jinn-Network/mono',
      issueNumber: 1900,
      prNumber: PR_NUMBER,
      targetBase: 'next',
      branch: 'codex/issue-1900',
      claimOid: '2'.repeat(40),
      expectedHead: '3'.repeat(40),
      v2AttemptId: '123e4567-e89b-42d3-a456-426614174000',
      runnerId: 'runner-1',
      taskSnapshot: {
        title: 'Issue title',
        body: 'Issue body',
        prBody: 'PR body',
        baseSha: '4'.repeat(40),
      },
      workflowContract: {
        skill: 'implement-issue',
        version: 'v2',
        resultSchema: 'jinn-autopilot-mutation-result.v1',
      },
      deadline: '2026-07-24T12:00:00.000Z',
      receiptAuthors: ['trusted-host'],
    },
  };
}

function taskInput(
  spec: Record<string, unknown> = autopilotSpec(),
  solverType = 'jinn-repo.v1',
): PersistedTaskRunInput {
  return {
    requestId: REQUEST_ID,
    taskId: TASK_ID,
    attemptIndex: ATTEMPT_INDEX,
    taskCid: 'bafy-task',
    onchainCreationTx: `0x${'44'.repeat(32)}`,
    onchainCreationBlock: 100,
    solverType,
    taskRole: 'restoration',
    windowStartTs: Date.now() - 1_000,
    windowEndTs: Date.now() + 60_000,
    task: {
      id: TASK_ID,
      description: 'Autopilot implementation session',
      solverType,
      contractId: solverType === 'jinn-repo.v1' ? 'jinn-repo' : 'portfolio',
      contractVersion: 'v1',
      role: 'restoration',
      spec,
    },
  };
}

function acceptedReceipt(): AutopilotAdoptionReceipt {
  return {
    schemaVersion: 'jinn-autopilot-marketplace-adoption.v1',
    disposition: 'accepted',
    role: 'solution',
    operation: 'implementation-complete',
    taskId: TASK_ID,
    attemptIndex: ATTEMPT_INDEX,
    requestId: REQUEST_ID,
    deliveryEnvelopeCid: MANIFEST_CID,
    v2AttemptId: '123e4567-e89b-42d3-a456-426614174000',
    claimOid: '2'.repeat(40),
    prNumber: PR_NUMBER,
    expectedHead: '3'.repeat(40),
    resultingHead: '5'.repeat(40),
    reviewGeneration: '123e4567-e89b-42d3-a456-426614174001',
    reviewRefOid: '6'.repeat(40),
    recordedAt: '2026-07-23T12:00:00.000Z',
  };
}

function rejectedReceipt(): AutopilotAdoptionReceipt {
  return {
    schemaVersion: 'jinn-autopilot-marketplace-adoption.v1',
    disposition: 'rejected',
    role: 'solution',
    reason: 'stale-head',
    detail: 'The PR head moved.',
    taskId: TASK_ID,
    attemptIndex: ATTEMPT_INDEX,
    requestId: REQUEST_ID,
    deliveryEnvelopeCid: MANIFEST_CID,
    v2AttemptId: '123e4567-e89b-42d3-a456-426614174000',
    claimOid: '2'.repeat(40),
    prNumber: PR_NUMBER,
    expectedHead: '3'.repeat(40),
    recordedAt: '2026-07-23T12:00:00.000Z',
  };
}

function seedDelivering(persistence: TaskRunPersistence, input = taskInput()): void {
  persistence.insertDiscovered(input);
  persistence.transition(REQUEST_ID, TaskRunState.CLAIMED);
  persistence.transition(REQUEST_ID, TaskRunState.WAITING);
  persistence.transition(REQUEST_ID, TaskRunState.PRE_SNAPSHOT);
  persistence.transition(REQUEST_ID, TaskRunState.RUNNING);
  persistence.transition(REQUEST_ID, TaskRunState.POST_SNAPSHOT);
  persistence.transition(REQUEST_ID, TaskRunState.PACKAGING);
  persistence.transition(REQUEST_ID, TaskRunState.DELIVERING, {
    manifestCid: MANIFEST_CID,
    evidenceHash: EVIDENCE_HASH,
  });
}

function makeObserver(...observations: AdoptionObservation[]): AdoptionReceiptObserver & {
  observe: ReturnType<typeof vi.fn>;
} {
  return {
    observe: vi.fn().mockImplementation(async () => {
      const observation = observations.shift();
      if (!observation) throw new Error('unexpected observer call');
      return observation;
    }),
  };
}

function makeOptions(
  store: Store,
  adoptionReceiptObserver?: AdoptionReceiptObserver,
): TaskEngineOptions {
  return {
    store,
    paths: { workingDirRoot: '/tmp/work', implStateDirRoot: '/tmp/impl' },
    deliveryDeps: {
      publicClient: {} as TaskEngineOptions['deliveryDeps']['publicClient'],
      walletClient: {} as TaskEngineOptions['deliveryDeps']['walletClient'],
      safeAddress: `0x${'77'.repeat(20)}`,
      mechContractAddress: `0x${'88'.repeat(20)}`,
      routerAddress: `0x${'99'.repeat(20)}`,
      claimDeliveryVariant: 'v3',
    },
    adoptionReceiptObserver,
  };
}

describe('Autopilot adoption-aware delivery', () => {
  let store: Store;
  let persistence: TaskRunPersistence;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new Store(':memory:');
    persistence = new TaskRunPersistence(store.db);
  });

  afterEach(() => {
    store.close();
  });

  it('pauses a parsed Autopilot session after Mech delivery and persists the full wait payload', async () => {
    seedDelivering(persistence);
    const engine = new TaskEngine(makeOptions(store, makeObserver()));
    const { callDeliverToMarketplace, claimDelivery } = await import('../../../src/adapters/mech/contracts.js');

    await engine.process(REQUEST_ID);

    const run = persistence.getOrThrow(REQUEST_ID);
    expect(run).toMatchObject({
      state: TaskRunState.AWAITING_ADOPTION,
      taskId: TASK_ID,
      attemptIndex: ATTEMPT_INDEX,
      taskRole: 'restoration',
      manifestCid: MANIFEST_CID,
      deliveryTxHash: DELIVERY_TX_HASH,
      deliveryDigest: DELIVERY_DIGEST,
      adoptionReceiptLocation: {
        repository: 'Jinn-Network/mono',
        prNumber: PR_NUMBER,
      },
      adoptionReceiptAuthors: ['trusted-host'],
    });
    expect(run.adoptionWaitStartedAt).toBeTypeOf('number');
    expect(run.adoptionLastObservation).toBeNull();
    expect(run.adoptionLastError).toBeNull();
    expect(callDeliverToMarketplace).toHaveBeenCalledOnce();
    expect(claimDelivery).not.toHaveBeenCalled();
  });

  it('keeps a pending receipt in flight without marking FAILED', async () => {
    seedDelivering(persistence);
    const observer = makeObserver({
      state: 'pending',
      observedAt: '2026-07-23T12:01:00.000Z',
      detail: 'Receipt not published yet.',
    });
    const engine = new TaskEngine(makeOptions(store, observer));

    await engine.process(REQUEST_ID);
    await engine.process(REQUEST_ID);

    const run = persistence.getOrThrow(REQUEST_ID);
    expect(run.state).toBe(TaskRunState.AWAITING_ADOPTION);
    expect(run.failureReason).toBeNull();
    expect(run.adoptionLastObservation).toEqual({
      state: 'pending',
      observedAt: '2026-07-23T12:01:00.000Z',
      detail: 'Receipt not published yet.',
    });
  });

  it('moves an accepted receipt to CLAIMING_DELIVERY without claiming in the observation operation', async () => {
    seedDelivering(persistence);
    const observer = makeObserver({ state: 'accepted', receipt: acceptedReceipt() });
    const engine = new TaskEngine(makeOptions(store, observer));
    const { claimDelivery } = await import('../../../src/adapters/mech/contracts.js');

    await engine.process(REQUEST_ID);
    await engine.process(REQUEST_ID);

    const run = persistence.getOrThrow(REQUEST_ID);
    expect(run.state).toBe(TaskRunState.CLAIMING_DELIVERY);
    expect(run.adoptionLastObservation).toEqual({
      state: 'accepted',
      receipt: acceptedReceipt(),
    });
    expect(claimDelivery).not.toHaveBeenCalled();
  });

  it('fails a rejected receipt with the stable adoption reason', async () => {
    seedDelivering(persistence);
    const engine = new TaskEngine(makeOptions(
      store,
      makeObserver({ state: 'rejected', receipt: rejectedReceipt() }),
    ));

    await engine.process(REQUEST_ID);
    await engine.process(REQUEST_ID);

    const run = persistence.getOrThrow(REQUEST_ID);
    expect(run.state).toBe(TaskRunState.FAILED);
    expect(run.failureReason).toBe('adoption-rejected:stale-head');
  });

  it('fails closed on contradictory receipts and never claims', async () => {
    seedDelivering(persistence);
    const engine = new TaskEngine(makeOptions(
      store,
      makeObserver({ state: 'contradictory', detail: 'accepted and rejected markers both exist' }),
    ));
    const { claimDelivery } = await import('../../../src/adapters/mech/contracts.js');

    await engine.process(REQUEST_ID);
    await engine.process(REQUEST_ID);

    const run = persistence.getOrThrow(REQUEST_ID);
    expect(run.state).toBe(TaskRunState.FAILED);
    expect(run.failureReason).toBe(
      'adoption-contradiction:accepted and rejected markers both exist',
    );
    expect(claimDelivery).not.toHaveBeenCalled();
  });

  it('recovers AWAITING_ADOPTION without repeating Mech delivery', async () => {
    seedDelivering(persistence);
    const firstEngine = new TaskEngine(makeOptions(store, makeObserver()));
    await firstEngine.process(REQUEST_ID);
    vi.clearAllMocks();

    const observer = makeObserver({ state: 'accepted', receipt: acceptedReceipt() });
    const restartedEngine = new TaskEngine(makeOptions(store, observer));
    const { callDeliverToMarketplace, claimDelivery } = await import('../../../src/adapters/mech/contracts.js');

    await restartedEngine.recoverInFlight();

    expect(persistence.getOrThrow(REQUEST_ID).state).toBe(TaskRunState.CLAIMING_DELIVERY);
    expect(observer.observe).toHaveBeenCalledOnce();
    expect(callDeliverToMarketplace).not.toHaveBeenCalled();
    expect(claimDelivery).not.toHaveBeenCalled();
  });

  it('recovers CLAIMING_DELIVERY by retrying only the Router claim', async () => {
    seedDelivering(persistence);
    const observer = makeObserver({ state: 'accepted', receipt: acceptedReceipt() });
    const firstEngine = new TaskEngine(makeOptions(store, observer));
    await firstEngine.process(REQUEST_ID);
    await firstEngine.process(REQUEST_ID);
    vi.clearAllMocks();

    const restartedObserver = makeObserver();
    const restartedEngine = new TaskEngine(makeOptions(store, restartedObserver));
    const { callDeliverToMarketplace, claimDelivery } = await import('../../../src/adapters/mech/contracts.js');

    await restartedEngine.recoverInFlight();

    expect(persistence.getOrThrow(REQUEST_ID).state).toBe(TaskRunState.COMPLETE);
    expect(restartedObserver.observe).not.toHaveBeenCalled();
    expect(callDeliverToMarketplace).not.toHaveBeenCalled();
    expect(claimDelivery).toHaveBeenCalledOnce();
  });

  it('keeps live-issue jinn-repo tasks on DELIVERING → COMPLETE compatibility', async () => {
    const liveIssue = {
      schemaVersion: 'jinn-repo.v1',
      source: 'live-issue',
      instance_id: 'live:1900',
      repo: 'Jinn-Network/mono',
      base_commit: '1'.repeat(40),
      language: 'typescript',
      problem_statement: 'Fix the live issue.',
      issue_number: 1900,
    };
    seedDelivering(persistence, taskInput(liveIssue));
    const observer = makeObserver();
    const engine = new TaskEngine(makeOptions(store, observer));

    await engine.process(REQUEST_ID);

    expect(persistence.getOrThrow(REQUEST_ID).state).toBe(TaskRunState.COMPLETE);
    expect(observer.observe).not.toHaveBeenCalled();
  });

  it('keeps malformed Autopilot lookalikes on the compatibility path', async () => {
    seedDelivering(persistence, taskInput({
      ...autopilotSpec(),
      session: { schemaVersion: 'not-valid' },
    }));
    const observer = makeObserver();
    const engine = new TaskEngine(makeOptions(store, observer));

    await engine.process(REQUEST_ID);

    expect(persistence.getOrThrow(REQUEST_ID).state).toBe(TaskRunState.COMPLETE);
    expect(observer.observe).not.toHaveBeenCalled();
  });
});
