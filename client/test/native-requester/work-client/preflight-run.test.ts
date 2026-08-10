import { describe, expect, it } from 'vitest';
import { RequesterError } from '../../../src/native-requester/work-client/errors.js';
import {
  POSTING_PREFLIGHT_CATEGORIES,
  PostingPreflightFailure,
  runPostingPreflight,
} from '../../../src/native-requester/work-client/preflight/run.js';

function checks(overrides: Partial<Record<string, () => Promise<void>>> = {}) {
  const ok = async () => {};
  return Object.fromEntries(
    POSTING_PREFLIGHT_CATEGORIES.map((category) => [category, overrides[category] ?? ok]),
  ) as Parameters<typeof runPostingPreflight>[0];
}

describe('runPostingPreflight', () => {
  it('runs every category in declared order and reports ok', async () => {
    const seen: string[] = [];
    const report = await runPostingPreflight(
      checks(
        Object.fromEntries(
          POSTING_PREFLIGHT_CATEGORIES.map((category) => [
            category,
            async () => { seen.push(category); },
          ]),
        ),
      ),
    );
    expect(seen).toEqual([...POSTING_PREFLIGHT_CATEGORIES]);
    expect(report.every((entry) => entry.status === 'ok')).toBe(true);
  });

  it('stops at the first failure and carries the partial report', async () => {
    const ran: string[] = [];
    const failing = checks({
      venue: async () => {
        throw new RequesterError('venue', 'chain-unreachable', 'rpc down');
      },
      target: async () => { ran.push('target'); },
    });
    await expect(runPostingPreflight(failing)).rejects.toBeInstanceOf(PostingPreflightFailure);
    expect(ran).toEqual([]);
    try {
      await runPostingPreflight(failing);
    } catch (err) {
      const failure = err as PostingPreflightFailure;
      expect(failure.category).toBe('venue');
      expect(failure.code).toBe('chain-unreachable');
      expect(failure.report.map((entry) => entry.status)).toEqual(['ok', 'ok', 'failed']);
    }
  });

  it('wraps a non-requester throw under its category', async () => {
    try {
      await runPostingPreflight(checks({ funds: async () => { throw new Error('boom'); } }));
    } catch (err) {
      const failure = err as PostingPreflightFailure;
      expect(failure.category).toBe('funds');
      expect(failure.code).toBe('check-threw');
      expect(failure.message).toContain('boom');
    }
  });
});
