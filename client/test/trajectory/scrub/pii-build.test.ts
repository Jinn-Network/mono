import { describe, expect, test, vi, beforeEach } from 'vitest';

// Force the Transformers.js detector's model load to fail, so we exercise the
// fail-closed posture without downloading a real model.
const initMock = vi.fn();
vi.mock('../../../src/trajectory/scrub/transformers-detector.js', () => ({
  DEFAULT_NER_MODEL: 'Xenova/bert-base-NER',
  TransformersPiiDetector: class {
    init() {
      return initMock();
    }
    async detect() {
      return [];
    }
  },
}));

import { maybeBuildPiiDetector } from '../../../src/trajectory/scrub/pii-build.js';

describe('maybeBuildPiiDetector', () => {
  beforeEach(() => {
    initMock.mockReset();
  });

  test('returns undefined (no throw) when disabled, even if the model would fail', async () => {
    initMock.mockRejectedValue(new Error('model download failed'));
    await expect(maybeBuildPiiDetector({ enabled: false }, () => {})).resolves.toBeUndefined();
    // disabled means the detector is never even constructed/loaded
    expect(initMock).not.toHaveBeenCalled();
  });

  test('fails closed (throws) when explicitly enabled and the model fails to load', async () => {
    initMock.mockRejectedValue(new Error('model download failed'));
    await expect(maybeBuildPiiDetector({ enabled: true }, () => {})).rejects.toThrow(
      /model download failed/,
    );
  });

  test('returns the detector when enabled and the model loads', async () => {
    initMock.mockResolvedValue(undefined);
    const detector = await maybeBuildPiiDetector({ enabled: true }, () => {});
    expect(detector).toBeDefined();
    expect(initMock).toHaveBeenCalledOnce();
  });
});
