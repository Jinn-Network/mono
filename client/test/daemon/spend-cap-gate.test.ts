import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gateClaimBySpendCap, _resetSpendCapGateMemoForTests } from '../../src/daemon/spend-cap-gate.js';

beforeEach(() => _resetSpendCapGateMemoForTests());

describe('gateClaimBySpendCap', () => {
  it('proceeds when spend is under the cap', () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    const r = gateClaimBySpendCap({ credentialId: 'anthropic:api-key', capUsd: 20, spentTodayUsd: 5, logger });
    expect(r.proceed).toBe(true);
  });

  it('skips and reports newlyPaused on the first over-budget call', () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    const r = gateClaimBySpendCap({ credentialId: 'anthropic:api-key', capUsd: 20, spentTodayUsd: 20, logger });
    expect(r).toMatchObject({ proceed: false, newlyPaused: true });
    expect((r as { reason: string }).reason).toContain('$20.00');
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('does not repeat newlyPaused or the warn log on subsequent skips', () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    gateClaimBySpendCap({ credentialId: 'anthropic:api-key', capUsd: 20, spentTodayUsd: 21, logger });
    const r = gateClaimBySpendCap({ credentialId: 'anthropic:api-key', capUsd: 20, spentTodayUsd: 22, logger });
    expect(r).toMatchObject({ proceed: false, newlyPaused: false });
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('logs resumption when spend drops back under the cap', () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    gateClaimBySpendCap({ credentialId: 'anthropic:api-key', capUsd: 20, spentTodayUsd: 25, logger });
    const r = gateClaimBySpendCap({ credentialId: 'anthropic:api-key', capUsd: 20, spentTodayUsd: 1, logger });
    expect(r.proceed).toBe(true);
    expect(logger.info).toHaveBeenCalledOnce();
  });

  it('tracks credentials independently', () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    gateClaimBySpendCap({ credentialId: 'anthropic:api-key', capUsd: 20, spentTodayUsd: 25, logger });
    const r = gateClaimBySpendCap({ credentialId: 'openai:api-key', capUsd: 20, spentTodayUsd: 1, logger });
    expect(r.proceed).toBe(true);
  });
});
