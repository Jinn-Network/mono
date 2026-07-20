import { describe, expect, test, vi, beforeEach } from 'vitest';

const initMock = vi.fn();

import { maybeBuildPiiDetector } from '../../../src/trajectory/scrub/pii-build.js';

const factory = {
  create() {
    return {
      init: initMock,
      async detect() {
        return [];
      },
    };
  },
};

describe('maybeBuildPiiDetector', () => {
  beforeEach(() => {
    initMock.mockReset();
  });

  test('returns undefined (no throw) when disabled, even if the model would fail', async () => {
    initMock.mockRejectedValue(new Error('model download failed'));
    await expect(
      maybeBuildPiiDetector({ enabled: false }, () => {}, factory),
    ).resolves.toBeUndefined();
    // disabled means the detector is never even constructed/loaded
    expect(initMock).not.toHaveBeenCalled();
  });

  // B1: failure altitude is publish-time, not boot-time. When enabled and the
  // model fails to load, construction does NOT throw (so the daemon's other
  // loops keep running) — instead a detector is returned that hard-throws on
  // every scrub call, so each affected publish aborts (fails closed). A loud
  // one-time boot warning is emitted so the degraded posture is visible.
  test('does not throw at construction when enabled and the model fails to load (boot survives)', async () => {
    initMock.mockRejectedValue(new Error('model download failed'));
    const logs: string[] = [];
    const detector = await maybeBuildPiiDetector(
      { enabled: true },
      (m) => logs.push(m),
      factory,
    );
    // construction resolved with a detector rather than throwing
    expect(detector).toBeDefined();
    // loud, visible boot warning naming the fail-closed posture
    expect(logs.join('\n')).toMatch(/ML PII detection is enabled but the model failed to load/);
    expect(logs.join('\n')).toMatch(/failing closed/i);
  });

  test('returned fail-closed detector hard-throws on every scrub call (per-publish abort)', async () => {
    initMock.mockRejectedValue(new Error('model download failed'));
    const detector = await maybeBuildPiiDetector(
      { enabled: true },
      () => {},
      factory,
    );
    // each detect() call rejects with a clear, non-silent error
    await expect(detector!.detect('any text')).rejects.toThrow(/failing closed/i);
    await expect(detector!.detect('more text')).rejects.toThrow(/NOT published/);
  });

  test('returns the real detector when enabled and the model loads', async () => {
    initMock.mockResolvedValue(undefined);
    const detector = await maybeBuildPiiDetector(
      { enabled: true },
      () => {},
      factory,
    );
    expect(detector).toBeDefined();
    expect(initMock).toHaveBeenCalledOnce();
  });
});
