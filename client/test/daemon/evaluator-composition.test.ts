import { describe, it, expect, vi } from 'vitest';
import { LOOP_REGISTRY } from '../../src/daemon/loop-heartbeat.js';
import { minimalRuntimeConfig } from '../_support/evaluation-fixtures.js';

const { createBaseVenueMock, safeExecuteMock, venueCloseMock } = vi.hoisted(() => ({
  createBaseVenueMock: vi.fn(),
  safeExecuteMock: vi.fn(async () => ({ txHash: '0xaa' as const })),
  venueCloseMock: vi.fn(),
}));

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

function stubVenue() {
  return {
    claim: { taskDigest: 'stub' },
    settlement: { pin: vi.fn(), verifySettlementGrade: vi.fn() },
    lifecycle: {},
    finality: {},
    deliveryWait: {},
    release: {},
    observe: {},
    verdict: {
      canOpenVerdictAttempt: vi.fn(async () => ({ ok: true as const })),
      openVerdictAttempt: vi.fn(),
      deliverVerdictToMarketplace: vi.fn(),
      claimVerdictDelivery: vi.fn(),
    },
    safe: { safeAddress: '0xSafe', execute: safeExecuteMock, classify: vi.fn() },
    logSource: { close: vi.fn(), orphanedBlockHashes: () => new Set() },
    intents: {},
    close: venueCloseMock,
  };
}

describe('evaluator composition', () => {
  it('registers the evaluator loop in the watchdog registry', () => {
    expect(LOOP_REGISTRY.map((entry) => entry.name)).toContain('evaluator');
    expect(LOOP_REGISTRY.map((entry) => entry.name)).not.toContain('delivery-watcher');
  });

  it('starts no evaluator loop when the operator has not enabled evaluation', async () => {
    const { buildOperatorRuntime } = await import('../../src/daemon/composition-root.js');
    createBaseVenueMock.mockReset().mockImplementation(() => stubVenue());
    openOperatorEvidenceMock.mockReset().mockResolvedValue({
      runtime: {},
      ports: { repository: {}, catalog: {}, awaitIndexed: vi.fn() },
      close: evidenceCloseMock,
    });

    const runtime = await buildOperatorRuntime(minimalRuntimeConfig({ evaluator: { enabled: false } }));
    expect(runtime.loops.map((loop) => loop.name)).not.toContain('evaluator');
  });

  it('fails boot loudly when evaluation is enabled but the trust policy will not assemble', async () => {
    const { buildOperatorRuntime } = await import('../../src/daemon/composition-root.js');
    createBaseVenueMock.mockReset().mockImplementation(() => stubVenue());
    openOperatorEvidenceMock.mockReset().mockResolvedValue({
      runtime: {},
      ports: { repository: {}, catalog: {}, awaitIndexed: vi.fn() },
      close: evidenceCloseMock,
    });

    await expect(buildOperatorRuntime(minimalRuntimeConfig({
      evaluator: { enabled: true, trustPolicy: { genesisDigest: `sha256:${'0'.repeat(64)}`, versionsDir: '/nonexistent' } },
    }))).rejects.toThrow(/trust policy/);
  });

  it('keeps emitting evaluation_submitted so the dashboard history survives the delivery-watcher deletion', async () => {
    const { buildOperatorRuntime } = await import('../../src/daemon/composition-root.js');
    createBaseVenueMock.mockReset().mockImplementation(() => stubVenue());
    openOperatorEvidenceMock.mockReset().mockResolvedValue({
      runtime: {},
      ports: { repository: {}, catalog: {}, awaitIndexed: vi.fn() },
      close: evidenceCloseMock,
    });

    const runtime = await buildOperatorRuntime(minimalRuntimeConfig({ evaluator: { enabled: true } }));
    expect(runtime.eventKinds).toContain('evaluation_submitted');
  });
});
