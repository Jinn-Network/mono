import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadActiveHeldOutSlateIds,
  hashHeldOutSlateArtifact,
  HELD_OUT_SLATE_SCHEMA_VERSION,
} from '../../src/solver-types/_swe-rebench-v2-held-out-slate.js';

function writeSlate(dir: string, version: string, ids: string[]): void {
  const artifact = {
    schemaVersion: HELD_OUT_SLATE_SCHEMA_VERSION,
    solverType: 'swe-rebench-v2.v1',
    version,
    generatedAt: '2026-06-03T00:00:00.000Z',
    instanceIds: ids,
  };
  writeFileSync(
    join(dir, `held-out-slate.swe-rebench-v2.${version}.json`),
    JSON.stringify({ ...artifact, hash: hashHeldOutSlateArtifact(artifact) }),
  );
}

describe('loadActiveHeldOutSlateIds', () => {
  it('unions instance ids across all active slate versions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slates-'));
    try {
      writeSlate(dir, 'v1', ['o__a-1', 'o__b-1']);
      writeSlate(dir, 'v2', ['o__c-1', 'o__b-1']); // b-1 overlaps
      const ids = loadActiveHeldOutSlateIds('swe-rebench-v2.v1', ['v1', 'v2'], { dir });
      expect([...ids].sort()).toEqual(['o__a-1', 'o__b-1', 'o__c-1']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
