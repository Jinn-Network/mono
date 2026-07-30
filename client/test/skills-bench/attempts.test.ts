import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendAttempt, loadAttempts, attemptKey, assertManifestCompatible,
  type BenchOutcome, type BenchManifest,
} from '../../src/skills-bench/attempts.js';

const outcome = (over: Partial<BenchOutcome> = {}): BenchOutcome => ({
  instanceId: 'fix-widget-0001', arm: 'baseline', repeat: 0,
  passed: true, unscorable: false, costUsd: 0.1, ...over,
});

describe('attempts log', () => {
  it('round-trips and resumes: later duplicate key wins, missing file is empty', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'att-')), 'attempts.jsonl');
    expect(await loadAttempts(file)).toEqual([]);
    await appendAttempt(file, outcome());
    await appendAttempt(file, outcome({ arm: 'tdd' }));
    await appendAttempt(file, outcome({ passed: false })); // rerun of first key
    const loaded = await loadAttempts(file);
    expect(loaded).toHaveLength(2);
    expect(loaded.find((o) => attemptKey(o) === 'fix-widget-0001|baseline|0')!.passed).toBe(false);
  });
});

describe('manifest guard', () => {
  const manifest: BenchManifest = {
    version: 'skills-bench-manifest.v1', slateSha256: 'abc', model: 'claude-sonnet-5',
    arms: [{ name: 'baseline', skillSha256: null }, { name: 'tdd', skillSha256: 'def' }],
  };

  it('writes on first run, accepts identical, rejects drift', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'mf-')), 'bench-manifest.json');
    await assertManifestCompatible(file, manifest);           // writes
    await assertManifestCompatible(file, manifest);           // identical → ok
    await expect(
      assertManifestCompatible(file, { ...manifest, model: 'claude-haiku-4-5-20251001' }),
    ).rejects.toThrow(/manifest mismatch/);
  });

  it('rejects a real manifest resuming a --out dir seeded by a dry run, and vice versa', async () => {
    const dryManifest: BenchManifest = { ...manifest, dryRun: true };

    // dry run wrote first → a later real run against the same --out dir must fail loud,
    // not silently resume synthesized outcomes as if they were real solves/grades.
    const dryFirst = join(await mkdtemp(join(tmpdir(), 'mf-dry-')), 'bench-manifest.json');
    await assertManifestCompatible(dryFirst, dryManifest);
    await expect(assertManifestCompatible(dryFirst, manifest)).rejects.toThrow(/manifest mismatch/);

    // real run wrote first → a later --dry-run against the same --out dir must also fail
    // loud, rather than silently mixing synthesized rows into a real attempts.jsonl.
    const realFirst = join(await mkdtemp(join(tmpdir(), 'mf-real-')), 'bench-manifest.json');
    await assertManifestCompatible(realFirst, manifest);
    await expect(assertManifestCompatible(realFirst, dryManifest)).rejects.toThrow(/manifest mismatch/);
  });
});
