import { describe, it, expect } from 'vitest';
import { buildLayer2ScrubPipeline } from '../../../src/trajectory/scrub/layer2.js';

describe('buildLayer2ScrubPipeline', () => {
  it('preserves ordinary prose (the #1409 defacement class)', async () => {
    const p = buildLayer2ScrubPipeline();
    // The literal words #1409 reported being mangled by the trace-grade pipeline.
    const prose =
      'Use this skill before you start. It clarifies user intent and requirements ' +
      'so you can brainstorm the design and explore the problem space.';
    const { attributes } = await p.run({ 'skill.md': prose });
    expect(attributes['skill.md']).toBe(prose); // byte-for-byte, no placeholder tokens
  });

  it('preserves public SWE-rebench instance ids in short bridge summaries', async () => {
    const p = buildLayer2ScrubPipeline();
    const summary = 'swe-rebench jlowin__fastmcp-3235: SWE-rebench v2: short regression summary';
    const { attributes, redactions } = await p.run({ 'task.summary': summary });

    expect(attributes['task.summary']).toBe(summary);
    expect(redactions).toEqual([]);
  });

  it('still redacts a genuine secret (fail-closed net intact)', async () => {
    const p = buildLayer2ScrubPipeline();
    const withKey =
      'export AWS_SECRET=AKIAIOSFODNN7EXAMPLE and a token wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const { attributes, redactions } = await p.run({ 'skill.md': withKey });
    expect(redactions.length).toBeGreaterThan(0);
    expect(String(attributes['skill.md'])).not.toContain('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
  });

  it('drops the structural drop-tier keys (auth headers, env dumps)', async () => {
    const p = buildLayer2ScrubPipeline();
    const { attributes } = await p.run({ 'env.SECRET': 'x', 'skill.md': 'hello' });
    expect(attributes['env.SECRET']).toBeUndefined();
    expect(attributes['skill.md']).toBe('hello');
  });
});
