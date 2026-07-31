/**
 * Composition root (cutover stage 1, Task 12; C8 close-out) tests. `buildClaimPredicate` is pure
 * and tested directly; `buildOperatorComposition` is exercised end to end against a real
 * `LocalTaskExecutionBackend` + real evidence runtime + real trust-resolve/pipeline wiring +
 * (C8) a real `ProjectorLoop`/`ClaimGate`/`EngagementLedger`/`verifySettlementGrade`, with only
 * `createBaseVenue` (chain I/O) and `openOperatorEvidence` (kept but hermetic — see below)
 * stubbed via `vi.mock`. `openVenueState`/`createChainLogSource` and the rest of
 * `@jinn-network/marketplace-venue-base` stay real (pure local SQLite, no network) so the
 * projector wiring this test proves is the actual production path.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CLAIM_NOTHING } from '@jinn-network/marketplace-pipeline';
import { Store } from '../../src/store/store.js';
import { ProjectorCursorStore } from '../../src/daemon/projector-cursor.js';
import { ProjectorLoop } from '../../src/daemon/projector-loop.js';

const { createBaseVenueMock, safeExecuteMock, venueCloseMock } = vi.hoisted(() => ({
  createBaseVenueMock: vi.fn(),
  safeExecuteMock: vi.fn(async () => ({ txHash: '0xaa' as const })),
  venueCloseMock: vi.fn(),
}));

// Only `createBaseVenue` is replaced — `openVenueState`/`createChainLogSource` (C3) stay real so
// the projector's log-source wiring this test exercises is production code, not a fake.
vi.mock('@jinn-network/marketplace-venue-base', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@jinn-network/marketplace-venue-base')>();
  return { ...actual, createBaseVenue: createBaseVenueMock };
});

const { openOperatorEvidenceMock, evidenceCloseMock } = vi.hoisted(() => ({
  openOperatorEvidenceMock: vi.fn(),
  evidenceCloseMock: vi.fn(async () => undefined),
}));

vi.mock('../../src/daemon/evidence-join.js', () => ({
  openOperatorEvidence: openOperatorEvidenceMock,
}));

const WIRING = [
  {
    workKind: 'QmSolver',
    harness: 'claude-code',
    model: 'm',
    plugins: [],
    credentialRef: 'c',
    isolationPolicy: 'process',
    legacyManifestDigest: 'QmSolver',
  },
];

const FACTS = {
  taskId: 1n,
  taskDigest: `sha256:${'a'.repeat(64)}` as const,
  submission: 'urn:uuid:11111111-2222-3333-4444-555555555555' as const,
  nonce: '0x1',
  profileUri: 'p',
  requirements: {},
  runnable: true,
  intendedSpendWei: 0n,
  intendedAiUnits: 0,
  workKind: 'QmSolver',
  legacyManifestDigest: 'QmSolver',
};

const CAPS = { spendCapWei: 10n, aiUnitCap: 10 };

describe('claim predicate assembly', () => {
  it('claims nothing when no policy is configured', async () => {
    const { buildClaimPredicate } = await import('../../src/daemon/composition-root.js');
    expect(buildClaimPredicate(undefined, WIRING)).toBe(CLAIM_NOTHING);
  });

  it('claims nothing in claim-nothing mode', async () => {
    const { buildClaimPredicate } = await import('../../src/daemon/composition-root.js');
    const predicate = buildClaimPredicate(
      { mode: 'claim-nothing', spendCapWei: '10', aiUnitCap: 10 },
      WIRING,
    );
    expect(predicate).toBe(CLAIM_NOTHING);
  });

  it('claims every runnable card in every-runnable mode', async () => {
    const { buildClaimPredicate } = await import('../../src/daemon/composition-root.js');
    const predicate = buildClaimPredicate(
      { mode: 'every-runnable', spendCapWei: '10', aiUnitCap: 10 },
      WIRING,
    );
    expect(predicate!(FACTS, {} as never, CAPS)).toBe(true);
    expect(predicate!({ ...FACTS, runnable: false }, {} as never, CAPS)).toBe(false);
  });

  it('matches the legacy manifest digest in bridge mode', async () => {
    const { buildClaimPredicate } = await import('../../src/daemon/composition-root.js');
    const predicate = buildClaimPredicate(
      { mode: 'match-legacy-manifest-digest', spendCapWei: '10', aiUnitCap: 10 },
      WIRING,
    );
    expect(predicate!(FACTS, {} as never, CAPS)).toBe(true);
    expect(
      predicate!({ ...FACTS, legacyManifestDigest: 'QmOther' }, {} as never, CAPS),
    ).toBe(false);
  });

  it('declines a work kind with no wiring entry in bridge mode', async () => {
    const { buildClaimPredicate } = await import('../../src/daemon/composition-root.js');
    const predicate = buildClaimPredicate(
      { mode: 'match-legacy-manifest-digest', spendCapWei: '10', aiUnitCap: 10 },
      WIRING,
    );
    // No wiring entry means no legacy digest to match; runPipeline's `wiring-missing`
    // gate is the authority, so the predicate must not silently accept.
    expect(predicate!({ ...FACTS, workKind: 'QmUnknown' }, {} as never, CAPS)).toBe(false);
  });
});

describe('operator caps assembly (coordinator amendment 1)', () => {
  it('is permissive when no policy caps are configured', async () => {
    const { buildOperatorCaps } = await import('../../src/daemon/composition-root.js');
    expect(buildOperatorCaps(undefined)).toEqual({
      spendCapWei: 2n ** 256n - 1n,
      aiUnitCap: Number.MAX_SAFE_INTEGER,
    });
    expect(buildOperatorCaps({ mode: 'every-runnable' })).toEqual({
      spendCapWei: 2n ** 256n - 1n,
      aiUnitCap: Number.MAX_SAFE_INTEGER,
    });
  });

  it('honors a configured spend cap and AI-unit cap', async () => {
    const { buildOperatorCaps } = await import('../../src/daemon/composition-root.js');
    expect(
      buildOperatorCaps({ mode: 'every-runnable', spendCapWei: '12345', aiUnitCap: 7 }),
    ).toEqual({ spendCapWei: 12345n, aiUnitCap: 7 });
  });
});

function stubVenue() {
  return {
    claim: { taskDigest: 'stub' },
    settlement: { pin: vi.fn(), verifySettlementGrade: vi.fn() },
    lifecycle: {},
    finality: {},
    deliveryWait: {},
    release: {},
    observe: {},
    safe: { safeAddress: '0xSafe', execute: safeExecuteMock, classify: vi.fn() },
    logSource: { close: vi.fn(), orphanedBlockHashes: () => new Set() },
    intents: {},
    close: venueCloseMock,
  };
}

describe('buildOperatorComposition', () => {
  it('installs the broadcaster, wires the pipeline, and closes the evidence runtime', async () => {
    createBaseVenueMock.mockReset().mockImplementation(() => stubVenue());
    openOperatorEvidenceMock.mockReset().mockResolvedValue({
      runtime: {},
      ports: { repository: {}, catalog: {}, awaitIndexed: vi.fn() },
      close: evidenceCloseMock,
    });

    const { buildOperatorComposition } = await import('../../src/daemon/composition-root.js');

    const stateRoot = mkdtempSync(join(tmpdir(), 'jinn-composition-state-'));
    const evidenceRoot = mkdtempSync(join(tmpdir(), 'jinn-composition-evidence-'));

    const config = {
      ipfsRegistryUrl: 'https://registry.example',
      rpcUrl: 'http://127.0.0.1:8545',
      claudePath: 'claude',
      codexPath: undefined,
      hermesPath: undefined,
      executionWiring: [
        {
          workKind: 'QmSolver',
          harness: 'claude-code',
          model: 'm',
          plugins: [],
          credentialRef: 'c',
          isolationPolicy: 'process',
          legacyManifestDigest: 'QmSolver',
        },
      ],
      claimPolicy: { mode: 'every-runnable', spendCapWei: '999', aiUnitCap: 3 },
    };

    const safeAddress = '0x1111111111111111111111111111111111111111' as const;
    const mechAddress = '0x2222222222222222222222222222222222222222' as const;
    const chain = {
      chainId: 84532,
      taskCoordinator: '0x3333333333333333333333333333333333333333',
      jinnRouter: '0x4444444444444444444444444444444444444444',
      mechMarketplace: '0x5555555555555555555555555555555555555555',
      activityChecker: '0x6666666666666666666666666666666666666666',
      generation: 'today',
    };
    const store = new Store(':memory:');
    // publicClient stub sufficient for the projector's log-source construction (C3): the
    // constructor does not eagerly call any of these — they're only invoked lazily from
    // `tick()`/`hasCaughtUp()`, neither of which this test drives.
    const publicClient = {
      getBlock: async () => ({ number: 0n, hash: '0x' + '0'.repeat(64) }),
    };

    const composition = await buildOperatorComposition({
      config: config as never,
      publicClient: publicClient as never,
      walletClient: { account: { address: safeAddress } } as never,
      safeAddress,
      mechAddress,
      chain: chain as never,
      stateRoot,
      evidenceRoot,
      venueStateDbPath: join(stateRoot, 'venue.db'),
      profileStore: { get: () => undefined },
      store,
    });

    // (a) the composition returns its own broadcaster (finding E16 / the C2 ruling: no
    // process-global install — the host threads `composition.broadcaster` explicitly).
    expect(composition.broadcaster).toBeDefined();
    expect(composition.broadcaster.safeAddress).toBe(safeAddress);
    await composition.broadcaster.execute({ to: '0x00', value: 0n, data: '0x', logicalTx: 'x' });
    expect(safeExecuteMock).toHaveBeenCalledTimes(1);

    // (b) pipelineConfig.wiring matches toPipelineWiring(config.executionWiring).
    const { toPipelineWiring } = await import('../../src/config/shape-v2.js');
    expect(composition.pipelineConfig.wiring).toEqual(
      toPipelineWiring(config.executionWiring as never),
    );

    // (c) pipelineConfig.caps reflects the configured policy.
    expect(composition.pipelineConfig.caps).toEqual({ spendCapWei: 999n, aiUnitCap: 3 });

    // (d) backend.capabilities() resolves with the configured taskProfiles.
    const capabilities = await composition.backend.capabilities();
    expect(new Set(capabilities.taskProfiles)).toEqual(
      new Set([
        'https://jinn.network/task-profiles/repository-work/1.0',
        'https://jinn.network/task-profiles/evaluation-task/1.0',
      ]),
    );

    // (f) C8: the projector loop is real and constructible (not merely typed) — a `ProjectorLoop`
    // instance with a working `hasCaughtUp()` (contract 3's claim-gate signal).
    expect(composition.projector).toBeInstanceOf(ProjectorLoop);
    expect(await composition.projector.hasCaughtUp()).toBe(false); // no cursor written yet

    // (g) C8: the claim gate is real — closed until the projector catches up.
    expect(composition.claimGate.isOpen()).toBe(false);

    // (h) C5/C8: `observations` (passed to `createBaseVenue`) is backed by the real
    // `ProjectorCursorStore`, not the old `async () => []` stub — proven by writing an
    // observation directly to the same `Store` under the composition's own cursor key and
    // reading it back through the exact function `createBaseVenue` was called with.
    const cursorKey = `${chain.chainId}:${chain.taskCoordinator.toLowerCase()}`;
    const cursorStore = new ProjectorCursorStore(store, cursorKey);
    const fakeObservation = {
      id: 'obs-1',
      kind: 'network.jinn.task-execution.submission-accepted.v1',
      data: {},
    } as never;
    cursorStore.write(
      {
        liveBlockNumber: 1n,
        liveBlockHash: `0x${'1'.repeat(64)}`,
        finalizedBlockNumber: 1n,
        finalizedBlockHash: `0x${'1'.repeat(64)}`,
        sequence: '0000000000000000',
        entryDigest: null,
        headJson: null,
        stateJson: '{}',
      },
      [fakeObservation],
    );
    const venueConfig = createBaseVenueMock.mock.calls[0]![0] as { observations: () => Promise<unknown[]> };
    await expect(venueConfig.observations()).resolves.toEqual([fakeObservation]);

    // (i) C6/C8: `verifySettlementGrade` is C6's real implementation, not composition-root's
    // deleted fail-closed stub — proven by seeding a matching engagement-ledger row and observing
    // `dispatchBinding` flip to "verified" (the old stub reported "missing" unconditionally for
    // every check, with no ledger dependency at all).
    expect(composition.pipelinePorts.settlement.verifySettlementGrade).toBe(venueConfig['verifySettlementGrade' as never]);
    const requestId = `0x${'a'.repeat(64)}` as const;
    composition.engagementLedger.admitClaimIntent({
      idempotencyKey: 'k1',
      chainId: chain.chainId,
      taskCoordinator: chain.taskCoordinator,
      taskId: 1n,
      workKind: 'QmSolver',
      wiring: config.executionWiring[0] as never,
    });
    // Finding E35: `dispatchBinding` now also compares the sealed digest, so the seeded row must
    // carry one that matches this call's `expectedDispatchContextDigest`.
    const dispatchContextDigest = `sha256:${'0'.repeat(64)}` as const;
    composition.engagementLedger.recordClaimed('k1', {
      attemptIndex: 0,
      attemptUri: 'urn:uuid:11111111-1111-4111-8111-111111111111',
      claimTxHash: '0xabc',
      requestId,
      dispatchContext: { digest: dispatchContextDigest, bytes: new TextEncoder().encode('{"fixture":true}') },
    });
    const grade = await composition.pipelinePorts.settlement.verifySettlementGrade({
      attempt: { requestId, expectedDispatchContextDigest: dispatchContextDigest } as never,
      delivery: {} as never,
      deliveryBytes: new Uint8Array(),
      deliveryDigest: `sha256:${'0'.repeat(64)}`,
      config: chain as never,
    });
    expect(grade.dispatchBinding.status).toBe('verified');
    expect(grade.evaluationSpecification.status).toBe('not-applicable');
    // Finding E31: no `deliverySigningKey` was supplied to this composition, so nothing was ever
    // signed -- `getDeliverySignature` legitimately finds no envelope for this digest.
    expect(grade.executorBinding.status).toBe('missing');

    // Finding E31: `signedDeliveries` reflects reality -- `false` here because this composition
    // was built with no `deliverySigningKey` (ending the old unconditional `true` lie).
    expect(capabilities.signedDeliveries).toBe(false);

    // (e) close() closes the evidence runtime and both venue-state handles (finding: the
    // composition's own `openVenueState` handle for the projector's log source, plus
    // `createBaseVenue`'s own separate connection to the same file — see the file header).
    await composition.close();
    expect(evidenceCloseMock).toHaveBeenCalledTimes(1);
    expect(venueCloseMock).toHaveBeenCalledTimes(1);
    store.close();
  });

  it('advertises repository-work when wiring selects prediction-v1-baseline (E39 cycle 3)', async () => {
    // E39 diagnose→fix cycle 3: the e2e wires harness: 'prediction-v1-baseline', but
    // ALL_LAUNCHERS only listed claude-code/codex/hermes/cursor. buildLaunchers returned [],
    // assembleCapabilities filtered provisioner profiles against an empty launcher set, and
    // verifyPreclaim declined every card with profile-mismatch even after the URI fix.
    createBaseVenueMock.mockReset().mockImplementation(() => stubVenue());
    openOperatorEvidenceMock.mockReset().mockResolvedValue({
      runtime: {},
      ports: { repository: {}, catalog: {}, awaitIndexed: vi.fn() },
      close: evidenceCloseMock,
    });

    const { buildOperatorComposition } = await import('../../src/daemon/composition-root.js');

    const stateRoot = mkdtempSync(join(tmpdir(), 'jinn-composition-prediction-'));
    const evidenceRoot = mkdtempSync(join(tmpdir(), 'jinn-composition-prediction-ev-'));
    const config = {
      ipfsRegistryUrl: 'https://registry.example',
      rpcUrl: 'http://127.0.0.1:8545',
      claudePath: 'claude',
      executionWiring: [
        {
          workKind: 'prediction.v1',
          harness: 'prediction-v1-baseline',
          model: 'prediction-v1-baseline/consensus',
          plugins: [],
          credentialRef: 'e2e',
          isolationPolicy: 'process',
          legacyManifestDigest: '0x' + 'ab'.repeat(32),
        },
      ],
      claimPolicy: { mode: 'match-legacy-manifest-digest' },
    };
    const store = new Store(':memory:');
    const composition = await buildOperatorComposition({
      config: config as never,
      publicClient: { getBlock: async () => ({ number: 0n, hash: '0x' + '0'.repeat(64) }) } as never,
      walletClient: { account: { address: '0x1111111111111111111111111111111111111111' } } as never,
      safeAddress: '0x1111111111111111111111111111111111111111',
      mechAddress: '0x2222222222222222222222222222222222222222',
      chain: {
        chainId: 84532,
        taskCoordinator: '0x3333333333333333333333333333333333333333',
        jinnRouter: '0x4444444444444444444444444444444444444444',
        mechMarketplace: '0x5555555555555555555555555555555555555555',
        activityChecker: '0x6666666666666666666666666666666666666666',
        generation: 'today',
      } as never,
      stateRoot,
      evidenceRoot,
      venueStateDbPath: join(stateRoot, 'venue.db'),
      profileStore: { get: () => undefined },
      store,
    });

    const capabilities = await composition.backend.capabilities();
    expect(capabilities.taskProfiles).toContain(
      'https://jinn.network/task-profiles/repository-work/1.0',
    );

    await composition.close();
    store.close();
  });

  it('wires a supplied deliverySigningKey through to signedDeliveries (finding E31)', async () => {
    createBaseVenueMock.mockReset().mockImplementation(() => stubVenue());
    openOperatorEvidenceMock.mockReset().mockResolvedValue({
      runtime: {},
      ports: { repository: {}, catalog: {}, awaitIndexed: vi.fn() },
      close: evidenceCloseMock,
    });

    const { buildOperatorComposition } = await import('../../src/daemon/composition-root.js');
    const { generateKeyPairSync, sign: cryptoSign } = await import('node:crypto');

    const stateRoot = mkdtempSync(join(tmpdir(), 'jinn-composition-state-signing-'));
    const evidenceRoot = mkdtempSync(join(tmpdir(), 'jinn-composition-evidence-signing-'));
    const config = {
      ipfsRegistryUrl: 'https://registry.example',
      rpcUrl: 'http://127.0.0.1:8545',
      claudePath: 'claude',
      codexPath: undefined,
      hermesPath: undefined,
      executionWiring: [],
      claimPolicy: { mode: 'claim-nothing' },
    };
    const safeAddress = '0x1111111111111111111111111111111111111111' as const;
    const mechAddress = '0x2222222222222222222222222222222222222222' as const;
    const chain = {
      chainId: 84532,
      taskCoordinator: '0x3333333333333333333333333333333333333333',
      jinnRouter: '0x4444444444444444444444444444444444444444',
      mechMarketplace: '0x5555555555555555555555555555555555555555',
      activityChecker: '0x6666666666666666666666666666666666666666',
      generation: 'today',
    };
    const store = new Store(':memory:');
    const publicClient = { getBlock: async () => ({ number: 0n, hash: '0x' + '0'.repeat(64) }) };
    const keyPair = generateKeyPairSync('ed25519');

    const composition = await buildOperatorComposition({
      config: config as never,
      publicClient: publicClient as never,
      walletClient: { account: { address: safeAddress } } as never,
      safeAddress,
      mechAddress,
      chain: chain as never,
      stateRoot,
      evidenceRoot,
      venueStateDbPath: join(stateRoot, 'venue.db'),
      profileStore: { get: () => undefined },
      store,
      deliverySigningKey: {
        keyId: 'operator-executor-key',
        publicKey: keyPair.publicKey,
        sign: (payload: Uint8Array) => new Uint8Array(cryptoSign(null, payload, keyPair.privateKey)),
      },
    });

    // Ending the lie: with a real key supplied, `signedDeliveries` reports `true`.
    const capabilities = await composition.backend.capabilities();
    expect(capabilities.signedDeliveries).toBe(true);

    await composition.close();
    store.close();
  });
});

describe('buildResolveSubmissionBytes (last-mile: gap a, first half CLOSED)', () => {
  const JINN_ROUTER = '0x4444444444444444444444444444444444444444' as const;
  const TASK_COORDINATOR = '0x3333333333333333333333333333333333333333' as const;
  const CREATOR = '0x5555555555555555555555555555555555555555' as const;

  /** A legacy `SignedTaskV1` document — what the legacy `CreatorLoop` actually posts (E32). */
  function legacyTaskBytes(): Uint8Array {
    return new TextEncoder().encode(JSON.stringify({
      schemaVersion: 'task.v1',
      id: 'legacy-task-1',
      solverType: 'prediction.v1',
      solverNetManifestCid: 'bafySolverNetManifest',
      contractId: 'prediction',
      contractVersion: 'v1',
      role: 'restoration',
      description: 'restore service health',
      window: { startTs: 1000, endTs: 2000 },
      spec: {},
      eligibility: {},
      claimPolicy: { maxClaims: 2 },
      creator: { safeAddress: CREATOR, agentEoa: CREATOR },
      createdAt: 1000,
      signature: {
        algo: 'secp256k1',
        signer: CREATOR,
        hash: `0x${'a'.repeat(64)}`,
        sig: `0x${'b'.repeat(130)}`,
      },
    }));
  }

  /** Mocks the exact two-hop read `getTaskCidDigest` performs (router -> taskCoordinator -> getTask). */
  function readContractMock(taskCidDigestBytes32: `0x${string}` | undefined) {
    return vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'taskCoordinator') return TASK_COORDINATOR;
      if (functionName === 'getTask') {
        if (taskCidDigestBytes32 === undefined) throw new Error('no such task');
        return [CREATOR, taskCidDigestBytes32] as const;
      }
      throw new Error(`unexpected functionName ${functionName}`);
    });
  }

  it('fetches the legacy SignedTaskV1 document via the on-chain taskCidDigest and enriches end to end through resolveTaskProjection', async () => {
    const { buildResolveSubmissionBytes } = await import('../../src/daemon/composition-root.js');
    const { createProjectorEnrich } = await import('../../src/daemon/projector-enrich.js');
    const { BASE_SEPOLIA_TODAY, computeRawCodecCid } = await import('@jinn-network/marketplace-binding');

    const taskBytes = legacyTaskBytes();
    const taskCidDigestHex = computeRawCodecCid(taskBytes).sha256Digest.slice('sha256:'.length);
    const taskCidDigestBytes32 = `0x${taskCidDigestHex}` as const;

    const publicClient = {
      readContract: readContractMock(taskCidDigestBytes32),
      getBlock: vi.fn(async () => ({ timestamp: 1_000_000_000n }) as never),
    };
    const fetchIpfsBytes = vi.fn(async (digest: `sha256:${string}`) =>
      digest === `sha256:${taskCidDigestHex}` ? taskBytes : undefined,
    );

    const resolveSubmissionBytes = buildResolveSubmissionBytes({
      publicClient: publicClient as never,
      jinnRouter: JINN_ROUTER,
      fetchIpfsBytes,
    });

    // (1) the port itself resolves the exact posted bytes.
    const resolved = await resolveSubmissionBytes({
      chainId: BASE_SEPOLIA_TODAY.chainId,
      taskCoordinator: TASK_COORDINATOR,
      taskId: 1n,
      generation: 'today',
    });
    expect(resolved).toEqual(taskBytes);

    // (2) end to end through `resolveTaskProjection` (internal to `createProjectorEnrich`): a real
    // `TaskCreated` event, enriched with the production resolver, reaches the bridge-synthesis
    // path (finding E32 / commit 051bc63c6) that was previously unreachable.
    const dispatchContext = { uri: 'urn:jinn:marketplace:dispatch-context:1:0', digest: { sha256: '9'.repeat(64) } };
    const enrich = createProjectorEnrich({
      chain: { ...BASE_SEPOLIA_TODAY, taskCoordinator: TASK_COORDINATOR, jinnRouter: JINN_ROUTER },
      publicClient: publicClient as never,
      fetchIpfsBytes,
      resolveSubmissionBytes,
      resolveDispatchContext: async () => dispatchContext,
      readTodayDeliveryFacts: async () => undefined,
    });

    const event = {
      event: 'TaskCreated',
      facts: {
        creator: CREATOR,
        taskId: 1n,
        manifestDigest: `0x${'9'.repeat(64)}`,
        taskCidDigest: taskCidDigestBytes32,
        maxClaims: 2,
        solutionBudget: 100n,
        verdictBudget: 20n,
      },
      derivation: {
        chainId: BASE_SEPOLIA_TODAY.chainId,
        contract: JINN_ROUTER,
        event: 'TaskCreated',
        blockNumber: 10,
        blockHash: `0x${'1'.repeat(64)}`,
        txHash: `0x${'2'.repeat(64)}`,
        logIndex: 0,
        finalityTier: 'safe',
        contractGeneration: 'today',
      },
    } as never;

    const enriched = await enrich(event);
    expect(enriched).toBeDefined();
    expect(enriched?.projection.taskDigest).toBe(`sha256:${taskCidDigestHex}`);
    expect(enriched?.projection.dispatchContext).toEqual(dispatchContext);
  });

  it('fails closed when the on-chain read reverts (no task posted under this id)', async () => {
    const { buildResolveSubmissionBytes } = await import('../../src/daemon/composition-root.js');
    const publicClient = { readContract: readContractMock(undefined) };
    const resolveSubmissionBytes = buildResolveSubmissionBytes({
      publicClient: publicClient as never,
      jinnRouter: JINN_ROUTER,
      fetchIpfsBytes: vi.fn(),
    });

    await expect(
      resolveSubmissionBytes({
        chainId: 84532,
        taskCoordinator: TASK_COORDINATOR,
        taskId: 999n,
        generation: 'today',
      }),
    ).resolves.toBeUndefined();
  });

  it('fails closed on an all-zero taskCidDigest without attempting an IPFS fetch', async () => {
    const { buildResolveSubmissionBytes } = await import('../../src/daemon/composition-root.js');
    const publicClient = { readContract: readContractMock(`0x${'0'.repeat(64)}`) };
    const fetchIpfsBytes = vi.fn();
    const resolveSubmissionBytes = buildResolveSubmissionBytes({
      publicClient: publicClient as never,
      jinnRouter: JINN_ROUTER,
      fetchIpfsBytes,
    });

    await expect(
      resolveSubmissionBytes({
        chainId: 84532,
        taskCoordinator: TASK_COORDINATOR,
        taskId: 1n,
        generation: 'today',
      }),
    ).resolves.toBeUndefined();
    expect(fetchIpfsBytes).not.toHaveBeenCalled();
  });

  it('fails closed when the resolved digest has no content on IPFS', async () => {
    const { buildResolveSubmissionBytes } = await import('../../src/daemon/composition-root.js');
    const taskCidDigestBytes32 = `0x${'c'.repeat(64)}` as const;
    const publicClient = { readContract: readContractMock(taskCidDigestBytes32) };
    const resolveSubmissionBytes = buildResolveSubmissionBytes({
      publicClient: publicClient as never,
      jinnRouter: JINN_ROUTER,
      fetchIpfsBytes: async () => undefined,
    });

    await expect(
      resolveSubmissionBytes({
        chainId: 84532,
        taskCoordinator: TASK_COORDINATOR,
        taskId: 1n,
        generation: 'today',
      }),
    ).resolves.toBeUndefined();
  });
});

// Finding E35 (ruled): `resolveDispatchContext`'s second half CLOSED -- reads the sealed digest
// `work-loop.ts` records on the engagement-ledger row at claim time, rather than reporting
// unresolvable for every event.
describe('buildEngagementLedgerDispatchContextPort (gap a, second half CLOSED, finding E35)', () => {
  const CHAIN_ID = 84532;
  const TASK_COORDINATOR = '0x3333333333333333333333333333333333333333' as const;
  const WIRING_ENTRY = {
    workKind: 'QmSolver',
    harness: 'claude-code',
    model: 'claude-haiku',
    plugins: [],
    credentialRef: 'cred-1',
    isolationPolicy: 'process',
  };

  async function realLedger() {
    const { EngagementLedger } = await import('../../src/daemon/engagement-ledger.js');
    return new EngagementLedger(new Store(':memory:'));
  }

  it('resolves the sealed descriptor for a task this operator claimed', async () => {
    const { buildEngagementLedgerDispatchContextPort } = await import('../../src/daemon/composition-root.js');
    const ledger = await realLedger();
    const idempotencyKey = `${CHAIN_ID}:${TASK_COORDINATOR}:1`;
    ledger.admitClaimIntent({
      idempotencyKey,
      chainId: CHAIN_ID,
      taskCoordinator: TASK_COORDINATOR,
      taskId: 1n,
      workKind: 'QmSolver',
      wiring: WIRING_ENTRY,
    });
    const digest = `sha256:${'7'.repeat(64)}` as const;
    ledger.recordClaimed(idempotencyKey, {
      attemptIndex: 0,
      attemptUri: 'urn:uuid:11111111-1111-4111-8111-111111111111',
      claimTxHash: '0xabc',
      dispatchContext: { digest, bytes: new TextEncoder().encode('{"fixture":true}') },
    });

    const resolveDispatchContext = buildEngagementLedgerDispatchContextPort(ledger);
    const resolved = await resolveDispatchContext({
      chainId: CHAIN_ID,
      taskCoordinator: TASK_COORDINATOR,
      taskId: 1n,
    });

    expect(resolved).toEqual({
      uri: 'urn:jinn:marketplace:dispatch-context:urn:uuid:11111111-1111-4111-8111-111111111111',
      digest: { sha256: '7'.repeat(64) },
    });
  });

  it('fails closed when this operator never claimed the task', async () => {
    const { buildEngagementLedgerDispatchContextPort } = await import('../../src/daemon/composition-root.js');
    const ledger = await realLedger();
    const resolveDispatchContext = buildEngagementLedgerDispatchContextPort(ledger);

    await expect(
      resolveDispatchContext({ chainId: CHAIN_ID, taskCoordinator: TASK_COORDINATOR, taskId: 999n }),
    ).resolves.toBeUndefined();
  });

  it('fails closed when the row predates the seal (admitted but never claimed)', async () => {
    const { buildEngagementLedgerDispatchContextPort } = await import('../../src/daemon/composition-root.js');
    const ledger = await realLedger();
    const idempotencyKey = `${CHAIN_ID}:${TASK_COORDINATOR}:2`;
    ledger.admitClaimIntent({
      idempotencyKey,
      chainId: CHAIN_ID,
      taskCoordinator: TASK_COORDINATOR,
      taskId: 2n,
      workKind: 'QmSolver',
      wiring: WIRING_ENTRY,
    });
    const resolveDispatchContext = buildEngagementLedgerDispatchContextPort(ledger);

    await expect(
      resolveDispatchContext({ chainId: CHAIN_ID, taskCoordinator: TASK_COORDINATOR, taskId: 2n }),
    ).resolves.toBeUndefined();
  });
});
