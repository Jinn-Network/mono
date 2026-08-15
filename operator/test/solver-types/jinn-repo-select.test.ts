import { describe, it, expect } from 'vitest';
import { selectCandidatePRs, type PrSummary } from '../../src/solver-types/jinn-repo-extract.js';

const prs: PrSummary[] = [
  { number: 1042, files: ['operator/src/adapters/mech/safe.ts', 'operator/test/adapters/mech/safe.nonce.test.ts'], closingIssues: [501] },
  { number: 1043, files: ['docs/readme.md'], closingIssues: [502] },            // no code/test
  { number: 1044, files: ['operator/src/x.ts', 'operator/test/x.test.ts'], closingIssues: [] }, // no linked issue
];

describe('selectCandidatePRs', () => {
  it('keeps PRs that touch operator/test/** AND have a linked issue', () => {
    expect(selectCandidatePRs(prs).map((p) => p.number)).toEqual([1042]);
  });
});
