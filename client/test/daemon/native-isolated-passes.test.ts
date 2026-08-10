/**
 * #2533, pass-level isolation. The evaluator's requester and solver syncs ran sequentially and
 * unguarded, so a requester-side throw skipped the solver sync entirely — live, 802 consecutive
 * aborted ticks in which operator A ingested none of operator B's records.
 */
import { describe, expect, it, vi } from 'vitest';
import { runIsolatedPasses } from '../../src/daemon/native-isolated-passes.js';

describe('runIsolatedPasses', () => {
  it('runs every sibling pass when one fails', async () => {
    const ran: string[] = [];
    const warn = vi.fn();

    await expect(runIsolatedPasses([
      { name: 'requester', run: async () => { ran.push('requester'); throw new Error('changed signed facts'); } },
      { name: 'solver', run: async () => { ran.push('solver'); } },
    ], { label: 'native-evaluator', warn })).rejects.toThrow('changed signed facts');

    // The whole point: the sibling still ran.
    expect(ran).toStrictEqual(['requester', 'solver']);
  });

  it('runs the requester pass when the solver pass fails', async () => {
    const ran: string[] = [];

    await expect(runIsolatedPasses([
      { name: 'requester', run: async () => { ran.push('requester'); } },
      { name: 'solver', run: async () => { ran.push('solver'); throw new Error('solver boom'); } },
    ], { label: 'native-evaluator', warn: vi.fn() })).rejects.toThrow('solver boom');

    expect(ran).toStrictEqual(['requester', 'solver']);
  });

  // Isolation, not suppression — the caller must still see a failing sync.
  it('rethrows the first failure after every pass has had its turn', async () => {
    await expect(runIsolatedPasses([
      { name: 'requester', run: async () => { throw new Error('first'); } },
      { name: 'solver', run: async () => { throw new Error('second'); } },
    ], { label: 'native-evaluator', warn: vi.fn() })).rejects.toThrow('first');
  });

  it('resolves when every pass succeeds', async () => {
    const ran: string[] = [];

    await expect(runIsolatedPasses([
      { name: 'requester', run: async () => { ran.push('requester'); } },
      { name: 'solver', run: async () => { ran.push('solver'); } },
    ], { label: 'native-evaluator', warn: vi.fn() })).resolves.toBeUndefined();

    expect(ran).toStrictEqual(['requester', 'solver']);
  });

  // The cause was invisible on the live run; a silent isolation would be a worse bug than the one
  // it replaces, so the log line must name the source AND the cause.
  it('logs the failing source and the cause', async () => {
    const warn = vi.fn();

    await expect(runIsolatedPasses([
      { name: 'requester', run: async () => { throw new Error('changed signed facts'); } },
      { name: 'solver', run: async () => {} },
    ], { label: 'native-evaluator', warn })).rejects.toThrow();

    expect(warn).toHaveBeenCalledOnce();
    const message = warn.mock.calls[0]![0] as string;
    expect(message).toContain('[native-evaluator]');
    expect(message).toContain('requester source sync failed');
    expect(message).toContain('solver still ran this pass');
    expect(message).toContain('changed signed facts');
  });

  it('stringifies a non-Error cause rather than dropping it', async () => {
    const warn = vi.fn();

    await expect(runIsolatedPasses(
      [{ name: 'requester', run: async () => { throw 'bare string'; } }],
      { label: 'native-evaluator', warn },
    )).rejects.toBe('bare string');

    expect(warn.mock.calls[0]![0] as string).toContain('bare string');
  });
});
