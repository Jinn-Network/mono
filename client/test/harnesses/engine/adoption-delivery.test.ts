import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';
import type { IdentityPublisher } from '../../../src/erc8004/index.js';
import type { AutopilotAdoptionReceipt } from '@jinn-network/sdk/solvernets/jinn-repo';
import { Store } from '../../../src/store/store.js';
import {
  effectiveHarnessDeadline,
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
import {
  callDeliverToMarketplace,
  claimDelivery,
  isDeliveryAlreadyClaimed,
} from '../../../src/adapters/mech/contracts.js';

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
  isDeliveryAlreadyClaimed: vi.fn().mockResolvedValue(false),
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
const ANCHOR_TX_HASH = `0x${'ad'.repeat(32)}` as Hex;
const SDK_FIXTURE_DIRECTORY = new URL(
  '../../../../packages/sdk/fixtures/autopilot/',
  import.meta.url,
);

function sdkFixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`${name}.json`, SDK_FIXTURE_DIRECTORY), 'utf8'),
  ) as Record<string, unknown>;
}

const SDK_GOLDEN_MUTATION = sdkFixture('mutation-complete');
const SDK_GOLDEN_ACCEPTED_SOLUTION = sdkFixture('receipt-solution-accepted');

function autopilotSpec() {
  return {
    schemaVersion: 'jinn-repo.v1',
    source: 'autopilot-session',
    instance_id: 'autopilot:attempt',
    repo: 'Jinn-Network/mono',
    base_commit: '1'.repeat(40),
    language: 'typescript',
    verificationProfile: 'jinn-mono.v1',
    problem_statement: 'Implement the claimed issue.',
    session: {
      schemaVersion: 'jinn-autopilot-session.v1',
      workflow: 'implement',
      repository: 'Jinn-Network/mono',
      language: 'typescript',
      verificationProfile: 'jinn-mono.v1',
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
        targetBaseOid: '4'.repeat(40),
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
  taskRole: 'restoration' | 'evaluation' = 'restoration',
): PersistedTaskRunInput {
  return {
    requestId: REQUEST_ID,
    taskId: TASK_ID,
    attemptIndex: ATTEMPT_INDEX,
    taskCid: 'bafy-task',
    onchainCreationTx: `0x${'44'.repeat(32)}`,
    onchainCreationBlock: 100,
    solverType,
    taskRole,
    windowStartTs: Date.now() - 1_000,
    windowEndTs: Date.now() + 60_000,
    task: {
      id: TASK_ID,
      description: 'Autopilot implementation session',
      solverType,
      contractId: solverType === 'jinn-repo.v1' ? 'jinn-repo' : 'portfolio',
      contractVersion: 'v1',
      role: taskRole,
      spec,
    },
  };
}

function goldenTaskInput(): PersistedTaskRunInput {
  const correlation = SDK_GOLDEN_MUTATION['correlation'] as Record<string, unknown>;
  const spec = autopilotSpec();
  const session = spec.session;
  const taskId = String(correlation['taskId']);
  const requestId = String(correlation['requestId']);
  return {
    ...taskInput({
      ...spec,
      session: {
        ...session,
        prNumber: correlation['prNumber'],
        claimOid: correlation['claimOid'],
        expectedHead: correlation['expectedHead'],
        v2AttemptId: correlation['v2AttemptId'],
      },
    }),
    requestId,
    taskId,
    attemptIndex: Number(correlation['attemptIndex']),
    task: {
      ...taskInput().task,
      id: taskId,
      spec: {
        ...spec,
        session: {
          ...session,
          prNumber: correlation['prNumber'],
          claimOid: correlation['claimOid'],
          expectedHead: correlation['expectedHead'],
          v2AttemptId: correlation['v2AttemptId'],
        },
      },
    },
  };
}

function goldenSolutionOutput(
  mutation: Record<string, unknown> = SDK_GOLDEN_MUTATION,
): Record<string, unknown> {
  const producerResult = structuredClone(mutation);
  delete (
    producerResult['correlation'] as Record<string, unknown>
  ).deliveryEnvelopeCid;
  return {
    venueRef: { name: 'jinn-repo' },
    gating: {},
    solutionPayload: producerResult,
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

function acceptedVerdictReceipt(
  override: Partial<AutopilotAdoptionReceipt> = {},
): AutopilotAdoptionReceipt {
  return {
    schemaVersion: 'jinn-autopilot-marketplace-adoption.v1',
    disposition: 'accepted',
    role: 'verdict',
    operation: 'review-verdict',
    taskId: TASK_ID,
    attemptIndex: ATTEMPT_INDEX,
    requestId: REQUEST_ID,
    deliveryEnvelopeCid: MANIFEST_CID,
    v2AttemptId: '123e4567-e89b-42d3-a456-426614174000',
    claimOid: '2'.repeat(40),
    prNumber: PR_NUMBER,
    expectedHead: '3'.repeat(40),
    resultingHead: '5'.repeat(40),
    reviewedHead: '5'.repeat(40),
    reviewGeneration: '123e4567-e89b-42d3-a456-426614174001',
    reviewRefOid: '6'.repeat(40),
    recordedAt: '2026-07-23T12:00:00.000Z',
    ...override,
  } as AutopilotAdoptionReceipt;
}

function persistedAutopilotOutput(
  taskRole: 'restoration' | 'evaluation',
): Record<string, unknown> {
  const correlation = {
    taskId: TASK_ID,
    attemptIndex: ATTEMPT_INDEX,
    requestId: REQUEST_ID,
    deliveryEnvelopeCid: MANIFEST_CID,
    v2AttemptId: '123e4567-e89b-42d3-a456-426614174000',
    claimOid: '2'.repeat(40),
    prNumber: PR_NUMBER,
    expectedHead: '3'.repeat(40),
    ...(taskRole === 'restoration'
      ? { resultingHead: '5'.repeat(40) }
      : {
          resultingHead: '5'.repeat(40),
          reviewedHead: '5'.repeat(40),
        }),
    reviewGeneration: '123e4567-e89b-42d3-a456-426614174001',
    reviewRefOid: '6'.repeat(40),
  };

  if (taskRole === 'evaluation') {
    return {
      venueRef: { name: 'jinn-repo' },
      gating: {},
      verdictPayload: {
        schemaVersion: 'jinn-autopilot-review-result.v1',
        outcome: 'approve',
        correlation,
        body: 'Approved.',
      },
    };
  }
  const producerCorrelation = structuredClone(correlation);
  delete (
    producerCorrelation as Record<string, unknown>
  ).deliveryEnvelopeCid;
  return {
    venueRef: { name: 'jinn-repo' },
    gating: {},
    solutionPayload: {
      schemaVersion: 'jinn-autopilot-mutation-result.v1',
      outcome: 'mutation-complete',
      correlation: producerCorrelation,
      patch: 'diff --git a/a b/a',
      summary: 'Implemented.',
      evidence: {
        commands: ['corepack yarn test'],
        tests: ['pass'],
      },
    },
  };
}

function seedDelivering(
  persistence: TaskRunPersistence,
  input = taskInput(),
  solutionOutput = persistedAutopilotOutput(input.taskRole ?? 'restoration'),
  manifestCid = MANIFEST_CID,
): void {
  const requestId = input.requestId;
  persistence.insertDiscovered(input);
  persistence.transition(requestId, TaskRunState.CLAIMED);
  persistence.transition(requestId, TaskRunState.WAITING);
  persistence.transition(requestId, TaskRunState.PRE_SNAPSHOT);
  persistence.transition(requestId, TaskRunState.RUNNING);
  persistence.transition(requestId, TaskRunState.POST_SNAPSHOT);
  persistence.transition(requestId, TaskRunState.PACKAGING);
  persistence.transition(requestId, TaskRunState.DELIVERING, {
    manifestCid,
    evidenceHash: EVIDENCE_HASH,
    solutionOutputsJson: JSON.stringify(solutionOutput),
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
  identityPublisher: IdentityPublisher = makeIdentityPublisher(),
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
    marketplaceDeliveryRecovery: {
      resolveExistingDelivery: vi.fn().mockResolvedValue({ state: 'absent' }),
    },
    adoptionReceiptObserver,
    identityPublisher,
  };
}

function makeIdentityPublisher(overrides: Partial<IdentityPublisher> = {}): IdentityPublisher {
  return {
    agent: 7n,
    registry: `0x${'66'.repeat(20)}`,
    chainId: 84532,
    publishContent: vi.fn().mockResolvedValue({
      txHash: ANCHOR_TX_HASH,
      blockNumber: 120,
      gasUsed: 1n,
      feeWei: 1n,
    }),
    publishContentV2: vi.fn(),
    reconcileTransaction: vi.fn().mockResolvedValue({
      status: 'confirmed',
      txHash: ANCHOR_TX_HASH,
      blockNumber: 120,
      gasUsed: 1n,
      feeWei: 1n,
    }),
    ...overrides,
  } as unknown as IdentityPublisher;
}

class DirectDeliveryEngine extends TaskEngine {
  async deliverCurrent(requestId: string): Promise<void> {
    await this.deliver(this.persistence.getOrThrow(requestId));
  }
}

describe('Autopilot adoption-aware delivery', () => {
  it('reserves independent solver, evaluator, and Verdict-adoption stages', () => {
    const now = Date.parse('2026-07-24T11:00:00.000Z');
    seedDelivering(persistence, {
      ...taskInput(),
      windowEndTs: Date.parse('2026-07-24T14:00:00.000Z'),
    });
    const run = persistence.getOrThrow(REQUEST_ID);

    expect(effectiveHarnessDeadline(run, 'restoration', now)).toBe(
      Date.parse('2026-07-24T12:00:00.000Z'),
    );
    expect(effectiveHarnessDeadline(run, 'evaluation', now)).toBe(
      Date.parse('2026-07-24T12:00:00.000Z'),
    );
    expect(effectiveHarnessDeadline(
      run,
      'evaluation',
      Date.parse('2026-07-24T13:20:00.000Z'),
    )).toBe(Date.parse('2026-07-24T13:30:00.000Z'));
  });
  let store: Store;
  let persistence: TaskRunPersistence;

  beforeEach(() => {
    vi.mocked(callDeliverToMarketplace)
      .mockReset()
      .mockResolvedValue(DELIVERY_TX_HASH as Hex);
    vi.mocked(claimDelivery)
      .mockReset()
      .mockResolvedValue(`0x${'ef'.repeat(32)}` as Hex);
    store = new Store(':memory:');
    persistence = new TaskRunPersistence(store.db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
  });

  it('pauses a parsed Autopilot session after Mech delivery and persists the full wait payload', async () => {
    seedDelivering(persistence);
    const identityPublisher = makeIdentityPublisher();
    vi.mocked(identityPublisher.publishContent).mockImplementationOnce(async () => {
      expect(persistence.getOrThrow(REQUEST_ID).state).toBe(TaskRunState.DELIVERING);
      return {
        txHash: ANCHOR_TX_HASH,
        blockNumber: 120,
        gasUsed: 1n,
        feeWei: 1n,
      };
    });
    const engine = new TaskEngine(makeOptions(store, makeObserver(), identityPublisher));
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
    expect(identityPublisher.publishContent).toHaveBeenCalledWith({
      kind: 'envelope',
      cid: MANIFEST_CID,
      payload: expect.objectContaining({
        version: 1,
        tier: 0,
        manifestHash: EVIDENCE_HASH,
      }),
      requireSuccessfulReceipt: true,
      onBroadcast: expect.any(Function),
    });
    expect(claimDelivery).not.toHaveBeenCalled();
  });

  it('does not begin adoption polling when the correctness-critical publisher is absent', async () => {
    seedDelivering(persistence);
    const engine = new TaskEngine({
      ...makeOptions(store, makeObserver()),
      identityPublisher: undefined,
    });

    await expect(engine.process(REQUEST_ID)).rejects.toThrow(
      'delivery discovery anchor unavailable',
    );
    expect(persistence.getOrThrow(REQUEST_ID)).toMatchObject({
      state: TaskRunState.DELIVERING,
      adoptionWaitStartedAt: null,
    });
  });

  it('persists the pre-claim anchor broadcast and reconciles it after a crash before adoption', async () => {
    seedDelivering(persistence);
    const firstPublisher = makeIdentityPublisher();
    vi.mocked(firstPublisher.publishContent).mockImplementationOnce(async (args) => {
      args.onBroadcast?.(ANCHOR_TX_HASH);
      throw new Error('receipt temporarily unavailable');
    });
    const firstEngine = new TaskEngine(makeOptions(store, makeObserver(), firstPublisher));

    await expect(firstEngine.process(REQUEST_ID)).rejects.toThrow(
      'delivery discovery anchor unavailable',
    );
    expect(persistence.getOrThrow(REQUEST_ID)).toMatchObject({
      state: TaskRunState.DELIVERING,
      deliveryTxHash: DELIVERY_TX_HASH,
      deliveryDiscoveryAnchorTxHash: ANCHOR_TX_HASH,
      deliveryDiscoveryAnchorBlockNumber: null,
    });

    const retryPublisher = makeIdentityPublisher();
    const retryEngine = new TaskEngine(makeOptions(store, makeObserver(), retryPublisher));
    await retryEngine.process(REQUEST_ID);

    expect(retryPublisher.reconcileTransaction).toHaveBeenCalledWith(ANCHOR_TX_HASH);
    expect(retryPublisher.publishContent).not.toHaveBeenCalled();
    expect(persistence.getOrThrow(REQUEST_ID)).toMatchObject({
      state: TaskRunState.AWAITING_ADOPTION,
      deliveryDiscoveryAnchorTxHash: ANCHOR_TX_HASH,
      deliveryDiscoveryAnchorBlockNumber: 120,
    });
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

  it('persists adoption polling backoff across rapid ticks and restart', async () => {
    let now = Date.parse('2026-07-23T12:00:00.000Z');
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      seedDelivering(persistence);
      const pending = {
        state: 'pending' as const,
        observedAt: '2026-07-23T12:01:00.000Z',
        detail: 'Receipt not published yet.',
      };
      const observer = makeObserver(pending, pending);
      const engine = new TaskEngine(makeOptions(store, observer));

      await engine.process(REQUEST_ID);
      await engine.process(REQUEST_ID);
      const scheduled = persistence.getOrThrow(REQUEST_ID)
        .adoptionNextObservationAt!;
      expect(scheduled).toBeGreaterThan(now);

      const restarted = new TaskEngine(makeOptions(store, observer));
      await restarted.recoverInFlight();
      await restarted.process(REQUEST_ID);
      expect(observer.observe).toHaveBeenCalledOnce();

      now = scheduled;
      await restarted.process(REQUEST_ID);
      expect(observer.observe).toHaveBeenCalledTimes(2);
      expect(
        persistence.getOrThrow(REQUEST_ID).adoptionObservationAttempts,
      ).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });

  it('keeps polling a still-missing adoption receipt after the Task deadline', async () => {
    const expired = {
      ...taskInput(),
      windowEndTs: Date.now() - 1,
    };
    seedDelivering(persistence, expired);
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
    expect(run.adoptionLastError).toBe(
      'adoption-overdue:Receipt not published yet.',
    );
    expect(claimDelivery).not.toHaveBeenCalled();
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
    expect(run.adoptionAcceptedReceipt).toEqual(acceptedReceipt());
    expect(claimDelivery).not.toHaveBeenCalled();
  });

  it('republishes the anchor as committed only after the Router claim succeeds', async () => {
    seedDelivering(persistence);
    const identityPublisher = makeIdentityPublisher();
    const engine = new TaskEngine(makeOptions(
      store,
      makeObserver(
        { state: 'accepted', receipt: acceptedReceipt() },
        { state: 'accepted', receipt: acceptedReceipt() },
      ),
      identityPublisher,
    ));

    await engine.process(REQUEST_ID);
    await engine.process(REQUEST_ID);
    await engine.process(REQUEST_ID);

    expect(persistence.getOrThrow(REQUEST_ID).state).toBe(TaskRunState.COMPLETE);
    expect(identityPublisher.publishContent).toHaveBeenCalledTimes(2);
    expect(identityPublisher.publishContent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        payload: expect.objectContaining({ tier: 0 }),
        requireSuccessfulReceipt: true,
      }),
    );
    expect(identityPublisher.publishContent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        payload: expect.objectContaining({ tier: 1 }),
      }),
    );
  });

  it('accepts the SDK golden mutation-complete prefix and adoption-added Solution fields', async () => {
    const input = goldenTaskInput();
    const receipt = SDK_GOLDEN_ACCEPTED_SOLUTION as unknown as AutopilotAdoptionReceipt;
    seedDelivering(
      persistence,
      input,
      goldenSolutionOutput(),
      String(receipt.deliveryEnvelopeCid),
    );
    const engine = new TaskEngine(makeOptions(
      store,
      makeObserver({ state: 'accepted', receipt }),
    ));

    await engine.process(input.requestId);
    await engine.process(input.requestId);

    expect(persistence.getOrThrow(input.requestId)).toMatchObject({
      state: TaskRunState.CLAIMING_DELIVERY,
      adoptionAcceptedReceipt: receipt,
    });
  });

  it('rejects an accepted Solution receipt when a delivered core field differs', async () => {
    const input = goldenTaskInput();
    const correlation = SDK_GOLDEN_MUTATION['correlation'] as Record<string, unknown>;
    const delivered = {
      ...SDK_GOLDEN_MUTATION,
      correlation: {
        ...correlation,
        claimOid: '9'.repeat(40),
      },
    };
    const receipt = SDK_GOLDEN_ACCEPTED_SOLUTION as unknown as AutopilotAdoptionReceipt;
    seedDelivering(
      persistence,
      input,
      goldenSolutionOutput(delivered),
      String(receipt.deliveryEnvelopeCid),
    );
    const engine = new TaskEngine(makeOptions(
      store,
      makeObserver({ state: 'accepted', receipt }),
    ));

    await engine.process(input.requestId);
    await engine.process(input.requestId);

    const run = persistence.getOrThrow(input.requestId);
    expect(run.state).toBe(TaskRunState.FAILED);
    expect(run.failureReason).toContain(
      'adoption-contradiction:receipt correlation mismatch:delivered-output',
    );
  });

  it('rejects an accepted Solution receipt when a delivered optional field differs', async () => {
    const input = goldenTaskInput();
    const correlation = SDK_GOLDEN_MUTATION['correlation'] as Record<string, unknown>;
    const delivered = {
      ...SDK_GOLDEN_MUTATION,
      correlation: {
        ...correlation,
        resultingHead: '9'.repeat(40),
      },
    };
    const receipt = SDK_GOLDEN_ACCEPTED_SOLUTION as unknown as AutopilotAdoptionReceipt;
    seedDelivering(
      persistence,
      input,
      goldenSolutionOutput(delivered),
      String(receipt.deliveryEnvelopeCid),
    );
    const engine = new TaskEngine(makeOptions(
      store,
      makeObserver({ state: 'accepted', receipt }),
    ));

    await engine.process(input.requestId);
    await engine.process(input.requestId);

    const run = persistence.getOrThrow(input.requestId);
    expect(run.state).toBe(TaskRunState.FAILED);
    expect(run.failureReason).toContain(
      'adoption-contradiction:receipt correlation mismatch:delivered-output',
    );
  });

  it.each([
    ['taskId', { taskId: 'wrong-task' }],
    ['attemptIndex', { attemptIndex: ATTEMPT_INDEX + 1 }],
    ['requestId', { requestId: `0x${'99'.repeat(32)}` }],
    ['deliveryEnvelopeCid', { deliveryEnvelopeCid: 'bafy-wrong-envelope' }],
    ['v2AttemptId', { v2AttemptId: '123e4567-e89b-42d3-a456-426614174999' }],
    ['claimOid', { claimOid: '7'.repeat(40) }],
    ['prNumber', { prNumber: PR_NUMBER + 1 }],
    ['expectedHead', { expectedHead: '7'.repeat(40) }],
    ['resultingHead', { resultingHead: '7'.repeat(40) }],
    ['reviewGeneration', { reviewGeneration: '123e4567-e89b-42d3-a456-426614174999' }],
    ['reviewRefOid', { reviewRefOid: '7'.repeat(40) }],
  ] as const)(
    'fails closed when the accepted receipt mismatches persisted %s',
    async (_field, override) => {
      seedDelivering(persistence);
      const receipt = { ...acceptedReceipt(), ...override } as AutopilotAdoptionReceipt;
      const engine = new TaskEngine(makeOptions(
        store,
        makeObserver({ state: 'accepted', receipt }),
      ));

      await engine.process(REQUEST_ID);
      await engine.process(REQUEST_ID);

      const run = persistence.getOrThrow(REQUEST_ID);
      expect(run.state).toBe(TaskRunState.FAILED);
      expect(run.failureReason).toContain('adoption-contradiction:receipt correlation mismatch');
      expect(claimDelivery).not.toHaveBeenCalled();
    },
  );

  it('fails closed when the accepted receipt role does not match the run settlement role', async () => {
    seedDelivering(persistence, taskInput(autopilotSpec(), 'jinn-repo.v1', 'evaluation'));
    const engine = new TaskEngine(makeOptions(
      store,
      makeObserver({ state: 'accepted', receipt: acceptedReceipt() }),
    ));

    await engine.process(REQUEST_ID);
    await engine.process(REQUEST_ID);

    const run = persistence.getOrThrow(REQUEST_ID);
    expect(run.state).toBe(TaskRunState.FAILED);
    expect(run.failureReason).toBe(
      'adoption-contradiction:receipt role solution does not match verdict',
    );
    expect(claimDelivery).not.toHaveBeenCalled();
  });

  it('accepts a verdict receipt only when its complete review correlation matches', async () => {
    seedDelivering(persistence, taskInput(autopilotSpec(), 'jinn-repo.v1', 'evaluation'));
    const engine = new TaskEngine(makeOptions(
      store,
      makeObserver({ state: 'accepted', receipt: acceptedVerdictReceipt() }),
    ));

    await engine.process(REQUEST_ID);
    await engine.process(REQUEST_ID);

    expect(persistence.getOrThrow(REQUEST_ID)).toMatchObject({
      state: TaskRunState.CLAIMING_DELIVERY,
      adoptionAcceptedReceipt: acceptedVerdictReceipt(),
    });
  });

  it('fails closed when a verdict receipt mismatches the persisted reviewed head', async () => {
    seedDelivering(persistence, taskInput(autopilotSpec(), 'jinn-repo.v1', 'evaluation'));
    const engine = new TaskEngine(makeOptions(
      store,
      makeObserver({
        state: 'accepted',
        receipt: acceptedVerdictReceipt({ reviewedHead: '7'.repeat(40) }),
      }),
    ));

    await engine.process(REQUEST_ID);
    await engine.process(REQUEST_ID);

    const run = persistence.getOrThrow(REQUEST_ID);
    expect(run.state).toBe(TaskRunState.FAILED);
    expect(run.failureReason).toContain(
      'adoption-contradiction:receipt correlation mismatch:delivered-output',
    );
    expect(claimDelivery).not.toHaveBeenCalled();
  });

  it('fails closed when the observer returns a receipt that does not pass the strict SDK schema', async () => {
    seedDelivering(persistence);
    const invalidReceipt = {
      ...acceptedReceipt(),
      recordedAt: 'not-an-ISO-timestamp',
    } as unknown as AutopilotAdoptionReceipt;
    const engine = new TaskEngine(makeOptions(
      store,
      makeObserver({ state: 'accepted', receipt: invalidReceipt }),
    ));

    await engine.process(REQUEST_ID);
    await engine.process(REQUEST_ID);

    const run = persistence.getOrThrow(REQUEST_ID);
    expect(run.state).toBe(TaskRunState.FAILED);
    expect(run.failureReason).toBe('adoption-contradiction:invalid adoption receipt');
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

    const restartedObserver = makeObserver({
      state: 'accepted',
      receipt: acceptedReceipt(),
    });
    const restartedEngine = new TaskEngine(makeOptions(store, restartedObserver));
    const { callDeliverToMarketplace, claimDelivery } = await import('../../../src/adapters/mech/contracts.js');

    await restartedEngine.recoverInFlight();

    expect(persistence.getOrThrow(REQUEST_ID).state).toBe(TaskRunState.COMPLETE);
    expect(restartedObserver.observe).toHaveBeenCalledOnce();
    expect(callDeliverToMarketplace).not.toHaveBeenCalled();
    expect(claimDelivery).toHaveBeenCalledOnce();
  });

  it('completes crash recovery from the committed Router claim before re-reading mutable GitHub state', async () => {
    seedDelivering(persistence);
    const firstObserver = makeObserver({
      state: 'accepted',
      receipt: acceptedReceipt(),
    });
    const firstEngine = new TaskEngine(makeOptions(store, firstObserver));
    await firstEngine.process(REQUEST_ID);
    await firstEngine.process(REQUEST_ID);
    expect(persistence.getOrThrow(REQUEST_ID).state)
      .toBe(TaskRunState.CLAIMING_DELIVERY);

    vi.mocked(isDeliveryAlreadyClaimed).mockResolvedValueOnce(true);
    const advancedAuthorityObserver = makeObserver({
      state: 'pending',
      observedAt: '2026-07-23T12:02:00.000Z',
      detail: 'review authority advanced after the claim committed',
    });
    const restarted = new TaskEngine(
      makeOptions(store, advancedAuthorityObserver),
    );

    await restarted.recoverInFlight();

    expect(persistence.getOrThrow(REQUEST_ID).state)
      .toBe(TaskRunState.COMPLETE);
    expect(advancedAuthorityObserver.observe).not.toHaveBeenCalled();
    expect(claimDelivery).not.toHaveBeenCalled();
  });

  it('retries an overdue accepted Router claim after a transient failure', async () => {
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    seedDelivering(persistence, {
      ...taskInput(),
      windowEndTs: now - 1,
    });
    const accepted = {
      state: 'accepted' as const,
      receipt: acceptedReceipt(),
    };
    const observer = makeObserver(accepted, accepted, accepted);
    vi.mocked(claimDelivery)
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(`0x${'ef'.repeat(32)}` as Hex);
    const engine = new TaskEngine(makeOptions(store, observer));

    await engine.process(REQUEST_ID);
    await engine.process(REQUEST_ID);
    await expect(engine.process(REQUEST_ID)).rejects.toThrow('ECONNRESET');
    expect(persistence.getOrThrow(REQUEST_ID).state)
      .toBe(TaskRunState.CLAIMING_DELIVERY);
    expect(persistence.getOrThrow(REQUEST_ID).failureReason).toBeNull();

    await engine.process(REQUEST_ID);
    expect(claimDelivery).toHaveBeenCalledOnce();
    now += 5 * 60_000;
    await engine.process(REQUEST_ID);
    expect(persistence.getOrThrow(REQUEST_ID).state)
      .toBe(TaskRunState.COMPLETE);
    expect(claimDelivery).toHaveBeenCalledTimes(2);
    clock.mockRestore();
  });

  it('does not claim when an accepted receipt is no longer fresh at the Router boundary', async () => {
    seedDelivering(persistence);
    const observer = makeObserver(
      { state: 'accepted', receipt: acceptedReceipt() },
      {
        state: 'pending',
        observedAt: '2026-07-23T12:02:00.000Z',
        detail: 'The exact-head native approval is no longer present.',
      },
    );
    const engine = new TaskEngine(makeOptions(store, observer));

    await engine.process(REQUEST_ID);
    await engine.process(REQUEST_ID);
    await engine.process(REQUEST_ID);

    const run = persistence.getOrThrow(REQUEST_ID);
    expect(run.state).toBe(TaskRunState.CLAIMING_DELIVERY);
    expect(run.failureReason).toBeNull();
    expect(run.adoptionLastObservation).toEqual({
      state: 'pending',
      observedAt: '2026-07-23T12:02:00.000Z',
      detail: 'The exact-head native approval is no longer present.',
    });
    expect(claimDelivery).not.toHaveBeenCalled();
    const restarted = new TaskEngine(makeOptions(store, observer));
    await restarted.recoverInFlight();
    expect(observer.observe).toHaveBeenCalledTimes(2);
    expect(persistence.getOrThrow(REQUEST_ID).adoptionNextObservationAt)
      .toBeGreaterThan(Date.now());
  });

  it('does not claim when claim-time receipt observation is unavailable', async () => {
    seedDelivering(persistence);
    const observer = makeObserver(
      { state: 'accepted', receipt: acceptedReceipt() },
    );
    const engine = new TaskEngine(makeOptions(store, observer));

    await engine.process(REQUEST_ID);
    await engine.process(REQUEST_ID);
    await engine.process(REQUEST_ID);

    const run = persistence.getOrThrow(REQUEST_ID);
    expect(run.state).toBe(TaskRunState.CLAIMING_DELIVERY);
    expect(run.adoptionLastError).toBe('unexpected observer call');
    expect(claimDelivery).not.toHaveBeenCalled();
  });

  it('fails closed when the accepted receipt changes before the Router claim', async () => {
    seedDelivering(persistence);
    const changedReceipt = {
      ...acceptedReceipt(),
      recordedAt: '2026-07-23T12:03:00.000Z',
    };
    const observer = makeObserver(
      { state: 'accepted', receipt: acceptedReceipt() },
      { state: 'accepted', receipt: changedReceipt },
    );
    const engine = new TaskEngine(makeOptions(store, observer));

    await engine.process(REQUEST_ID);
    await engine.process(REQUEST_ID);
    await engine.process(REQUEST_ID);

    const run = persistence.getOrThrow(REQUEST_ID);
    expect(run.state).toBe(TaskRunState.FAILED);
    expect(run.failureReason).toBe(
      'adoption-contradiction:persisted accepted receipt mismatch',
    );
    expect(claimDelivery).not.toHaveBeenCalled();
  });

  it('fails with the stable rejection when claim-time observation rejects adoption', async () => {
    seedDelivering(persistence);
    const observer = makeObserver(
      { state: 'accepted', receipt: acceptedReceipt() },
      { state: 'rejected', receipt: rejectedReceipt() },
    );
    const engine = new TaskEngine(makeOptions(store, observer));

    await engine.process(REQUEST_ID);
    await engine.process(REQUEST_ID);
    await engine.process(REQUEST_ID);

    const run = persistence.getOrThrow(REQUEST_ID);
    expect(run.state).toBe(TaskRunState.FAILED);
    expect(run.failureReason).toBe('adoption-rejected:stale-head');
    expect(claimDelivery).not.toHaveBeenCalled();
  });

  it('recovers the exact crash after Mech delivery without submitting a second delivery', async () => {
    seedDelivering(persistence);
    const firstEngine = new DirectDeliveryEngine(makeOptions(store, makeObserver()));
    const persistenceCrash = vi.spyOn(
      TaskRunPersistence.prototype,
      'setDeliveryTxHash',
    ).mockImplementationOnce(() => {
      throw new Error('simulated process crash before tx-hash persistence');
    });

    await expect(firstEngine.deliverCurrent(REQUEST_ID)).rejects.toThrow(
      'simulated process crash before tx-hash persistence',
    );
    persistenceCrash.mockRestore();
    expect(callDeliverToMarketplace).toHaveBeenCalledOnce();
    expect(persistence.getOrThrow(REQUEST_ID)).toMatchObject({
      state: TaskRunState.DELIVERING,
      deliveryTxHash: null,
    });

    const recovery = {
      resolveExistingDelivery: vi.fn().mockResolvedValue({
        state: 'matching',
        requestId: REQUEST_ID,
        deliveryTxHash: DELIVERY_TX_HASH,
        deliveryDigest: DELIVERY_DIGEST,
        manifestCid: MANIFEST_CID,
        evidenceHash: EVIDENCE_HASH,
        role: 'solution',
        fromBlock: 100n,
      }),
    };
    const restartedEngine = new TaskEngine({
      ...makeOptions(store, makeObserver()),
      marketplaceDeliveryRecovery: recovery,
    } as TaskEngineOptions);

    await restartedEngine.recoverInFlight();

    expect(recovery.resolveExistingDelivery).toHaveBeenCalledOnce();
    expect(callDeliverToMarketplace).toHaveBeenCalledOnce();
    expect(persistence.getOrThrow(REQUEST_ID)).toMatchObject({
      state: TaskRunState.AWAITING_ADOPTION,
      deliveryTxHash: DELIVERY_TX_HASH,
      deliveryDigest: DELIVERY_DIGEST,
    });
  });

  it('same-process retry resolves the landed event instead of Mech-delivering twice', async () => {
    seedDelivering(persistence);
    const recovery = {
      resolveExistingDelivery: vi.fn()
        .mockResolvedValueOnce({ state: 'absent' })
        .mockResolvedValueOnce({
          state: 'matching',
          requestId: REQUEST_ID,
          deliveryTxHash: DELIVERY_TX_HASH,
          deliveryDigest: DELIVERY_DIGEST,
          manifestCid: MANIFEST_CID,
          evidenceHash: EVIDENCE_HASH,
          role: 'solution',
          fromBlock: 100n,
        }),
    };
    const engine = new DirectDeliveryEngine({
      ...makeOptions(store, makeObserver()),
      marketplaceDeliveryRecovery: recovery,
    });
    const persistenceCrash = vi.spyOn(
      TaskRunPersistence.prototype,
      'setDeliveryTxHash',
    ).mockImplementationOnce(() => {
      throw new Error('simulated live-process persistence failure');
    });

    await expect(engine.deliverCurrent(REQUEST_ID)).rejects.toThrow(
      'simulated live-process persistence failure',
    );
    persistenceCrash.mockRestore();
    await engine.deliverCurrent(REQUEST_ID);

    expect(recovery.resolveExistingDelivery).toHaveBeenCalledTimes(2);
    expect(callDeliverToMarketplace).toHaveBeenCalledOnce();
    expect(persistence.getOrThrow(REQUEST_ID)).toMatchObject({
      state: TaskRunState.AWAITING_ADOPTION,
      deliveryTxHash: DELIVERY_TX_HASH,
    });
  });

  it('resolves exact chain state after a duplicate delivery revert instead of trusting its message', async () => {
    seedDelivering(persistence);
    const recovery = {
      resolveExistingDelivery: vi.fn()
        .mockResolvedValueOnce({ state: 'absent' })
        .mockResolvedValueOnce({
          state: 'matching',
          requestId: REQUEST_ID,
          deliveryTxHash: DELIVERY_TX_HASH,
          deliveryDigest: DELIVERY_DIGEST,
          manifestCid: MANIFEST_CID,
          evidenceHash: EVIDENCE_HASH,
          role: 'solution',
          fromBlock: 100n,
        }),
    };
    vi.mocked(callDeliverToMarketplace).mockRejectedValueOnce(
      new Error('AlreadyDelivered'),
    );
    const engine = new DirectDeliveryEngine({
      ...makeOptions(store, makeObserver()),
      marketplaceDeliveryRecovery: recovery,
    });

    await engine.deliverCurrent(REQUEST_ID);

    expect(callDeliverToMarketplace).toHaveBeenCalledOnce();
    expect(recovery.resolveExistingDelivery).toHaveBeenCalledTimes(2);
    expect(persistence.getOrThrow(REQUEST_ID)).toMatchObject({
      state: TaskRunState.AWAITING_ADOPTION,
      deliveryTxHash: DELIVERY_TX_HASH,
    });
  });

  it('Mech-delivers during recovery only after exact recovery reports authoritative absence', async () => {
    seedDelivering(persistence);
    const recovery = {
      resolveExistingDelivery: vi.fn().mockResolvedValue({ state: 'absent' }),
    };
    const restartedEngine = new TaskEngine({
      ...makeOptions(store, makeObserver()),
      marketplaceDeliveryRecovery: recovery,
    } as TaskEngineOptions);

    await restartedEngine.recoverInFlight();

    expect(recovery.resolveExistingDelivery).toHaveBeenCalledOnce();
    expect(callDeliverToMarketplace).toHaveBeenCalledOnce();
    expect(persistence.getOrThrow(REQUEST_ID).state).toBe(
      TaskRunState.AWAITING_ADOPTION,
    );
  });

  it('fails closed when exact delivery recovery finds contradictory metadata', async () => {
    seedDelivering(persistence);
    const recovery = {
      resolveExistingDelivery: vi.fn().mockResolvedValue({
        state: 'contradictory',
        detail: 'on-chain envelope digest differs',
      }),
    };
    const restartedEngine = new TaskEngine({
      ...makeOptions(store, makeObserver()),
      marketplaceDeliveryRecovery: recovery,
    } as TaskEngineOptions);

    await restartedEngine.recoverInFlight();

    expect(recovery.resolveExistingDelivery).toHaveBeenCalledOnce();
    expect(callDeliverToMarketplace).not.toHaveBeenCalled();
    expect(persistence.getOrThrow(REQUEST_ID)).toMatchObject({
      state: TaskRunState.FAILED,
      failureReason: 'delivery-recovery-contradiction:on-chain envelope digest differs',
    });
  });

  it('reasserts the persisted accepted receipt before claiming and fails closed on tampering', async () => {
    seedDelivering(persistence);
    const firstEngine = new TaskEngine(makeOptions(
      store,
      makeObserver({ state: 'accepted', receipt: acceptedReceipt() }),
    ));
    await firstEngine.process(REQUEST_ID);
    await firstEngine.process(REQUEST_ID);

    const tampered = {
      ...acceptedReceipt(),
      taskId: 'tampered-task',
    };
    store.db.prepare(
      'UPDATE task_runs SET adoption_accepted_receipt = ? WHERE request_id = ?',
    ).run(JSON.stringify(tampered), REQUEST_ID);
    vi.clearAllMocks();

    const restartedEngine = new TaskEngine(makeOptions(store, makeObserver()));
    await restartedEngine.recoverInFlight();

    const run = persistence.getOrThrow(REQUEST_ID);
    expect(run.state).toBe(TaskRunState.FAILED);
    expect(run.failureReason).toContain('adoption-contradiction:persisted accepted receipt');
    expect(callDeliverToMarketplace).not.toHaveBeenCalled();
    expect(claimDelivery).not.toHaveBeenCalled();
  });

  it('stays recoverable without an observer and never claims delivery', async () => {
    seedDelivering(persistence);
    const engine = new TaskEngine(makeOptions(store));

    await engine.process(REQUEST_ID);
    await engine.process(REQUEST_ID);

    const run = persistence.getOrThrow(REQUEST_ID);
    expect(run.state).toBe(TaskRunState.AWAITING_ADOPTION);
    expect(run.failureReason).toBeNull();
    expect(run.adoptionLastError).toBe('adoption receipt observer is not configured');
    expect(claimDelivery).not.toHaveBeenCalled();
  });

  it('single-flights simultaneous direct and tick processing for one delivery', async () => {
    seedDelivering(persistence);
    const engine = new TaskEngine(makeOptions(store, makeObserver()));
    let releaseDelivery!: () => void;
    let deliveryStarted!: () => void;
    const started = new Promise<void>((resolve) => { deliveryStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseDelivery = resolve; });
    vi.mocked(callDeliverToMarketplace).mockImplementation(async () => {
      deliveryStarted();
      await release;
      return DELIVERY_TX_HASH as Hex;
    });

    const direct = engine.process(REQUEST_ID);
    await started;
    const duplicateDirect = engine.process(REQUEST_ID);
    const tick = engine.tick();
    await new Promise((resolve) => setImmediate(resolve));

    const callsBeforeRelease = vi.mocked(callDeliverToMarketplace).mock.calls.length;
    releaseDelivery();
    const outcomes = await Promise.allSettled([direct, duplicateDirect, tick]);

    expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true);
    expect(callsBeforeRelease).toBe(1);
    expect(callDeliverToMarketplace).toHaveBeenCalledOnce();
    expect(persistence.getOrThrow(REQUEST_ID).state).toBe(
      TaskRunState.AWAITING_ADOPTION,
    );
    expect(persistence.getOrThrow(REQUEST_ID).failureReason).toBeNull();
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
