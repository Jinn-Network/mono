import { describe, it, expect, vi } from 'vitest';
import { warnSessionsWithoutConsent } from '../src/main.js';

describe('#1649 boot warn', () => {
  it('warns when harvest.sources includes sessions but mineable consent is off', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warnSessionsWithoutConsent({
      harvest: { sources: ['sessions'] },
      mineableTraces: { consent: 'off' },
    } as any);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/sessions.*mineableTraces\.consent.*#1649/));
    warn.mockRestore();
  });

  it('does NOT warn when consent is retain_local', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warnSessionsWithoutConsent({
      harvest: { sources: ['sessions'] },
      mineableTraces: { consent: 'retain_local' },
    } as any);
    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/#1649/));
    warn.mockRestore();
  });
});
