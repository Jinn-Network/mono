import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: mocks.spawn,
}));

import { openBrowser } from '../../src/cli/open-browser.js';

describe('openBrowser', () => {
  beforeEach(() => {
    mocks.spawn.mockReset();
  });

  it('swallows async launcher errors from missing browser helpers', () => {
    const child = {
      on: vi.fn(),
      unref: vi.fn(),
    };
    mocks.spawn.mockReturnValue(child);

    openBrowser('http://127.0.0.1:7331/?k=test');

    expect(child.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(child.unref).toHaveBeenCalled();
    const handler = child.on.mock.calls.find(([event]) => event === 'error')?.[1];
    expect(() => handler?.(new Error('spawn xdg-open ENOENT'))).not.toThrow();
  });

  it('swallows synchronous spawn failures', () => {
    mocks.spawn.mockImplementation(() => {
      throw new Error('spawn failed');
    });

    expect(() => openBrowser('http://127.0.0.1:7331/?k=test')).not.toThrow();
  });
});
