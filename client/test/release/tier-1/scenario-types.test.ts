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

  // ── #1018: transient on-chain + RPC + harness-setup failures are infra, not
  // product. On run 26911246506 both env-suite reds were these, mis-graded as
  // real-bug (→ product-red exit 1) instead of flake-infra (→ infra-blocked
  // exit 4), which red-gated a clean SHA on tooling noise.
  it('#1018: classifies transient on-chain tx failures as flake-infra', () => {
    // failure 2 (tier-3) verbatim shape: jinn exit 50 + underpriced replacement.
    expect(classifyFailure(new Error(
      'jinn tasks submit exited 50. stderr:\nreplacement transaction underpriced\nNo TaskCreated event returned from router',
    ))).toBe('flake-infra');
    expect(classifyFailure(new Error('replacement transaction underpriced'))).toBe('flake-infra');
    expect(classifyFailure(new Error('replacement fee too low'))).toBe('flake-infra');
    expect(classifyFailure(new Error('nonce too low'))).toBe('flake-infra');
    expect(classifyFailure(new Error('nonce has already been used'))).toBe('flake-infra');
    expect(classifyFailure(new Error('already known'))).toBe('flake-infra');
  });

  it('#1018: classifies RPC 429/5xx transients as flake-infra', () => {
    expect(classifyFailure(new Error('Request failed with status 429'))).toBe('flake-infra');
    expect(classifyFailure(new Error('429 Too Many Requests'))).toBe('flake-infra');
    expect(classifyFailure(new Error('rate limit exceeded'))).toBe('flake-infra');
    expect(classifyFailure(new Error('503 Service Unavailable'))).toBe('flake-infra');
    expect(classifyFailure(new Error('502 Bad Gateway'))).toBe('flake-infra');
    expect(classifyFailure(new Error('504 Gateway Timeout'))).toBe('flake-infra');
  });

  it('#1018: classifies harness build/setup (yarn install missing) as flake-infra', () => {
    // failure 1 (tier-2) verbatim shape: `yarn compile` in contracts/ fails
    // because that workspace was never installed in the runner. The install-
    // missing signal is carried in the runChild error (stderr tail). Not product.
    expect(classifyFailure(new Error(
      "yarn compile failed with exit code 1\nUsage Error: Couldn't find the node_modules state file - running an install might help (findPackageLocation)",
    ))).toBe('flake-infra');
    expect(classifyFailure(new Error('running an install might help'))).toBe('flake-infra');
  });

  it('classifies Tier 3 evaluator readiness drift as flake-infra', () => {
    expect(classifyFailure(new Error(
      'Tier 3 evaluator harness readiness infra-blocked on op-a: swe-rebench-v2 evaluator not enabled',
    ))).toBe('flake-infra');
  });

  it('classifies warm-operator keystore password drift as flake-infra', () => {
    expect(classifyFailure(new Error(
      'daemon on port 7361 exited before its API became reachable. ' +
      'A keystore password was auto-generated for you. ' +
      'Existing mnemonic keystore could not be decrypted: Key derivation failed - possibly wrong passphrase',
    ))).toBe('flake-infra');
  });

  it('#1018: does NOT mask a real contracts compile error as flake-infra', () => {
    // A genuine solc/Hardhat compile error (no install-missing signal) must stay
    // real-bug — the precision guard so the build-setup pattern is not a blanket
    // "any compile failure is infra".
    expect(classifyFailure(new Error(
      "yarn compile failed with exit code 1\nCompilerError: Expected identifier but got '}'",
    ))).toBe('real-bug');
  });
});
