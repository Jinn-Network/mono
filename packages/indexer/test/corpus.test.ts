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
