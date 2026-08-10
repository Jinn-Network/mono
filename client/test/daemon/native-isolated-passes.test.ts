/**
 * #2533, pass-level isolation. The evaluator's requester and solver syncs ran sequentially and
 * unguarded, so a requester-side throw skipped the solver sync entirely — live, 802 consecutive
 * aborted ticks in which operator A ingested none of operator B's records.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  runIsolatedIngest,
  runIsolatedItems,
  runIsolatedPasses,
} from '../../src/daemon/native-isolated-passes.js';

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

/**
 * #2539, item-level isolation. Per-source isolation stopped a requester failure taking out the
 * solver sync; it did not stop ONE card taking out every card behind it in its own pass. Live,
 * requester card 2 refused on the digest-keyed collision and cards 3+ were never reached — on
 * every tick, because nothing acknowledges a card that failed to index, so the queue is re-walked
 * from the front and the same wall is hit again.
 */
describe('runIsolatedItems', () => {
  it('indexes every sibling item when one in the middle fails', () => {
    const indexed: string[] = [];

    const failures = runIsolatedItems(['card-1', 'card-2', 'card-3'], {
      label: 'native-evaluator/requester',
      name: (card) => `announcement ${card}`,
      warn: vi.fn(),
      run: (card) => {
        if (card === 'card-2') throw new Error('changed signed provenance');
        indexed.push(card);
      },
    });

    // The whole point: card 3 was reached.
    expect(indexed).toStrictEqual(['card-1', 'card-3']);
    expect(failures).toHaveLength(1);
    expect((failures[0] as Error).message).toBe('changed signed provenance');
  });

  it('returns every failure, in order, rather than only the first', () => {
    const failures = runIsolatedItems(['a', 'b'], {
      label: 'native-evaluator/solver',
      name: (item) => item,
      warn: vi.fn(),
      run: (item) => { throw new Error(item); },
    });

    expect(failures.map((cause) => (cause as Error).message)).toStrictEqual(['a', 'b']);
  });

  // Isolation, not suppression: the failing item and its cause both have to be in the log.
  it('logs the failing item and the cause', () => {
    const warn = vi.fn();

    runIsolatedItems(['card-2'], {
      label: 'native-evaluator/requester',
      name: (card) => `announcement ${card}`,
      warn,
      run: () => { throw new Error('changed signed provenance'); },
    });

    const message = warn.mock.calls[0]![0] as string;
    expect(message).toContain('[native-evaluator/requester]');
    expect(message).toContain('announcement card-2');
    expect(message).toContain('changed signed provenance');
  });

  it('returns no failures and logs nothing when every item indexes', () => {
    const warn = vi.fn();
    expect(runIsolatedItems(['a', 'b'], {
      label: 'native-evaluator/solver', name: (i) => i, warn, run: () => undefined,
    })).toStrictEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});

/**
 * #2539, ingest isolation. `read()` aborted on any sync failure, so the evaluator's source
 * checkpoint stayed pinned at sequence 3 while material it had ALREADY verified sat unread behind
 * the refusal. Intake and read are separable: a read derived from a durable, verified index is not
 * invalidated by a failure to take in something new.
 */
describe('runIsolatedIngest', () => {
  it('runs every step and resolves even when one fails, so the read still happens', async () => {
    const ran: string[] = [];

    const failures = await runIsolatedIngest([
      { name: 'signed-source ingest', run: async () => { ran.push('sources'); throw new Error('source refused'); } },
      { name: 'canonical venue sync', run: async () => { ran.push('venue'); } },
    ], { label: 'native-evaluator', report: vi.fn() });

    expect(ran).toStrictEqual(['sources', 'venue']);
    expect(failures.map((cause) => (cause as Error).message)).toStrictEqual(['source refused']);
  });

  it('reports the failing step and the cause at error level', async () => {
    const report = vi.fn();

    await runIsolatedIngest(
      [{ name: 'signed-source ingest', run: async () => { throw new Error('source refused'); } }],
      { label: 'native-evaluator', report },
    );

    const message = report.mock.calls[0]![0] as string;
    expect(message).toContain('[native-evaluator]');
    expect(message).toContain('signed-source ingest');
    expect(message).toContain('reading the verified index as it stands');
    expect(message).toContain('source refused');
  });

  it('reports nothing when every step succeeds', async () => {
    const report = vi.fn();
    await expect(runIsolatedIngest([
      { name: 'signed-source ingest', run: async () => undefined },
    ], { label: 'native-evaluator', report })).resolves.toStrictEqual([]);
    expect(report).not.toHaveBeenCalled();
  });
});
