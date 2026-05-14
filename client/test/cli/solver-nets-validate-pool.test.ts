import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The CLI handler dispatches through ctx.argv. These tests exercise a thin
// wrapper that resolves the instance-id input flags into a string[] — wired
// into the subverb. The unit-under-test is `resolveValidatePoolInstanceIds`
// in client/src/cli/commands/solver-nets.ts.
import { resolveValidatePoolInstanceIds } from '../../src/cli/commands/solver-nets.js';

describe('resolveValidatePoolInstanceIds', () => {
  it('returns repeated --instance-id values in order', () => {
    const ids = resolveValidatePoolInstanceIds({ instanceId: ['a__1', 'a__2'] });
    expect(ids).toEqual(['a__1', 'a__2']);
  });

  it('reads --instances-file (newline-delimited, ignores blanks and # comments)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'validate-pool-cli-'));
    const path = join(dir, 'ids.txt');
    writeFileSync(path, '# comment\na__1\n\na__2\n  a__3  \n');
    const ids = resolveValidatePoolInstanceIds({ instancesFile: path });
    expect(ids).toEqual(['a__1', 'a__2', 'a__3']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads --seed-positive from client/scripts/swe-rebench-v2-seed-pool.json', () => {
    const ids = resolveValidatePoolInstanceIds({ seedPositive: true });
    expect(ids.length).toBeGreaterThan(0);
    expect(ids[0]).toMatch(/__/); // instance IDs look like `org__repo-NNNN`
  });

  it('reads --known-bad from client/scripts/swe-rebench-v2-known-bad.json', () => {
    const ids = resolveValidatePoolInstanceIds({ knownBad: true });
    expect(ids).toContain('basicmachines-co__basic-memory-341');
    expect(ids).toContain('beeware__briefcase-2114');
  });

  it('concatenates and de-duplicates across flags', () => {
    const ids = resolveValidatePoolInstanceIds({
      instanceId: ['basicmachines-co__basic-memory-341'],
      knownBad: true,
    });
    expect(ids.filter((id) => id === 'basicmachines-co__basic-memory-341')).toHaveLength(1);
  });
});
