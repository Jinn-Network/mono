import { describe, expect, it } from 'vitest';
import { NATIVE_EVALUATOR_ACTIVITY_LEGS } from './native-evaluator-activity-legs.js';

describe('native-evaluator activity leg table (#3346)', () => {
  it('labels LEG 8/9 as deploy-time seeded and cites the ingestion-leg spec', () => {
    const spec = 'spec/2026-09-26-native-evaluator-ingestion-legs-deploy-time.md';
    const eight = NATIVE_EVALUATOR_ACTIVITY_LEGS.find(([leg]) => leg.startsWith('LEG 8'));
    const nine = NATIVE_EVALUATOR_ACTIVITY_LEGS.find(([leg]) => leg.startsWith('LEG 9'));
    expect(eight?.[1]).toContain('SEEDED');
    expect(eight?.[1]).toContain(spec);
    expect(nine?.[1]).toContain('SEEDED');
    expect(nine?.[1]).toContain(spec);
  });
});
