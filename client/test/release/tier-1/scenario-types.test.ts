import { describe, it, expect } from 'vitest';
import {
  ScenarioVerdictSchema,
  classifyFailure,
  type ScenarioVerdict,
  type FailClass,
} from '../../../scripts/release/scenario-types';

describe('ScenarioVerdictSchema', () => {
  it('parses a pass verdict', () => {
    const v: ScenarioVerdict = {
      scenarioId: 'T1.1',
      verdict: 'pass',
      wallClockMs: 5000,
      evidencePath: '/tmp/T1.1.log',
      failClass: null,
      failNotes: null,
    };
    expect(() => ScenarioVerdictSchema.parse(v)).not.toThrow();
  });

  it('parses a fail verdict with class + notes', () => {
    const v: ScenarioVerdict = {
      scenarioId: 'T1.2',
      verdict: 'fail',
      wallClockMs: 30000,
      evidencePath: '/tmp/T1.2.log',
      failClass: 'real-bug',
      failNotes: 'harness readiness returned malformed shape',
    };
    expect(() => ScenarioVerdictSchema.parse(v)).not.toThrow();
  });

  it('parses a skip verdict', () => {
    const v: ScenarioVerdict = {
      scenarioId: 'T1.3',
      verdict: 'skip',
      wallClockMs: 0,
      evidencePath: '',
      failClass: null,
      failNotes: 'indexer not available locally',
    };
    expect(() => ScenarioVerdictSchema.parse(v)).not.toThrow();
  });

  it('rejects fail without failClass', () => {
    const v = {
      scenarioId: 'T1.1',
      verdict: 'fail',
      wallClockMs: 5000,
      evidencePath: '/tmp/T1.1.log',
      failClass: null,
      failNotes: null,
    };
    expect(() => ScenarioVerdictSchema.parse(v)).toThrow();
  });
});

describe('classifyFailure', () => {
  it('classifies HTTP errors as flake-infra', () => {
    expect(classifyFailure(new Error('HTTP request failed'))).toBe('flake-infra');
    expect(classifyFailure(new Error('fetch failed: ECONNREFUSED'))).toBe('flake-infra');
    expect(classifyFailure(new Error('socket hang up'))).toBe('flake-infra');
  });

  it('classifies timeout patterns as flake-timing', () => {
    expect(classifyFailure(new Error('timed out after 30000ms'))).toBe('flake-timing');
    expect(classifyFailure(new Error('Timeout waiting for selector'))).toBe('flake-timing');
  });

  it('classifies assertion failures as real-bug', () => {
    expect(classifyFailure(new Error('expected 5 to equal 6'))).toBe('real-bug');
    expect(classifyFailure(new Error('AssertionError: arrays differ'))).toBe('real-bug');
  });

  it('classifies unknown errors as real-bug (conservative default)', () => {
    expect(classifyFailure(new Error('something unexpected'))).toBe('real-bug');
  });

  it('does not misclassify "network mismatch" bugs as flake-infra', () => {
    // Regression: a bare /network/i pattern over-matched genuine regressions
    // like a wrong-chain bug, letting the gate pass a real bug as infra flake.
    expect(
      classifyFailure(new Error('network mismatch (expected base-sepolia)')),
    ).toBe('real-bug');
    expect(
      classifyFailure(new Error('wrong network: got base, expected base-sepolia')),
    ).toBe('real-bug');
  });

  it('still classifies genuine connectivity failures as flake-infra', () => {
    expect(classifyFailure(new Error('network error: connection lost'))).toBe('flake-infra');
    expect(classifyFailure(new Error('getaddrinfo ENOTFOUND base.org'))).toBe('flake-infra');
  });
});
