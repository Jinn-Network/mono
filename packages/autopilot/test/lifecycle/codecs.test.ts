import { describe, expect, it } from 'vitest';
import {
  branchNameForIssue,
  decodeBranchClaimTrailers,
  decodeReviewClaimPayload,
  encodeBranchClaimTrailers,
  encodeReviewClaimPayload,
  formatAutomatedReviewMarker,
  parseAutomatedReviewMarker,
  reviewClaimRef,
} from '../../src/lifecycle/codecs.js';
import { gitOid, gitRefName, type BranchClaim } from '../../src/lifecycle/types.js';

const OID_A = gitOid('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

describe('lifecycle metadata codecs', () => {
  it('round-trips an implementation branch claim through strict trailers', () => {
    const claim = {
      kind: 'branch-claim' as const,
      protocolVersion: 2 as const,
      phase: 'implement' as const,
      issueNumber: 42,
      prNumber: 101,
      attempt: '11111111-1111-4111-8111-111111111111',
      runner: 'runner-eu-1',
      login: 'jinn-implementer',
      expectedHead: OID_A,
      targetBase: gitRefName('next'),
      claimedAt: '2026-07-20T10:00:00.000Z',
      phaseComplete: true as const,
    };

    expect(decodeBranchClaimTrailers(encodeBranchClaimTrailers(claim))).toEqual(claim);
  });

  it('round-trips review claims and rejects contradictory terminal verdicts', () => {
    const record = {
      kind: 'review-claim' as const,
      protocolVersion: 2 as const,
      prNumber: 101,
      generation: '22222222-2222-4222-8222-222222222222',
      attempt: '33333333-3333-4333-8333-333333333333',
      reviewer: 'jinn-reviewer',
      head: OID_A,
      state: 'terminal-approved' as const,
      recordedAt: '2026-07-20T10:05:00.000Z',
      verdict: {
        marker: '44444444-4444-4444-8444-444444444444',
        state: 'APPROVE' as const,
      },
    };

    expect(decodeReviewClaimPayload(encodeReviewClaimPayload(record))).toEqual(record);
    expect(() => decodeReviewClaimPayload(JSON.stringify({
      ...record,
      verdict: { ...record.verdict, state: 'REQUEST_CHANGES' },
    }))).toThrow(/terminal-approved.*APPROVE/);
  });

  it('rejects malformed protocol values instead of coercing them', () => {
    expect(() => gitOid('ABC')).toThrow(/Git OID/);
    expect(() => gitRefName('refs/heads/a..b')).toThrow(/Git ref name/);
    expect(() => decodeBranchClaimTrailers(
      encodeBranchClaimTrailers({
        kind: 'branch-claim',
        protocolVersion: 2,
        phase: 'implement',
        issueNumber: 42,
        attempt: '11111111-1111-4111-8111-111111111111',
        runner: 'runner',
        login: 'login',
        expectedHead: OID_A,
        targetBase: gitRefName('next'),
        claimedAt: '2026-07-20T10:00:00.000Z',
      }).replace('Jinn-Autopilot-Protocol: 2', 'Jinn-Autopilot-Protocol: 1'),
    )).toThrow(/protocol version/);
    expect(() => decodeReviewClaimPayload(JSON.stringify({
      protocolVersion: 2,
      prNumber: 101,
      generation: '22222222-2222-4222-8222-222222222222',
      attempt: '33333333-3333-4333-8333-333333333333',
      reviewer: 'reviewer',
      head: OID_A,
      state: 'released',
      recordedAt: '2026-07-20T10:05:00.000Z',
    }))).toThrow(/state/);
  });

  it('rejects string PR numbers in review claim JSON', () => {
    expect(() => decodeReviewClaimPayload(JSON.stringify({
      protocolVersion: 2,
      prNumber: '101',
      generation: '22222222-2222-4222-8222-222222222222',
      attempt: '33333333-3333-4333-8333-333333333333',
      reviewer: 'reviewer',
      head: OID_A,
      state: 'active',
      recordedAt: '2026-07-20T10:05:00.000Z',
    }))).toThrow(/PR number/);
  });

  it('strictly validates branch claim objects before encoding', () => {
    const claim: BranchClaim = {
      kind: 'branch-claim',
      protocolVersion: 2,
      phase: 'implement',
      issueNumber: 42,
      attempt: '11111111-1111-4111-8111-111111111111',
      runner: 'runner',
      login: 'login',
      expectedHead: OID_A,
      targetBase: gitRefName('next'),
      claimedAt: '2026-07-20T10:00:00.000Z',
    };

    expect(() => encodeBranchClaimTrailers({
      ...claim,
      kind: 'other',
    } as unknown as BranchClaim)).toThrow(/kind/);
    expect(() => encodeBranchClaimTrailers({
      ...claim,
      unexpected: true,
    } as unknown as BranchClaim)).toThrow(/Unknown field/);
  });

  it('requires numeric positive integer issue and PR values when encoding branch claims', () => {
    const claim: BranchClaim = {
      kind: 'branch-claim',
      protocolVersion: 2,
      phase: 'implement',
      issueNumber: 42,
      prNumber: 101,
      attempt: '11111111-1111-4111-8111-111111111111',
      runner: 'runner',
      login: 'login',
      expectedHead: OID_A,
      targetBase: gitRefName('next'),
      claimedAt: '2026-07-20T10:00:00.000Z',
    };

    expect(() => encodeBranchClaimTrailers({
      ...claim,
      issueNumber: '42',
    } as unknown as BranchClaim)).toThrow(/issue number/);
    expect(() => encodeBranchClaimTrailers({
      ...claim,
      prNumber: '101',
    } as unknown as BranchClaim)).toThrow(/PR number/);
  });

  it('derives stable refs and round-trips the automated review marker', () => {
    expect(branchNameForIssue(42)).toBe('autopilot/42');
    expect(reviewClaimRef(101)).toBe('refs/jinn-autopilot/review-claims/v1/101');

    const marker = formatAutomatedReviewMarker({
      generation: '22222222-2222-4222-8222-222222222222',
      attempt: '33333333-3333-4333-8333-333333333333',
      head: OID_A,
      verdict: 'REQUEST_CHANGES',
    });
    expect(marker).toBe(
      '<!-- jinn-autopilot-review:v2 generation=22222222-2222-4222-8222-222222222222 '
      + 'attempt=33333333-3333-4333-8333-333333333333 '
      + 'head=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa verdict=REQUEST_CHANGES -->',
    );
    expect(parseAutomatedReviewMarker(marker)).toEqual({
      generation: '22222222-2222-4222-8222-222222222222',
      attempt: '33333333-3333-4333-8333-333333333333',
      head: OID_A,
      verdict: 'REQUEST_CHANGES',
    });
    expect(() => parseAutomatedReviewMarker(`${marker} trailing`)).toThrow(/review marker/);
  });
});
