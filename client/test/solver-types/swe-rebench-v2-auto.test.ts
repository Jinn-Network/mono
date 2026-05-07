import { describe, it, expect } from 'vitest';
import { selectNextPostingCandidate, type GeneratorConfig } from '../../src/solver-types/swe-rebench-v2-auto.js';

const config: GeneratorConfig = {
  N_target_successes: 3,
  N_max_postings_per_task: 10,
  cooldown_ms: 24 * 60 * 60 * 1000,
};

describe('selectNextPostingCandidate', () => {
  const pool = [
    { instance_id: 'a', language: 'python' },
    { instance_id: 'b', language: 'go' },
    { instance_id: 'c', language: 'python' },
  ];

  it('skips saturated tasks (successful_count >= N_target_successes)', () => {
    const counters = new Map([
      ['a', { posted: 5, successful: 3, last_posted_at: 0 }],
      ['b', { posted: 0, successful: 0, last_posted_at: 0 }],
    ]);
    const next = selectNextPostingCandidate({ pool, counters, config, now: 1000 });
    expect(next?.instance_id).toBe('b');
  });

  it('skips tasks within cooldown window', () => {
    const now = 1_000_000;
    const counters = new Map([
      ['a', { posted: 1, successful: 0, last_posted_at: now - 1000 }],
      ['b', { posted: 0, successful: 0, last_posted_at: 0 }],
    ]);
    const next = selectNextPostingCandidate({ pool, counters, config, now });
    expect(next?.instance_id).toBe('b');
  });

  it('skips tasks at max-postings cap', () => {
    const counters = new Map([
      ['a', { posted: 10, successful: 0, last_posted_at: 0 }],
      ['b', { posted: 0, successful: 0, last_posted_at: 0 }],
    ]);
    const next = selectNextPostingCandidate({ pool, counters, config, now: 1_000_000_000 });
    expect(next?.instance_id).toBe('b');
  });

  it('returns undefined when all tasks are saturated or capped', () => {
    const counters = new Map([
      ['a', { posted: 10, successful: 3, last_posted_at: 0 }],
      ['b', { posted: 10, successful: 0, last_posted_at: 0 }],
      ['c', { posted: 10, successful: 3, last_posted_at: 0 }],
    ]);
    const next = selectNextPostingCandidate({ pool, counters, config, now: 1_000_000_000 });
    expect(next).toBeUndefined();
  });

  it('balances by language (round-robin) when multiple eligible', () => {
    const counters = new Map();
    counters.set('a', { posted: 1, successful: 0, last_posted_at: 1 });
    const next = selectNextPostingCandidate({
      pool, counters, config, now: 2 + config.cooldown_ms,
      lastPostedLanguage: 'python',
    });
    expect(next?.language).toBe('go');
  });
});
