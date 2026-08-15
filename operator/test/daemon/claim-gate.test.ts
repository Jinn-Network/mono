import { describe, expect, it, vi } from 'vitest';
import { createProjectorCatchUpGate } from '../../src/daemon/claim-gate.js';

describe('projector catch-up claim gate', () => {
  it('stays closed until the projector reports catch-up', async () => {
    const answers = [false, false, true];
    const gate = createProjectorCatchUpGate({
      hasCaughtUp: async () => answers.shift() ?? true,
      pollIntervalMs: 1,
      sleep: async () => {},
    });
    expect(gate.isOpen()).toBe(false);
    await gate.waitUntilOpen();
    expect(gate.isOpen()).toBe(true);
    expect(answers).toEqual([]);
  });

  it('logs once when it opens', async () => {
    const info = vi.fn();
    const gate = createProjectorCatchUpGate({
      hasCaughtUp: async () => true,
      pollIntervalMs: 1,
      logger: { info },
      sleep: async () => {},
    });
    await gate.waitUntilOpen();
    await gate.waitUntilOpen();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]![0]).toContain('claim gate open');
  });

  it('returns without opening when the signal aborts', async () => {
    const controller = new AbortController();
    const gate = createProjectorCatchUpGate({
      hasCaughtUp: async () => {
        controller.abort();
        return false;
      },
      pollIntervalMs: 1,
      sleep: async () => {},
    });
    await gate.waitUntilOpen(controller.signal);
    expect(gate.isOpen()).toBe(false);
  });
});
