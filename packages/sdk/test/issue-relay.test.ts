import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  IssueRelayAdoptionReceiptV1Schema,
  IssueRelayEvaluationAnchorV1Schema,
  IssueRelayEvaluationContextV1Schema,
  IssueRelayVerdictV1Schema,
  IssueRelayRoundV1Schema,
} from '../src/issue-relay.js';

const digest = `sha256:${'a'.repeat(64)}`;
const oid = '1'.repeat(40);
const fixtureDirectory = fileURLToPath(new URL('../fixtures/autopilot/', import.meta.url));

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(`${fixtureDirectory}${name}.json`, 'utf8')) as unknown;
}

const initialRound = {
  schemaVersion: 'jinn-issue-relay-round.v1' as const,
  generation: 'R_kgDOExample:42:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  round: 0,
  snapshotDigest: digest,
  targetRepository: 'Jinn-Network/mono',
  workspaceRepository: 'Jinn-Network/mono',
  inputHead: oid,
  purpose: 'initial' as const,
  findings: [],
};

describe('IssueRelayRoundV1Schema', () => {
  it('accepts an initial round', () => {
    expect(IssueRelayRoundV1Schema.parse(initialRound)).toMatchObject({
      round: 0,
      purpose: 'initial',
    });
  });

  it('rejects a PR number on an initial round', () => {
    expect(IssueRelayRoundV1Schema.safeParse({
      ...initialRound,
      prNumber: 42,
    }).success).toBe(false);
  });

  it('requires a PR number and finding on repair rounds', () => {
    const repair = {
      ...initialRound,
      purpose: 'repair' as const,
      findings: [{ code: 'test-failure', title: 'Test fails', detail: 'The test fails.' }],
      prNumber: 42,
    };
    expect(IssueRelayRoundV1Schema.safeParse(repair).success).toBe(true);
    expect(IssueRelayRoundV1Schema.safeParse({
      ...repair,
      prNumber: undefined,
    }).success).toBe(false);
    expect(IssueRelayRoundV1Schema.safeParse({
      ...repair,
      findings: [],
    }).success).toBe(false);
  });

  it.each([
    ['digest', { snapshotDigest: `sha256:${'A'.repeat(64)}` }],
    ['Git OID', { inputHead: 'a'.repeat(39) }],
    ['repository', { targetRepository: 'owner/repo.git' }],
    ['repository byte limit', { targetRepository: `${'a'.repeat(100)}/${'b'.repeat(100)}` }],
    ['finding title byte limit', { findings: [{ code: 'x', title: 'é'.repeat(121), detail: 'd' }] }],
    ['finding detail byte limit', { findings: [{ code: 'x', title: 't', detail: 'é'.repeat(4097) }] }],
    ['unknown field', { unexpected: true }],
  ])('fails closed on an invalid %s', (_label, mutation) => {
    expect(IssueRelayRoundV1Schema.safeParse({
      ...initialRound,
      ...mutation,
    }).success).toBe(false);
  });
});

const correlation = {
  generation: initialRound.generation,
  round: 1,
  snapshotDigest: digest,
  taskId: 'task-42',
  attemptIndex: 0,
  requestId: 'request-42',
  deliveryEnvelopeCid: 'bafyrelay42',
};

const repairRound = {
  ...initialRound,
  round: 1,
  purpose: 'repair' as const,
  prNumber: 42,
  findings: [{ code: 'test-failure', title: 'Test fails', detail: 'The test fails.' }],
};

const acceptedReceipt = {
  schemaVersion: 'jinn-issue-relay-adoption.v1' as const,
  disposition: 'accepted' as const,
  correlation,
  targetRepository: 'Jinn-Network/mono',
  workspaceRepository: 'Jinn-Network/mono',
  issueNumber: 1889,
  prNumber: 42,
  headRef: 'relay/1889',
  inputHead: oid,
  resultingHead: '2'.repeat(40),
  patchDigest: `sha256:${'b'.repeat(64)}`,
  solutionSafe: `0x${'a'.repeat(40)}`,
  adoptedAt: '2026-07-28T12:00:00.000Z',
};

const anchor = {
  schemaVersion: 'jinn-issue-relay-evaluation-anchor.v1' as const,
  correlation,
  targetRepository: 'Jinn-Network/mono',
  workspaceRepository: 'Jinn-Network/mono',
  prNumber: 42,
  targetBase: 'main',
  baseOid: oid,
  headRef: 'relay/1889',
  evaluatedHead: '2'.repeat(40),
  adoptionReceiptDigest: `sha256:${'c'.repeat(64)}`,
  checksDigest: `sha256:${'d'.repeat(64)}`,
  anchoredAt: '2026-07-28T12:01:00.000Z',
};

const context = {
  schemaVersion: 'jinn-issue-relay-evaluation-context.v1' as const,
  goal: {
    snapshotDigest: digest,
    problemStatement: 'Repair the reported test failure.',
    acceptanceEvidence: ['The focused test passes.'],
    verificationProfile: 'jinn-mono.v1' as const,
  },
  operators: {
    solutionSafe: acceptedReceipt.solutionSafe,
    evaluatorSafe: `0x${'b'.repeat(40)}`,
  },
  round: repairRound,
  correlation,
  reviewTarget: {
    targetRepository: 'Jinn-Network/mono',
    workspaceRepository: 'Jinn-Network/mono',
    issueNumber: 1889,
    prNumber: 42,
    targetBase: 'main',
    baseOid: oid,
    headRef: 'relay/1889',
    evaluatedHead: '2'.repeat(40),
  },
  adoptionReceipt: acceptedReceipt,
  evaluationAnchor: anchor,
  checks: {
    digest: anchor.checksDigest,
    required: [{ name: 'typecheck', status: 'passed' as const }],
    optional: [{ name: 'lint', status: 'pending' as const }],
  },
};

describe('Issue Relay evidence contracts', () => {
  it('accepts both adoption dispositions', () => {
    expect(IssueRelayAdoptionReceiptV1Schema.parse(acceptedReceipt)).toEqual(acceptedReceipt);
    expect(IssueRelayAdoptionReceiptV1Schema.parse({
      schemaVersion: 'jinn-issue-relay-adoption.v1',
      disposition: 'rejected',
      correlation,
      reason: 'verification-failed',
      detail: 'The required check failed.',
      recordedAt: '2026-07-28T12:00:00.000Z',
    }).disposition).toBe('rejected');
  });

  it('binds evaluation context Safes, heads, and correlations exactly', () => {
    expect(IssueRelayEvaluationContextV1Schema.parse(context)).toEqual(context);
    expect(IssueRelayEvaluationContextV1Schema.safeParse({
      ...context,
      operators: { ...context.operators, evaluatorSafe: acceptedReceipt.solutionSafe },
    }).success).toBe(false);
    expect(IssueRelayEvaluationContextV1Schema.safeParse({
      ...context,
      reviewTarget: { ...context.reviewTarget, evaluatedHead: '3'.repeat(40) },
    }).success).toBe(false);
    expect(IssueRelayEvaluationContextV1Schema.safeParse({
      ...context,
      evaluationAnchor: {
        ...anchor,
        correlation: { ...correlation, requestId: 'other-request' },
      },
    }).success).toBe(false);
  });

  it('requires outcome-specific verdict findings', () => {
    const pass = {
      schemaVersion: 'jinn-issue-relay-verdict.v1' as const,
      outcome: 'pass' as const,
      correlation,
      evaluatedHead: '2'.repeat(40),
      summary: 'All required checks passed.',
      findings: [],
    };
    expect(IssueRelayVerdictV1Schema.safeParse(pass).success).toBe(true);
    expect(IssueRelayVerdictV1Schema.safeParse({
      ...pass,
      findings: repairRound.findings,
    }).success).toBe(false);
    expect(IssueRelayVerdictV1Schema.safeParse({
      ...pass,
      outcome: 'request-changes',
    }).success).toBe(false);
    expect(IssueRelayVerdictV1Schema.safeParse({
      ...pass,
      outcome: 'request-changes',
      findings: repairRound.findings,
    }).success).toBe(true);
    expect(IssueRelayEvaluationAnchorV1Schema.parse(anchor)).toEqual(anchor);
  });
});

describe('Issue Relay golden fixtures', () => {
  it('parses the published repair round exactly', () => {
    expect(IssueRelayRoundV1Schema.parse(fixture('issue-relay-round.v1'))).toEqual(repairRound);
  });

  it('parses the published accepted adoption exactly', () => {
    expect(IssueRelayAdoptionReceiptV1Schema.parse(
      fixture('issue-relay-adoption.v1'),
    )).toEqual(acceptedReceipt);
  });
});
