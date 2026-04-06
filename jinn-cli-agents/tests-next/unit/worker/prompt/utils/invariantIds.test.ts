/**
 * Unit Test: Mission Invariant ID Extraction
 * Module: worker/prompt/utils/invariantIds.ts
 * Priority: P1 (HIGH)
 *
 * Tests extractMissionInvariantIds() which parses blueprint JSON
 * and returns IDs with mission prefixes (JOB, GOAL, OUT, STRAT).
 */
import { describe, it, expect } from 'vitest';
import { extractMissionInvariantIds } from 'jinn-node/worker/prompt/utils/invariantIds.js';

describe('extractMissionInvariantIds', () => {
  it('returns empty array for undefined input', () => {
    expect(extractMissionInvariantIds(undefined)).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(extractMissionInvariantIds('')).toEqual([]);
  });

  it('returns empty array for invalid JSON', () => {
    expect(extractMissionInvariantIds('not json')).toEqual([]);
  });

  it('returns empty array when no invariants key', () => {
    expect(extractMissionInvariantIds(JSON.stringify({ name: 'test' }))).toEqual([]);
  });

  it('returns empty array when invariants is not an array', () => {
    expect(extractMissionInvariantIds(JSON.stringify({ invariants: 'not array' }))).toEqual([]);
  });

  it('extracts GOAL-prefixed IDs', () => {
    const blueprint = JSON.stringify({
      invariants: [
        { id: 'GOAL-CONTENT', type: 'BOOLEAN' },
        { id: 'GOAL-QUALITY', type: 'FLOOR' },
      ],
    });
    expect(extractMissionInvariantIds(blueprint)).toEqual(['GOAL-CONTENT', 'GOAL-QUALITY']);
  });

  it('extracts JOB-prefixed IDs', () => {
    const blueprint = JSON.stringify({
      invariants: [{ id: 'JOB-DELIVERY', type: 'BOOLEAN' }],
    });
    expect(extractMissionInvariantIds(blueprint)).toEqual(['JOB-DELIVERY']);
  });

  it('extracts OUT-prefixed IDs', () => {
    const blueprint = JSON.stringify({
      invariants: [{ id: 'OUT-FORMAT', type: 'BOOLEAN' }],
    });
    expect(extractMissionInvariantIds(blueprint)).toEqual(['OUT-FORMAT']);
  });

  it('extracts STRAT-prefixed IDs', () => {
    const blueprint = JSON.stringify({
      invariants: [{ id: 'STRAT-APPROACH', type: 'BOOLEAN' }],
    });
    expect(extractMissionInvariantIds(blueprint)).toEqual(['STRAT-APPROACH']);
  });

  it('filters out SYS and COORD prefixed IDs', () => {
    const blueprint = JSON.stringify({
      invariants: [
        { id: 'GOAL-MISSION', type: 'BOOLEAN' },
        { id: 'SYS-014', type: 'BOOLEAN' },
        { id: 'SYS-015', type: 'BOOLEAN' },
        { id: 'COORD-BRANCH-REVIEW', type: 'BOOLEAN' },
        { id: 'OUT-ACCURACY', type: 'FLOOR' },
      ],
    });
    expect(extractMissionInvariantIds(blueprint)).toEqual(['GOAL-MISSION', 'OUT-ACCURACY']);
  });

  it('handles invariants without id field', () => {
    const blueprint = JSON.stringify({
      invariants: [
        { id: 'GOAL-A', type: 'BOOLEAN' },
        { type: 'BOOLEAN' },  // no id
        { id: 'GOAL-B', type: 'FLOOR' },
      ],
    });
    expect(extractMissionInvariantIds(blueprint)).toEqual(['GOAL-A', 'GOAL-B']);
  });

  it('filters out unknown prefixes and empty IDs', () => {
    const blueprint = JSON.stringify({
      invariants: [
        { id: 'GOAL-X', type: 'BOOLEAN' },
        { id: 'UNKNOWN-PREFIX', type: 'BOOLEAN' },
        { id: 'JOB-Y', type: 'FLOOR' },
        { id: '', type: 'BOOLEAN' },
      ],
    });
    expect(extractMissionInvariantIds(blueprint)).toEqual(['GOAL-X', 'JOB-Y']);
  });
});
