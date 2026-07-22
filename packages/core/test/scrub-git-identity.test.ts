import { describe, expect, it } from 'vitest';
import {
  buildLayer2ScrubPipeline,
  buildScrubPipeline,
  buildSeedScrubPipeline,
  DEFAULT_KEY_POLICY,
  gitIdentityDetector,
} from '../src/scrub/index.js';

describe('git-identity detector (#1970)', () => {
  it('emits B2 VERY_HIGH for Author / Committer / Co-Authored-By / Signed-off-by names', () => {
    const text = [
      'Author: Synth Operator <synth.operator@example.com>',
      'Committer: Other Person <other@example.com>',
      'Co-Authored-By: Helper Name <helper@example.com>',
      'Signed-off-by: Signer Name <signer@example.com>',
    ].join('\n');
    const findings = gitIdentityDetector(DEFAULT_KEY_POLICY).detect({ content: text });
    const names = findings
      .filter((f) => f.class === 'B2')
      .map((f) => text.slice(f.span.start, f.span.end));
    expect(names).toEqual(['Synth Operator', 'Other Person', 'Helper Name', 'Signer Name']);
    expect(findings.every((f) => f.confidence === 'VERY_HIGH')).toBe(true);
    expect(findings.every((f) => f.detector.name === 'git-identity')).toBe(true);
  });

  it('emits B2 for git config user.name / user.email values', () => {
    const text = [
      'git config user.name "Synth Operator"',
      "git config --global user.email 'synth.operator@example.com'",
      'user.name=Synth Operator',
      'user.email=synth.operator@example.com',
    ].join('\n');
    const findings = gitIdentityDetector(DEFAULT_KEY_POLICY).detect({ content: text });
    const values = findings.map((f) => text.slice(f.span.start, f.span.end));
    expect(values).toEqual([
      'Synth Operator',
      'synth.operator@example.com',
      'Synth Operator',
      'synth.operator@example.com',
    ]);
  });

  it('does not emit findings for prose names outside carriers', () => {
    const text =
      'Synth Operator reviewed the patch. The operator claims the flake is environmental.';
    const findings = gitIdentityDetector(DEFAULT_KEY_POLICY).detect({ content: text });
    expect(findings).toEqual([]);
  });

  it('redacts trailer names on every publish preset; leaves prose names intact', async () => {
    for (const pipeline of [
      buildSeedScrubPipeline(),
      buildLayer2ScrubPipeline(),
      buildScrubPipeline(),
    ]) {
      const carrier = await pipeline.run({
        content: 'Author: Synth Operator <synth.operator@example.com>',
      });
      const carrierOut = String(carrier.attributes.content);
      expect(carrierOut).not.toContain('Synth Operator');
      expect(carrierOut).toContain('[NAME]');
      expect(carrierOut).toContain('[EMAIL]');
      expect(carrier.redactions.some((r) => r.stage === 'git-identity')).toBe(true);

      const prose = await pipeline.run({
        content: 'Synth Operator reviewed the patch carefully.',
      });
      expect(String(prose.attributes.content)).toBe('Synth Operator reviewed the patch carefully.');
    }
  });
});
