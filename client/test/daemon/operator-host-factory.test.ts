import { describe, expect, it, vi } from 'vitest';

import { buildOperatorHost } from '../../src/daemon/operator-host-factory.js';

describe('mode-aware operator host factory', () => {
  it('constructs only the explicit legacy compatibility factory', async () => {
    const legacy = { start: vi.fn(), health: vi.fn(), close: vi.fn() };
    const buildLegacy = vi.fn(async () => legacy);
    const buildNative = vi.fn();
    await expect(buildOperatorHost({
      decision: { requestedMode: 'legacy', effectiveMode: 'legacy', readiness: 'explicit-legacy' },
      buildLegacy,
      buildNative,
    })).resolves.toBe(legacy);
    expect(buildLegacy).toHaveBeenCalledOnce();
    expect(buildNative).not.toHaveBeenCalled();
  });

  it('propagates native construction refusal without calling or falling back to legacy', async () => {
    const buildLegacy = vi.fn();
    const buildNative = vi.fn(async () => { throw new Error('missing trusted native source'); });
    await expect(buildOperatorHost({
      decision: { requestedMode: 'native-v1', effectiveMode: 'native-v1', readiness: 'live-closure-validated' },
      buildLegacy,
      buildNative,
    })).rejects.toThrow('missing trusted native source');
    expect(buildNative).toHaveBeenCalledOnce();
    expect(buildLegacy).not.toHaveBeenCalled();
  });
});
