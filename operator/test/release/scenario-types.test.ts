import { describe, it, expect } from 'vitest';
import { exitCodeForVerdicts } from '../../scripts/release/scenario-types.js';
import type { ScenarioVerdict, FailClass } from '../../scripts/release/scenario-types.js';

// Build a minimal verdict; `failClass` null ⇒ a pass/skip, set ⇒ a fail.
function v(failClass: FailClass | null, verdict: 'pass' | 'fail' | 'skip' = failClass ? 'fail' : 'pass'): ScenarioVerdict {
  return { scenarioId: 'X', verdict, wallClockMs: 1, evidencePath: '/dev/null', failClass, failNotes: failClass ? 'n' : null };
}

describe('exitCodeForVerdicts — the flake-mask-proof gate contract', () => {
  it('returns 0 when every scenario passed or was skipped', () => {
    expect(exitCodeForVerdicts([v(null, 'pass'), v(null, 'skip')])).toBe(0);
    expect(exitCodeForVerdicts([])).toBe(0);
  });

  it('returns 1 (product-red) for a classified real-bug', () => {
    expect(exitCodeForVerdicts([v(null, 'pass'), v('real-bug')])).toBe(1);
  });

  // The core of the fix: a timeout/connectivity/crash failure must NOT silently
  // pass (exit 0). It surfaces as 4 (infra-blocked) and blocks the gate.
  it.each<FailClass>(['flake-timing', 'flake-infra', 'agent-crash'])(
    'returns 4 (infra-blocked) for a %s failure — never a silent pass',
    (fc) => {
      expect(exitCodeForVerdicts([v(null, 'pass'), v(fc)])).toBe(4);
    },
  );

  it('lets real-bug dominate infra-blocked (the more severe signal wins)', () => {
    expect(exitCodeForVerdicts([v('flake-timing'), v('real-bug')])).toBe(1);
    expect(exitCodeForVerdicts([v('agent-crash'), v('real-bug'), v('flake-infra')])).toBe(1);
  });

  it('REGRESSION: a lone flake never exits 0 (the silent-mask we removed)', () => {
    expect(exitCodeForVerdicts([v('flake-timing')])).not.toBe(0);
    expect(exitCodeForVerdicts([v('flake-timing')])).toBe(4);
  });
});
