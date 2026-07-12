/**
 * Corpus index + item builders (#1406).
 *
 * buildCorpusList: newest-first index of published capture envelopes, seeds
 * excluded by default, offset/limit pagination.
 * buildCorpusItem: one item's detail by CID, or null when unknown.
 */

import { describe, expect, it } from 'vitest';
import {
  buildCorpusList,
  buildCorpusItem,
  type CaptureEnvelopeMetaRow,
} from '../src/api/routes.js';

function meta(overrides: Partial<CaptureEnvelopeMetaRow> = {}): CaptureEnvelopeMetaRow {
  return {
    manifestCid: 'bafy-a',
    chainId: 84532,
    contributor: '0x1111111111111111111111111111111111111111',
    taskSummary: 'Fix failing vitest suite',
    tagsJson: JSON.stringify(['jinn-agent', 'testing']),
    provenance: 'contributed',
    verifiabilityTier: 'tests-passed',
    harness: 'jinn-agent 0.4.2',
    model: 'gpt-5.4-mini',
    toolsJson: JSON.stringify(['read', 'edit', 'bash']),
    stepCount: 6,
    anchorTx: '0x' + 'a'.repeat(64),
    createdAtTimestamp: 1000n,
    ...overrides,
  };
}

describe('buildCorpusList', () => {
  it('lists contributed envelopes newest-first with cluster from the first tag', () => {
    const rows = [
      meta({ manifestCid: 'bafy-old', createdAtTimestamp: 100n }),
      meta({ manifestCid: 'bafy-new', createdAtTimestamp: 300n }),
      meta({ manifestCid: 'bafy-mid', createdAtTimestamp: 200n }),
    ];
    const out = buildCorpusList(rows);
    expect(out.total).toBe(3);
    expect(out.items.map((i) => i.cid)).toEqual(['bafy-new', 'bafy-mid', 'bafy-old']);
    expect(out.items[0]!.cluster).toBe('jinn-agent');
    expect(out.items[0]!.tier).toBe('tests-passed');
    expect(out.items[0]!.createdAt).toBe(300);
  });

  it('excludes seeds by default and counts them', () => {
    const rows = [
      meta({ manifestCid: 'bafy-real', provenance: 'contributed' }),
      meta({ manifestCid: 'bafy-seed', provenance: 'imported' }),
    ];
    const out = buildCorpusList(rows);
    expect(out.total).toBe(1);
    expect(out.seedsExcluded).toBe(1);
    expect(out.includeSeeds).toBe(false);
    expect(out.items[0]!.cid).toBe('bafy-real');
  });

  it('folds seeds back in when includeSeeds is set', () => {
    const rows = [
      meta({ manifestCid: 'bafy-real', provenance: 'contributed', createdAtTimestamp: 200n }),
      meta({ manifestCid: 'bafy-seed', provenance: 'imported', createdAtTimestamp: 100n }),
    ];
    const out = buildCorpusList(rows, { includeSeeds: true });
    expect(out.total).toBe(2);
    expect(out.seedsExcluded).toBe(0);
    expect(out.includeSeeds).toBe(true);
  });

  it('paginates by offset + limit', () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      meta({ manifestCid: `bafy-${String(i).padStart(2, '0')}`, createdAtTimestamp: BigInt(1000 - i) }),
    );
    const page1 = buildCorpusList(rows, { limit: 10, offset: 0 });
    expect(page1.total).toBe(30);
    expect(page1.items).toHaveLength(10);
    expect(page1.items[0]!.cid).toBe('bafy-00'); // highest timestamp

    const page2 = buildCorpusList(rows, { limit: 10, offset: 10 });
    expect(page2.items).toHaveLength(10);
    expect(page2.items[0]!.cid).toBe('bafy-10');
    // pages don't overlap
    const p1ids = new Set(page1.items.map((i) => i.cid));
    expect(page2.items.every((i) => !p1ids.has(i.cid))).toBe(true);
  });

  it('sorts un-enriched (null timestamp) items last', () => {
    const rows = [
      meta({ manifestCid: 'bafy-null', createdAtTimestamp: 0n }), // 0 coerces to null
      meta({ manifestCid: 'bafy-ts', createdAtTimestamp: 50n }),
    ];
    const out = buildCorpusList(rows);
    expect(out.items.map((i) => i.cid)).toEqual(['bafy-ts', 'bafy-null']);
    expect(out.items[1]!.createdAt).toBeNull();
  });

  it('tolerates malformed tagsJson (cluster empty, item still listed)', () => {
    const out = buildCorpusList([meta({ tagsJson: 'not-json' })]);
    expect(out.total).toBe(1);
    expect(out.items[0]!.cluster).toBe('');
  });

  it('sorts the FULL corpus server-side so ordering holds across pages', () => {
    // 30 rows with stepCount 0..29; ascending stepCount sort must place the
    // smallest step counts on page 1 and the largest on the last page — a
    // global order that a page-local re-sort could not produce.
    const rows = Array.from({ length: 30 }, (_, i) =>
      meta({ manifestCid: `bafy-${String(i).padStart(2, '0')}`, stepCount: i }),
    );
    const page1 = buildCorpusList(rows, { sort: 'stepCount', dir: 'asc', limit: 10, offset: 0 });
    const page2 = buildCorpusList(rows, { sort: 'stepCount', dir: 'asc', limit: 10, offset: 10 });
    const page3 = buildCorpusList(rows, { sort: 'stepCount', dir: 'asc', limit: 10, offset: 20 });

    expect(page1.items.map((i) => i.stepCount)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(page2.items.map((i) => i.stepCount)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(page3.items.map((i) => i.stepCount)).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);

    // The globally-first row (smallest stepCount) is at the top of page 1, and
    // the globally-last row is at the bottom of page 3 — sort is not page-local.
    expect(page1.items[0]!.stepCount).toBe(0);
    expect(page3.items[9]!.stepCount).toBe(29);
  });

  it('reverses order for dir=desc', () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      meta({ manifestCid: `bafy-${i}`, stepCount: i }),
    );
    const asc = buildCorpusList(rows, { sort: 'stepCount', dir: 'asc' });
    const desc = buildCorpusList(rows, { sort: 'stepCount', dir: 'desc' });
    expect(asc.items.map((i) => i.stepCount)).toEqual([0, 1, 2, 3, 4]);
    expect(desc.items.map((i) => i.stepCount)).toEqual([4, 3, 2, 1, 0]);
  });

  it('sorts by cluster and tier alphabetically', () => {
    const rows = [
      meta({ manifestCid: 'bafy-c', tagsJson: JSON.stringify(['charlie']), verifiabilityTier: 'user-accepted' }),
      meta({ manifestCid: 'bafy-a', tagsJson: JSON.stringify(['alpha']), verifiabilityTier: 'evaluator-verified' }),
      meta({ manifestCid: 'bafy-b', tagsJson: JSON.stringify(['bravo']), verifiabilityTier: 'tests-passed' }),
    ];
    const byCluster = buildCorpusList(rows, { sort: 'cluster', dir: 'asc' });
    expect(byCluster.items.map((i) => i.cluster)).toEqual(['alpha', 'bravo', 'charlie']);
    const byTier = buildCorpusList(rows, { sort: 'tier', dir: 'asc' });
    expect(byTier.items.map((i) => i.tier)).toEqual([
      'evaluator-verified',
      'tests-passed',
      'user-accepted',
    ]);
  });

  it('keeps null-timestamp items last regardless of sort direction', () => {
    const rows = [
      meta({ manifestCid: 'bafy-null', createdAtTimestamp: 0n }), // 0 coerces to null
      meta({ manifestCid: 'bafy-lo', createdAtTimestamp: 50n }),
      meta({ manifestCid: 'bafy-hi', createdAtTimestamp: 500n }),
    ];
    const desc = buildCorpusList(rows, { sort: 'createdAt', dir: 'desc' });
    expect(desc.items.map((i) => i.cid)).toEqual(['bafy-hi', 'bafy-lo', 'bafy-null']);
    const asc = buildCorpusList(rows, { sort: 'createdAt', dir: 'asc' });
    // nulls stay last even when ascending flips the enriched order.
    expect(asc.items.map((i) => i.cid)).toEqual(['bafy-lo', 'bafy-hi', 'bafy-null']);
  });

  it('falls back to createdAt desc when sort is unknown', () => {
    const rows = [
      meta({ manifestCid: 'bafy-old', createdAtTimestamp: 100n }),
      meta({ manifestCid: 'bafy-new', createdAtTimestamp: 300n }),
    ];
    const out = buildCorpusList(rows, { sort: 'not-a-column' });
    expect(out.items.map((i) => i.cid)).toEqual(['bafy-new', 'bafy-old']);
  });

  it('filters to a single cluster (#1414)', () => {
    const rows = [
      meta({ manifestCid: 'bafy-a', tagsJson: JSON.stringify(['jinn-agent']) }),
      meta({ manifestCid: 'bafy-b', tagsJson: JSON.stringify(['codex-swe']) }),
      meta({ manifestCid: 'bafy-c', tagsJson: JSON.stringify(['jinn-agent']) }),
    ];
    const out = buildCorpusList(rows, { cluster: 'jinn-agent' });
    expect(out.items.map((i) => i.cid).sort()).toEqual(['bafy-a', 'bafy-c']);
    expect(out.items.every((i) => i.cluster === 'jinn-agent')).toBe(true);
  });

  it('total reflects the post-filter count (#1414)', () => {
    const rows = [
      meta({ manifestCid: 'bafy-a', tagsJson: JSON.stringify(['jinn-agent']) }),
      meta({ manifestCid: 'bafy-b', tagsJson: JSON.stringify(['codex-swe']) }),
      meta({ manifestCid: 'bafy-c', tagsJson: JSON.stringify(['jinn-agent']) }),
    ];
    const out = buildCorpusList(rows, { cluster: 'jinn-agent' });
    expect(out.total).toBe(2);
  });

  it('returns an empty list for a cluster with no items (#1414)', () => {
    const rows = [
      meta({ manifestCid: 'bafy-a', tagsJson: JSON.stringify(['jinn-agent']) }),
    ];
    const out = buildCorpusList(rows, { cluster: 'nonexistent' });
    expect(out.total).toBe(0);
    expect(out.items).toEqual([]);
  });

  it('matches clusters case-sensitively (#1414)', () => {
    const rows = [meta({ manifestCid: 'bafy-a', tagsJson: JSON.stringify(['Alpha']) })];
    const out = buildCorpusList(rows, { cluster: 'alpha' });
    expect(out.total).toBe(0);
  });

  it('leaves the list unchanged when no cluster is given (#1414)', () => {
    const rows = [
      meta({ manifestCid: 'bafy-old', tagsJson: JSON.stringify(['a']), createdAtTimestamp: 100n }),
      meta({ manifestCid: 'bafy-new', tagsJson: JSON.stringify(['b']), createdAtTimestamp: 300n }),
    ];
    const out = buildCorpusList(rows);
    expect(out.total).toBe(2);
    expect(out.items.map((i) => i.cid)).toEqual(['bafy-new', 'bafy-old']);
  });

  it('filters by cluster BEFORE pagination (#1414)', () => {
    // 30 in-cluster + 30 out-of-cluster; a page of 10 over the filtered set must
    // draw only in-cluster rows and total must be the filtered length (30).
    const inCluster = Array.from({ length: 30 }, (_, i) =>
      meta({ manifestCid: `in-${String(i).padStart(2, '0')}`, tagsJson: JSON.stringify(['wanted']), stepCount: i }),
    );
    const outCluster = Array.from({ length: 30 }, (_, i) =>
      meta({ manifestCid: `out-${String(i).padStart(2, '0')}`, tagsJson: JSON.stringify(['other']), stepCount: i }),
    );
    const out = buildCorpusList([...inCluster, ...outCluster], {
      cluster: 'wanted',
      sort: 'stepCount',
      dir: 'asc',
      limit: 10,
      offset: 0,
    });
    expect(out.total).toBe(30);
    expect(out.items).toHaveLength(10);
    expect(out.items.every((i) => i.cluster === 'wanted')).toBe(true);
  });

  it('keeps seedsExcluded a PRE-filter provenance stat (#1414)', () => {
    // A seed in cluster z + a contributed row NOT in z. Default includeSeeds:false
    // drops the seed (seedsExcluded 1), then the cluster:z filter drops the rest —
    // pinning the ordering provenance → cluster → count.
    const rows = [
      meta({ manifestCid: 'bafy-seed', provenance: 'imported', tagsJson: JSON.stringify(['z']) }),
      meta({ manifestCid: 'bafy-real', provenance: 'contributed', tagsJson: JSON.stringify(['other']) }),
    ];
    const out = buildCorpusList(rows, { cluster: 'z' });
    expect(out.total).toBe(0);
    expect(out.seedsExcluded).toBe(1);
  });
});

describe('buildCorpusItem', () => {
  it('returns the full detail for a known CID', () => {
    const rows = [meta({ manifestCid: 'bafy-target' })];
    const item = buildCorpusItem(rows, 'bafy-target');
    expect(item).not.toBeNull();
    expect(item!.cid).toBe('bafy-target');
    expect(item!.harness).toBe('jinn-agent 0.4.2');
    expect(item!.model).toBe('gpt-5.4-mini');
    expect(item!.tools).toEqual(['read', 'edit', 'bash']);
    expect(item!.stepCount).toBe(6);
    expect(item!.tags).toEqual(['jinn-agent', 'testing']);
    expect(item!.cluster).toBe('jinn-agent');
    expect(item!.anchorTx).toBe('0x' + 'a'.repeat(64));
    expect(item!.createdAt).toBe(1000);
  });

  it('returns null for an unknown CID', () => {
    expect(buildCorpusItem([meta()], 'bafy-does-not-exist')).toBeNull();
  });

  it('resolves a seed by direct CID (detail is a link target, not a signal reader)', () => {
    const rows = [meta({ manifestCid: 'bafy-seed', provenance: 'imported' })];
    const item = buildCorpusItem(rows, 'bafy-seed');
    expect(item).not.toBeNull();
    expect(item!.provenance).toBe('imported');
  });

  it('degrades gracefully on rows missing the #1406 detail columns', () => {
    // A row enriched before the #1406 schema extension: optional fields absent.
    const legacy: CaptureEnvelopeMetaRow = {
      manifestCid: 'bafy-legacy',
      chainId: 84532,
      contributor: '0x2222222222222222222222222222222222222222',
      taskSummary: 'legacy row',
      tagsJson: JSON.stringify(['cli']),
      provenance: 'contributed',
      verifiabilityTier: 'user-accepted',
    };
    const item = buildCorpusItem([legacy], 'bafy-legacy');
    expect(item).not.toBeNull();
    expect(item!.harness).toBe('');
    expect(item!.model).toBe('');
    expect(item!.tools).toEqual([]);
    expect(item!.stepCount).toBe(0);
    expect(item!.anchorTx).toBe('');
    expect(item!.createdAt).toBeNull();
  });
});
