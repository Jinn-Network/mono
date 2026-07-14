import { describe, expect, it } from 'vitest';
import { buildCaptureScrubPipeline } from '../../src/trajectory/scrub/build.js';
import { evaluateLookupTripwire } from '../../src/solver-types/_swe-rebench-v2-lookup-tripwire.js';
import { computeHaltedMintFamilies } from '../../src/solver-types/_swe-rebench-v2-guards.js';

describe('mineable trace scrub gate', () => {
  it('drops jinn.mineable.* without tier-1 consent', async () => {
    const pipeline = buildCaptureScrubPipeline({ mineableTraceConsent: 'off' });
    const result = await pipeline.run({
      'jinn.mineable.diff': '+fix',
      'jinn.task.id': 't1',
    });
    expect(result.attributes['jinn.mineable.diff']).toBeUndefined();
    expect(result.attributes['jinn.task.id']).toBe('t1');
  });

  it('retains jinn.mineable.* with tier-1 consent', async () => {
    const pipeline = buildCaptureScrubPipeline({ mineableTraceConsent: 'retain_local' });
    const result = await pipeline.run({
      'jinn.mineable.diff': '+fix',
    });
    expect(result.attributes['jinn.mineable.diff']).toBe('+fix');
  });
});

describe('lookup tripwire', () => {
  it('flags fast solve and identical patch', () => {
    const r = evaluateLookupTripwire({
      solveDurationMs: 100,
      deliveredPatch: 'same',
      upstreamPatch: 'same',
    });
    expect(r.flagged).toBe(true);
    expect(r.reasons.length).toBeGreaterThan(1);
  });
});

describe('informative band halt', () => {
  it('halts family outside band after 5 attempts', () => {
    const halted = computeHaltedMintFamilies([
      { family: 'echo', posted: 5, successful: 5 },
    ]);
    expect(halted.has('echo')).toBe(true);
  });
});
