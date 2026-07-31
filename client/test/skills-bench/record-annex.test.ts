import { describe, expect, it } from 'vitest';
import { resolveTreatmentArm } from '../../scripts/skills-bench/record-annex.js';
import type { BenchManifest } from '../../src/skills-bench/attempts.js';

function manifest(arms: BenchManifest['arms']): BenchManifest {
  return { version: 'skills-bench-manifest.v1', taskSetSha256: 'abc', half: 'feedback', model: 'claude-sonnet-5', arms };
}

describe('resolveTreatmentArm (final-review recommendation)', () => {
  it('resolves a named treatment arm to its name and skillSha256', () => {
    const m = manifest([{ name: 'baseline', skillSha256: null }, { name: 'tdd', skillSha256: 'deadbeef' }]);
    expect(resolveTreatmentArm(m, 'tdd', '/run/bench-manifest.json')).toEqual({ name: 'tdd', skillSha256: 'deadbeef' });
  });

  it('throws naming the available arms when the requested skill is absent', () => {
    const m = manifest([{ name: 'baseline', skillSha256: null }, { name: 'tdd', skillSha256: 'deadbeef' }]);
    expect(() => resolveTreatmentArm(m, 'grill-me', '/run/bench-manifest.json')).toThrow(
      /no treatment arm named 'grill-me'.*available arms: baseline, tdd/,
    );
  });

  it('refuses the baseline arm (skillSha256: null) even when the name matches exactly', () => {
    const m = manifest([{ name: 'baseline', skillSha256: null }, { name: 'tdd', skillSha256: 'deadbeef' }]);
    expect(() => resolveTreatmentArm(m, 'baseline', '/run/bench-manifest.json')).toThrow(
      /no treatment arm named 'baseline'/,
    );
  });

  it('includes the manifest path in the error message', () => {
    const m = manifest([{ name: 'baseline', skillSha256: null }]);
    expect(() => resolveTreatmentArm(m, 'tdd', '/run/dir/bench-manifest.json')).toThrow(
      /\/run\/dir\/bench-manifest\.json/,
    );
  });
});
