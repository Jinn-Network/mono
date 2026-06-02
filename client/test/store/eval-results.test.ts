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

describe('getEvalSlateHashes (slate-content drift detection)', () => {
  it('returns the distinct slate_hash values recorded for a (checkpoint, version)', () => {
    const store = newStore();
    try {
      store.recordEvalResult({ ...base, slate_hash: 'sha256:content-A', instance_id: 'a-1', passed: true, unscorable: false });
      store.recordEvalResult({ ...base, slate_hash: 'sha256:content-A', instance_id: 'b-2', passed: false, unscorable: false });
      expect(store.getEvalSlateHashes('cid-child', 'v1')).toEqual(['sha256:content-A']);
    } finally {
      store.close();
    }
  });

  it('surfaces MULTIPLE distinct hashes when the slate content drifted under one version label', () => {
    const store = newStore();
    try {
      // Two instances recorded under the SAME version 'v1' but DIFFERENT content
      // hashes — exactly the version-bump-skipped drift the schema comment says
      // slate_hash exists to make detectable.
      // Insert B before A to prove the query returns them sorted (ORDER BY slate_hash),
      // not in insertion order.
      store.recordEvalResult({ ...base, slate_hash: 'sha256:content-B', instance_id: 'b-2', passed: false, unscorable: false });
      store.recordEvalResult({ ...base, slate_hash: 'sha256:content-A', instance_id: 'a-1', passed: true, unscorable: false });
      expect(store.getEvalSlateHashes('cid-child', 'v1')).toEqual([
        'sha256:content-A',
        'sha256:content-B',
      ]);
    } finally {
      store.close();
    }
  });

  it('returns an empty array when the checkpoint has no rows for the version', () => {
    const store = newStore();
    try {
      expect(store.getEvalSlateHashes('cid-parent', 'v1')).toEqual([]);
    } finally {
      store.close();
    }
  });
});
