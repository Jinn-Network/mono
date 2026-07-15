import { describe, it, expect } from 'vitest';
import {
  parseBackfillArgs,
  planBackfillCapabilities,
} from '../../scripts/backfill-derived-trajectories.js';

describe('parseBackfillArgs', () => {
  it('defaults to local-only, no publish, no indexer, no json', () => {
    const args = parseBackfillArgs(['node', 'script']);
    expect(args).toMatchObject({ publish: false, indexer: false, json: false });
    expect(args.db).toBeUndefined();
    expect(args.limit).toBeUndefined();
  });

  it('maps --publish, --indexer, --json, --db, --limit', () => {
    const args = parseBackfillArgs([
      'node',
      'script',
      '--publish',
      '--indexer',
      '--json',
      '--db',
      './x.db',
      '--limit',
      '5',
    ]);
    expect(args).toMatchObject({
      publish: true,
      indexer: true,
      json: true,
      db: './x.db',
      limit: 5,
    });
  });

  it('rejects an unknown flag', () => {
    expect(() => parseBackfillArgs(['node', 'script', '--nope'])).toThrow(/Unknown flag/);
  });

  it('rejects a non-numeric --limit', () => {
    expect(() => parseBackfillArgs(['node', 'script', '--limit', 'abc'])).toThrow(/--limit/);
  });
});

describe('planBackfillCapabilities', () => {
  it('default build is local-only (no publish, no indexer)', () => {
    const plan = planBackfillCapabilities(parseBackfillArgs(['node', 'script']));
    expect(plan).toEqual({ indexer: false, publish: false });
  });

  it('enables indexer and publish when requested', () => {
    const plan = planBackfillCapabilities(
      parseBackfillArgs(['node', 'script', '--indexer', '--publish']),
    );
    expect(plan).toEqual({ indexer: true, publish: true });
  });
});
