import { describe, it, expect } from 'vitest';
import { discoverCases } from '../src/pressure-test/suite.js';

describe('discoverCases', () => {
  it('finds every scenario .md under the pressure-tests tree', () => {
    const cases = discoverCases();
    const skills = new Set(cases.map((c) => c.skill));
    expect(skills.has('superpowers:brainstorming')).toBe(true);
    expect(skills.has('superpowers:writing-plans')).toBe(true);
    expect(cases.length).toBeGreaterThanOrEqual(18); // 6 skills x 3
    for (const c of cases) expect(c.scenario.length).toBeGreaterThan(0);
  });
});
