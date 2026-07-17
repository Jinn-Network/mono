import { describe, expect, it } from 'vitest';
import {
  HAND_MARK_POLICY,
  resolveRetrievalMark,
  type AdmissionFacts,
  type AdmissionPolicy,
} from '../src/admission-policy.js';

describe('AdmissionPolicy (#1824)', () => {
  describe('HAND_MARK_POLICY (hand.v0, the day-one policy)', () => {
    it('is named hand.v0', () => {
      expect(HAND_MARK_POLICY.name).toBe('hand.v0');
    });

    it('admits nothing, unconditionally', () => {
      const shapes: AdmissionFacts[] = [
        {},
        { verdict: 'passed', evidenceTier: 'attested', capturedAt: '2026-07-17T00:00:00.000Z' },
        { verdict: 'failed' },
        { verdict: 'unknown', tags: [] },
        { tags: ['dashboard', 'vitest'], provenance: 'contributed' },
      ];
      for (const facts of shapes) {
        expect(HAND_MARK_POLICY.admit(facts)).toBe(false);
      }
    });
  });

  describe('resolveRetrievalMark chokepoint', () => {
    const facts: AdmissionFacts = { verdict: 'passed', evidenceTier: 'committed' };

    it('explicit hand-mark wins regardless of policy', () => {
      expect(resolveRetrievalMark({ explicit: true, facts, policy: HAND_MARK_POLICY })).toBe(true);
    });

    it('no auto-admission under the day-one policy when explicit is false', () => {
      expect(resolveRetrievalMark({ explicit: false, facts, policy: HAND_MARK_POLICY })).toBe(false);
    });

    it('explicit omitted behaves like false — no accidental opt-in', () => {
      expect(resolveRetrievalMark({ facts, policy: HAND_MARK_POLICY })).toBe(false);
    });

    it('a fact-based policy admits through the same chokepoint — the hook is pluggable', () => {
      const testPolicy: AdmissionPolicy = {
        name: 'test.passed-only',
        admit: (f) => f.verdict === 'passed',
      };
      expect(resolveRetrievalMark({ explicit: false, facts, policy: testPolicy })).toBe(true);
      expect(
        resolveRetrievalMark({ explicit: false, facts: { verdict: 'failed' }, policy: testPolicy }),
      ).toBe(false);
    });
  });
});
