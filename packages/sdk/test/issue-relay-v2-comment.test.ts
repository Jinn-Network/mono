import { describe, expect, it } from 'vitest';
import {
  formatIssueRelayDecisionRequestComment,
  formatIssueRelayEvaluationBundleComment,
  formatIssueRelayHumanDecisionReceiptComment,
  parseIssueRelayDecisionRequestComment,
  parseIssueRelayEvaluationBundleComment,
  parseIssueRelayHumanDecisionReceiptComment,
} from '../src/issue-relay-comment.js';
import {
  issueRelayDecisionKey,
  issueRelayDecisionRequestDigest,
  issueRelayHumanDecisionReceiptDigest,
} from '../src/issue-relay.js';

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;

const proposal = {
  schemaVersion: 'jinn-issue-relay-decision-proposal.v1' as const,
  lane: 'quality' as const,
  reasonCode: 'compatibility-choice',
  question: 'Preserve compatibility?',
  authorityCategory: 'authorising-maintainer' as const,
  whyHumanAuthorityIsRequired: 'This is a product decision.',
  supportingEvidence: [],
  options: [
    {
      optionId: 'preserve',
      title: 'Preserve',
      description: 'Keep compatibility.',
      effect: 'retain-current-change' as const,
      consequences: ['Callers keep working.'],
      tradeoffs: ['More surface remains.'],
    },
    {
      optionId: 'remove',
      title: 'Remove',
      description: 'Remove compatibility.',
      effect: 'cancel' as const,
      consequences: ['The change stops.'],
      tradeoffs: ['The issue remains unresolved.'],
    },
  ],
  recommendedOptionId: 'preserve',
  recommendationRationale: 'It is safer.',
  recommendationConfidence: 'high' as const,
  proposedImplementationPolicy: 'recommendation-only' as const,
};

const requestBase = {
  schemaVersion: 'jinn-issue-relay-decision-request.v1' as const,
  decisionKey: issueRelayDecisionKey({
    generation: 'generation',
    snapshotDigest: digest('c'),
    proposal,
  }),
  generation: 'generation',
  round: 0,
  snapshotDigest: digest('c'),
  exactHead: '1'.repeat(40),
  lane: 'quality' as const,
  proposal,
  effectiveImplementationPolicy: 'recommendation-only' as const,
  implementation: { status: 'not-required' as const },
  requiredRole: 'original-authorising-maintainer' as const,
  allowedActions: ['select-option'] as const,
  createdAt: '2026-08-06T12:00:00.000Z',
  expiresAt: '2026-08-20T12:00:00.000Z',
};
const request = {
  ...requestBase,
  requestDigest: issueRelayDecisionRequestDigest(requestBase),
};

const receiptBase = {
  schemaVersion: 'jinn-issue-relay-human-decision.v1' as const,
  requestDigest: request.requestDigest,
  decisionKey: request.decisionKey,
  generation: request.generation,
  round: request.round,
  snapshotDigest: request.snapshotDigest,
  requestHead: request.exactHead,
  lane: request.lane,
  action: 'select-option' as const,
  selectedOptionId: 'preserve',
  binding: 'exact-head-acceptance' as const,
  actor: { githubLogin: 'maintainer', githubUserId: 'MDQ6VXNlcjE=' },
  authority: {
    requiredRole: request.requiredRole,
    observedPermission: 'WRITE' as const,
    checkedAt: '2026-08-06T12:05:00.000Z',
  },
  sourceComment: {
    commentId: 42,
    nodeId: 'IC_kwDOExample',
    bodyDigest: digest('d'),
    createdAt: '2026-08-06T12:04:00.000Z',
    updatedAt: '2026-08-06T12:04:00.000Z',
  },
  decidedAt: '2026-08-06T12:05:00.000Z',
};
const receipt = {
  ...receiptBase,
  receiptDigest: issueRelayHumanDecisionReceiptDigest(receiptBase),
};

const correlation = {
  generation: 'generation',
  round: 0,
  snapshotDigest: digest('c'),
  taskId: '42',
  attemptIndex: 0,
  requestId: 'request-42',
  deliveryEnvelopeCid: 'bafy42',
};
const lane = (name: 'security' | 'quality') => ({
  schemaVersion: 'jinn-issue-relay-lane-attestation.v1' as const,
  lane: name,
  correlation,
  evaluatedHead: request.exactHead,
  evaluationContextDigest: digest('e'),
  evaluationAnchorDigest: digest('f'),
  adoptionReceiptDigest: digest('1'),
  checksDigest: digest('2'),
  pullRequestMetadataDigest: digest('9'),
  evaluationSpecificationDigest: name === 'security' ? digest('3') : digest('4'),
  outcome: { kind: 'pass' as const, findings: [] },
  publicSummary: `${name} passed.`,
});
const bundle = {
  schemaVersion: 'jinn-issue-relay-evaluation-bundle.v2' as const,
  correlation,
  evaluatedHead: request.exactHead,
  evaluationContextDigest: digest('e'),
  lanes: { security: lane('security'), quality: lane('quality') },
  overallProjection: 'pass' as const,
};

describe('Issue Relay V2 canonical comments', () => {
  it('round-trips validated V2 blocks and rejects noncanonical JSON', () => {
    const requestComment = formatIssueRelayDecisionRequestComment(request);
    expect(parseIssueRelayDecisionRequestComment(requestComment)).toEqual(request);
    const bundleComment = formatIssueRelayEvaluationBundleComment(bundle);
    expect(parseIssueRelayEvaluationBundleComment(bundleComment)).toEqual(bundle);
    const receiptComment = formatIssueRelayHumanDecisionReceiptComment(receipt);
    expect(parseIssueRelayHumanDecisionReceiptComment(receiptComment)).toEqual(receipt);
    expect(parseIssueRelayDecisionRequestComment(
      '<!-- jinn-issue-relay:decision-request:v1 -->\n```json\n{ "x": 1 }\n```',
    )).toBeNull();
  });

  it('exports all three V2 format and parse boundaries', () => {
    expect(formatIssueRelayDecisionRequestComment).toBeTypeOf('function');
    expect(parseIssueRelayDecisionRequestComment).toBeTypeOf('function');
    expect(formatIssueRelayEvaluationBundleComment).toBeTypeOf('function');
    expect(parseIssueRelayEvaluationBundleComment).toBeTypeOf('function');
    expect(formatIssueRelayHumanDecisionReceiptComment).toBeTypeOf('function');
    expect(parseIssueRelayHumanDecisionReceiptComment).toBeTypeOf('function');
  });
});
