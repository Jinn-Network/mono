/**
 * Per-credential AI-units claim gate — issue #815.
 *
 * The gate enforces both a 6h-block cap and a 7d-window cap; either
 * breach pauses claims for the credential. Dedupes log + event emission
 * to one per (credential, window, block-id) — further skips in the same
 * block stay silent. The gate is *pure* given its inputs; the daemon
 * threads in the store sums.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  gateClaimByAiUnits,
  _resetAiUnitsGateMemoForTests,
} from '../../src/daemon/ai-units-gate.js';

beforeEach(() => _resetAiUnitsGateMemoForTests());

describe('gateClaimByAiUnits — under-cap path', () => {
  it('proceeds when projected + block-sum + week-sum are all under cap', () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    const r = gateClaimByAiUnits({
      credentialId: 'anthropic:api-key',
      projectedUsdMicros: 5,
      usdMicrosThisBlock: 10,
      usdMicrosThisWeek: 100,
      capPerBlockUsdMicros: 100,
      capPerWeekUsdMicros: 2800,
      blockId: '2026-05-28T12:00:00.000Z',
      logger,
    });
    expect(r.proceed).toBe(true);
  });

  it('proceeds when projection is null (unknown) — fail-open with a warn log', () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    const r = gateClaimByAiUnits({
      credentialId: 'anthropic:api-key',
      projectedUsdMicros: null,
      usdMicrosThisBlock: 50,
      usdMicrosThisWeek: 200,
      capPerBlockUsdMicros: 100,
      capPerWeekUsdMicros: 2800,
      blockId: '2026-05-28T12:00:00.000Z',
      logger,
    });
    expect(r.proceed).toBe(true);
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});

describe('gateClaimByAiUnits — over-cap path', () => {
  it('skips when block sum + projection would exceed capPerBlockUsdMicros', () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    const r = gateClaimByAiUnits({
      credentialId: 'anthropic:api-key',
      projectedUsdMicros: 50,
      usdMicrosThisBlock: 60,
      usdMicrosThisWeek: 200,
      capPerBlockUsdMicros: 100,
      capPerWeekUsdMicros: 2800,
      blockId: '2026-05-28T12:00:00.000Z',
      logger,
    });
    expect(r.proceed).toBe(false);
    if (!r.proceed) {
      expect(r.window).toBe('block');
      expect(r.newlyPaused).toBe(true);
    }
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('skips when week sum + projection would exceed capPerWeekUsdMicros (block OK)', () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    const r = gateClaimByAiUnits({
      credentialId: 'anthropic:api-key',
      projectedUsdMicros: 50,
      usdMicrosThisBlock: 10,
      usdMicrosThisWeek: 2790,
      capPerBlockUsdMicros: 100,
      capPerWeekUsdMicros: 2800,
      blockId: '2026-05-28T12:00:00.000Z',
      logger,
    });
    expect(r.proceed).toBe(false);
    if (!r.proceed) {
      expect(r.window).toBe('week');
      expect(r.newlyPaused).toBe(true);
    }
  });

  it('does not re-emit newlyPaused or warn on subsequent skips in the same block', () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    const args = {
      credentialId: 'anthropic:api-key',
      projectedUsdMicros: 50,
      usdMicrosThisBlock: 60,
      usdMicrosThisWeek: 200,
      capPerBlockUsdMicros: 100,
      capPerWeekUsdMicros: 2800,
      blockId: '2026-05-28T12:00:00.000Z',
      logger,
    } as const;
    gateClaimByAiUnits(args);
    const r2 = gateClaimByAiUnits(args);
    expect(r2.proceed).toBe(false);
    if (!r2.proceed) expect(r2.newlyPaused).toBe(false);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('re-fires newlyPaused when the block-id rolls over', () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    gateClaimByAiUnits({
      credentialId: 'anthropic:api-key',
      projectedUsdMicros: 50,
      usdMicrosThisBlock: 60,
      usdMicrosThisWeek: 200,
      capPerBlockUsdMicros: 100,
      capPerWeekUsdMicros: 2800,
      blockId: '2026-05-28T12:00:00.000Z',
      logger,
    });
    // New block, over-cap again (simulated)
    const r2 = gateClaimByAiUnits({
      credentialId: 'anthropic:api-key',
      projectedUsdMicros: 50,
      usdMicrosThisBlock: 60,
      usdMicrosThisWeek: 200,
      capPerBlockUsdMicros: 100,
      capPerWeekUsdMicros: 2800,
      blockId: '2026-05-28T18:00:00.000Z',
      logger,
    });
    expect(r2.proceed).toBe(false);
    if (!r2.proceed) expect(r2.newlyPaused).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('does not re-emit newlyPaused after a restart in the same block — hydration path (finding 1)', () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    const blockId = '2026-05-28T12:00:00.000Z';

    // First daemon lifetime: over-cap encounter writes the persisted row.
    const r1 = gateClaimByAiUnits({
      credentialId: 'anthropic:api-key',
      projectedUsdMicros: 50,
      usdMicrosThisBlock: 60,
      usdMicrosThisWeek: 200,
      capPerBlockUsdMicros: 100,
      capPerWeekUsdMicros: 2800,
      blockId,
      logger,
    });
    expect(r1.proceed).toBe(false);
    if (!r1.proceed) expect(r1.newlyPaused).toBe(true);

    // Simulate a restart: the in-process memo is gone but the store row persists.
    _resetAiUnitsGateMemoForTests();
    const hasPersistedCapReached = vi.fn((window, bid) => {
      // Returns true for the exact (window, blockId) the daemon previously wrote.
      return window === 'block' && bid === blockId;
    });

    const r2 = gateClaimByAiUnits({
      credentialId: 'anthropic:api-key',
      projectedUsdMicros: 50,
      usdMicrosThisBlock: 60,
      usdMicrosThisWeek: 200,
      capPerBlockUsdMicros: 100,
      capPerWeekUsdMicros: 2800,
      blockId,
      logger,
      hasPersistedCapReached,
    });
    expect(r2.proceed).toBe(false);
    if (!r2.proceed) expect(r2.newlyPaused).toBe(false);
    expect(hasPersistedCapReached).toHaveBeenCalledWith('block', blockId);
    // The hydrated path stays silent — no warn log past the original.
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('still emits newlyPaused after a restart when no persisted row exists (block rolled)', () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    const blockId = '2026-05-28T12:00:00.000Z';
    gateClaimByAiUnits({
      credentialId: 'anthropic:api-key',
      projectedUsdMicros: 50,
      usdMicrosThisBlock: 60,
      usdMicrosThisWeek: 200,
      capPerBlockUsdMicros: 100,
      capPerWeekUsdMicros: 2800,
      blockId,
      logger,
    });
    _resetAiUnitsGateMemoForTests();
    // Block has rolled — store has no row for the *new* blockId.
    const newBlockId = '2026-05-28T18:00:00.000Z';
    const r2 = gateClaimByAiUnits({
      credentialId: 'anthropic:api-key',
      projectedUsdMicros: 50,
      usdMicrosThisBlock: 60,
      usdMicrosThisWeek: 200,
      capPerBlockUsdMicros: 100,
      capPerWeekUsdMicros: 2800,
      blockId: newBlockId,
      logger,
      hasPersistedCapReached: () => false,
    });
    expect(r2.proceed).toBe(false);
    if (!r2.proceed) expect(r2.newlyPaused).toBe(true);
  });

  it('tracks credentials independently — A paused does not pause B', () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    gateClaimByAiUnits({
      credentialId: 'anthropic:api-key',
      projectedUsdMicros: 50,
      usdMicrosThisBlock: 80,
      usdMicrosThisWeek: 200,
      capPerBlockUsdMicros: 100,
      capPerWeekUsdMicros: 2800,
      blockId: '2026-05-28T12:00:00.000Z',
      logger,
    });
    const r2 = gateClaimByAiUnits({
      credentialId: 'openai:api-key',
      projectedUsdMicros: 5,
      usdMicrosThisBlock: 0,
      usdMicrosThisWeek: 0,
      capPerBlockUsdMicros: 100,
      capPerWeekUsdMicros: 2800,
      blockId: '2026-05-28T12:00:00.000Z',
      logger,
    });
    expect(r2.proceed).toBe(true);
  });
});
