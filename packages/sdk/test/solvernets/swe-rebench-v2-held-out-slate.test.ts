import { describe, it, expect } from 'vitest';
import {
  loadHeldOutSlate,
  hashHeldOutSlateArtifact,
  HELD_OUT_SLATE_V1,
} from '../../src/solvernets/swe-rebench-v2-held-out-slate.js';

describe('swe-rebench-v2 held-out slate (SDK)', () => {
  it('loads v1 with the expected instanceId set', () => {
    const slate = loadHeldOutSlate('v1');
    expect(slate.version).toBe('v1');
    expect(slate.instanceIds instanceof Set).toBe(true);
    expect([...slate.instanceIds].sort()).toEqual(
      [
        'ASPP__pelita-863',
        'ASPP__pelita-875',
        'AbsaOSS__generate-release-notes-207',
        'All-Hands-AI__OpenHands-11914',
        'BQSKit__bqskit-337',
        'BerriAI__litellm-14715',
        'BerriAI__litellm-15753',
        'BrianPugh__cyclopts-609',
        'carsdotcom__skelebot-280',
        'pandas-dev__pandas-60736',
      ].sort(),
    );
  });

  it('returns the content-addressed hash matching the embedded artifact', () => {
    const slate = loadHeldOutSlate('v1');
    expect(slate.hash).toBe(HELD_OUT_SLATE_V1.hash);
    expect(slate.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('fails loud when the embedded artifact is edited without re-deriving the hash', () => {
    // Tamper with a copy: add an instance without updating the declared hash.
    const tampered = {
      ...HELD_OUT_SLATE_V1,
      instanceIds: [...HELD_OUT_SLATE_V1.instanceIds, 'injected__instance-1'],
    };
    expect(() => loadHeldOutSlate('v1', tampered)).toThrow(/hash mismatch/i);
  });

  it('recomputes a stable hash over the canonical, sorted artifact', () => {
    // Reordering instanceIds must not change the hash (normalization sorts them).
    const reordered = {
      ...HELD_OUT_SLATE_V1,
      instanceIds: [...HELD_OUT_SLATE_V1.instanceIds].reverse(),
    };
    expect(hashHeldOutSlateArtifact(reordered)).toBe(HELD_OUT_SLATE_V1.hash);
  });

  it('throws for an unknown version', () => {
    expect(() => loadHeldOutSlate('v99')).toThrow(/not found|unknown/i);
  });
});
