import { describe, expect, it } from 'vitest';
import type { Finding } from '../src/scrub/finding.js';
import {
  DEFAULT_POLICY,
  POLICY_VERSION,
  checkModeRejects,
  resolveDisposition,
} from '../src/scrub/policy.js';

function finding(partial: Partial<Finding> & Pick<Finding, 'class' | 'confidence'>): Finding {
  return {
    span: { key: 'content', start: 0, end: 1 },
    evidence: ['test'],
    detector: { name: 'test', version: '0' },
    ...partial,
  };
}

describe('scrub policy table (#1969)', () => {
  it('is a versioned artifact', () => {
    expect(POLICY_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(DEFAULT_POLICY.version).toBe(POLICY_VERSION);
  });

  it('dispositions follow §3.2 defaults at high confidence', () => {
    expect(resolveDisposition('A1', 'HIGH', DEFAULT_POLICY)).toBe('redact');
    expect(resolveDisposition('A2', 'VERY_HIGH', DEFAULT_POLICY)).toBe('redact');
    expect(resolveDisposition('A2', 'MEDIUM', DEFAULT_POLICY)).toBe('flag');
    expect(resolveDisposition('A4', 'HIGH', DEFAULT_POLICY)).toBe('reject-publish');
    expect(resolveDisposition('A5', 'HIGH', DEFAULT_POLICY)).toBe('reject-publish');
    expect(resolveDisposition('B1', 'HIGH', DEFAULT_POLICY)).toBe('redact');
    expect(resolveDisposition('C1', 'HIGH', DEFAULT_POLICY)).toBe('redact');
    expect(resolveDisposition('D1', 'VERY_HIGH', DEFAULT_POLICY)).toBe('redact');
  });

  it('leaves C2 as pass until the flag review surface exists (Q4 deferred)', () => {
    expect(resolveDisposition('C2', 'HIGH', DEFAULT_POLICY)).toBe('pass');
    expect(resolveDisposition('C2', 'VERY_HIGH', DEFAULT_POLICY)).toBe('pass');
  });

  it('check-mode maps any non-pass disposition to reject (one mapping line)', () => {
    expect(checkModeRejects([finding({ class: 'B1', confidence: 'HIGH' })], DEFAULT_POLICY)).toBe(
      true,
    );
    expect(checkModeRejects([finding({ class: 'A4', confidence: 'HIGH' })], DEFAULT_POLICY)).toBe(
      true,
    );
    expect(checkModeRejects([finding({ class: 'A2', confidence: 'MEDIUM' })], DEFAULT_POLICY)).toBe(
      true,
    );
    expect(checkModeRejects([finding({ class: 'C2', confidence: 'HIGH' })], DEFAULT_POLICY)).toBe(
      false,
    );
    expect(checkModeRejects([], DEFAULT_POLICY)).toBe(false);
  });
});
