/**
 * Composition root (cutover stage 1, Task 12) tests. `buildClaimPredicate` is pure and tested
 * directly; `buildOperatorComposition` is exercised end to end against a real
 * `LocalTaskExecutionBackend` + real evidence runtime + real trust-resolve/pipeline wiring, with
 * only `createBaseVenue` (chain I/O) and `openOperatorEvidence` (kept but hermetic — see below)
 * stubbed via `vi.mock`.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CLAIM_NOTHING } from '@jinn-network/marketplace-pipeline';

const { createBaseVenueMock, safeExecuteMock, venueCloseMock } = vi.hoisted(() => ({
  createBaseVenueMock: vi.fn(),
  safeExecuteMock: vi.fn(async () => ({ txHash: '0xaa' as const })),
  venueCloseMock: vi.fn(),
}));

vi.mock('@jinn-network/marketplace-venue-base', () => ({
  createBaseVenue: createBaseVenueMock,
}));

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
    const { getVenueBroadcaster, clearVenueBroadcaster } = await import(
      '../../src/adapters/mech/safe.js'
    );
    clearVenueBroadcaster();

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

    const composition = await buildOperatorComposition({
      config: config as never,
      publicClient: {} as never,
      walletClient: { account: { address: safeAddress } } as never,
      safeAddress,
      mechAddress,
      chain: chain as never,
      stateRoot,
      evidenceRoot,
      venueStateDbPath: join(stateRoot, 'venue.db'),
      profileStore: { get: () => undefined },
    });

    // (a) the broadcaster is installed before the function returns.
    const installed = getVenueBroadcaster();
    expect(installed).toBeDefined();
    expect(installed!.safeAddress).toBe(safeAddress);
    await installed!.execute({ to: '0x00', value: 0n, data: '0x', logicalTx: 'x' });
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

    // (e) close() closes the evidence runtime.
    await composition.close();
    expect(evidenceCloseMock).toHaveBeenCalledTimes(1);
    expect(venueCloseMock).toHaveBeenCalledTimes(1);
    expect(getVenueBroadcaster()).toBeUndefined();
  });
});
