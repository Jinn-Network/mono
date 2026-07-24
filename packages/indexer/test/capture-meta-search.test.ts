/**
 * Capture-meta search route logic (#1344).
 *
 * The consume path's content-aware fast path: substring match over the
 * IPFS-enriched capture metadata (tags + task summary), so `corpus search
 * "tdd"` can find a seed tagged `tdd` without any artifact fetch.
 */

import { describe, expect, it } from 'vitest';
import {
  searchCaptureMeta,
  type CaptureEnvelopeMetaRow,
} from '../src/api/routes.js';

function meta(overrides: Partial<CaptureEnvelopeMetaRow> = {}): CaptureEnvelopeMetaRow {
  return {
    manifestCid: 'bafy-a',
    chainId: 84532,
    contributor: '0x1111111111111111111111111111111111111111',
    taskSummary: 'Fix failing vitest suite',
    tagsJson: JSON.stringify(['typescript', 'testing']),
    provenance: 'contributed',
    verifiabilityTier: 'tests-passed',
    ...overrides,
  };
}

describe('searchCaptureMeta', () => {
  const rows = [
    meta(),
    meta({
      manifestCid: 'bafy-seed-tdd',
      taskSummary: 'Seed import: obra/superpowers/skills/test-driven-development',
      tagsJson: JSON.stringify(['seed-import', 'superpowers', 'test-driven-development', 'tdd']),
      provenance: 'imported',
    }),
    meta({ manifestCid: 'bafy-b', taskSummary: 'Refactor auth flow', tagsJson: JSON.stringify(['auth']) }),
  ];

  it('matches on tags — a seed tagged tdd is findable', () => {
    const hits = searchCaptureMeta(rows, 'tdd');
    expect(hits.map((h) => h.manifestCid)).toEqual(['bafy-seed-tdd']);
  });

  it('matches on task summary, case-insensitive', () => {
    const hits = searchCaptureMeta(rows, 'VITEST');
    expect(hits.map((h) => h.manifestCid)).toEqual(['bafy-a']);
  });

  it('empty query returns everything up to the limit', () => {
    expect(searchCaptureMeta(rows, '')).toHaveLength(3);
    expect(searchCaptureMeta(rows, '', { limit: 2 })).toHaveLength(2);
  });

  it('no match returns empty, never throws on malformed tagsJson', () => {
    expect(searchCaptureMeta([meta({ tagsJson: 'not json' })], 'tdd')).toEqual([]);
  });

  it('returns rows with parsed tags for the caller', () => {
    const hits = searchCaptureMeta(rows, 'test-driven');
    expect(hits[0]!.tags).toContain('test-driven-development');
    expect(hits[0]!.provenance).toBe('imported');
  });

  it('returns named repository, synthesis, and retrieval visibility metadata', () => {
    const [hit] = searchCaptureMeta([meta({
      repositorySlug: 'Jinn-Network/mono',
      synthesis: 'The focused test now passes.',
      retrievalVisible: false,
    })], 'vitest');

    expect(hit).toMatchObject({
      repositorySlug: 'Jinn-Network/mono',
      synthesis: 'The focused test now passes.',
      retrievalVisible: false,
    });
  });

  it('leaves named metadata absent for legacy rows', () => {
    const [hit] = searchCaptureMeta([meta()], 'vitest');

    expect(hit).not.toHaveProperty('repositorySlug');
    expect(hit).not.toHaveProperty('synthesis');
    expect(hit).not.toHaveProperty('retrievalVisible');
  });
});
