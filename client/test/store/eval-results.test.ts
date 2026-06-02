import { describe, expect, it } from 'vitest';
import { Store } from '@/store/store.js';

function newStore(): Store {
  return new Store(':memory:');
}

const base = {
  checkpoint_cid: 'cid-child',
  slate_hash: 'sha256:abc',
  slate_version: 'v1',
  code_digest: 'sha256:dig',
  run_at_ms: 1000,
};

describe('eval_results store', () => {
  it('records per-task results and aggregates scorable pass/fail', () => {
    const store = newStore();
    try {
      store.recordEvalResult({ ...base, instance_id: 'a-1', passed: true, unscorable: false, test_log_excerpt: 'ok' });
      store.recordEvalResult({ ...base, instance_id: 'b-2', passed: false, unscorable: false, test_log_excerpt: 'fail' });

      const agg = store.getEvalAggregate('cid-child', 'v1');
      expect(agg).toEqual({ passed: 1, scorable: 2, unscorable: 0 });

      const rows = store.getEvalResults('cid-child', 'v1');
      expect(rows.map((r) => r.instance_id)).toEqual(['a-1', 'b-2']);
      expect(rows[0]?.passed).toBe(true);
      expect(rows[1]?.passed).toBe(false);
    } finally {
      store.close();
    }
  });

  it('upserts on (checkpoint_cid, slate_version, instance_id)', () => {
    const store = newStore();
    try {
      store.recordEvalResult({ ...base, instance_id: 'a-1', passed: false, unscorable: false });
      store.recordEvalResult({ ...base, instance_id: 'a-1', passed: true, unscorable: false });
      const agg = store.getEvalAggregate('cid-child', 'v1');
      expect(agg).toEqual({ passed: 1, scorable: 1, unscorable: 0 });
    } finally {
      store.close();
    }
  });

  it('excludes unscorable rows from the denominator and never counts them as a fail', () => {
    const store = newStore();
    try {
      store.recordEvalResult({ ...base, instance_id: 'a-1', passed: true, unscorable: false });
      store.recordEvalResult({ ...base, instance_id: 'b-2', passed: false, unscorable: false });
      store.recordEvalResult({ ...base, instance_id: 'c-3', passed: null, unscorable: true, test_log_excerpt: 'docker down' });

      const agg = store.getEvalAggregate('cid-child', 'v1');
      expect(agg).toEqual({ passed: 1, scorable: 2, unscorable: 1 });
    } finally {
      store.close();
    }
  });

  it('returns a zero aggregate when the parent has no rows for the slate version', () => {
    const store = newStore();
    try {
      const agg = store.getEvalAggregate('cid-parent', 'v1');
      expect(agg).toEqual({ passed: 0, scorable: 0, unscorable: 0 });
    } finally {
      store.close();
    }
  });
});
