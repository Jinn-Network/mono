import { describe, expect, it } from 'vitest';
import { applicationVerdictProjectionCode } from '../../src/application-delivery/projection.js';
import { VerdictCode } from '../../src/adapters/mech/verdict-code.js';

describe('application verdict settlement projection', () => {
  const base = {
    schemaVersion: 'jinn-repo-application-payload.v1',
    application: { id: 'autopilot.issue-relay', version: 'v2' },
    role: 'verdict',
    payload: { creatorOwnedEvidence: true },
  };

  it.each([
    ['pass', VerdictCode.Pass],
    ['fail', VerdictCode.Fail],
    ['unresolved', VerdictCode.Unresolved],
  ] as const)('maps %s without inspecting application evidence', (projection, code) => {
    expect(applicationVerdictProjectionCode({ ...base, projection })).toBe(code);
  });

  it('rejects a malformed generic verdict rather than inventing Invalid', () => {
    expect(() => applicationVerdictProjectionCode(base)).toThrow();
    expect(applicationVerdictProjectionCode({ schemaVersion: 'other' })).toBeUndefined();
  });
});
