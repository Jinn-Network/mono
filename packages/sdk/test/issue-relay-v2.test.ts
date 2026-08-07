import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  IssueRelayDecisionProposalV1Schema,
  IssueRelayDecisionRequestV1Schema,
  IssueRelayEvaluationBundleV2Schema,
  IssueRelayHumanDecisionReceiptV1Schema,
  IssueRelayRoundV2Schema,
  IssueRelaySolutionV2Schema,
  issueRelayDecisionKey,
  issueRelayDecisionRequestDigest,
  issueRelayHumanDecisionReceiptDigest,
  issueRelayPullRequestMetadataDigest,
} from '../src/issue-relay.js';

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;
const head = (character: string) => character.repeat(40);

const correlation = {
  generation: 'relay-generation-v2',
  round: 1,
  snapshotDigest: digest('a'),
  taskId: '42',
  attemptIndex: 0,
  requestId: 'request-42',
  deliveryEnvelopeCid: 'bafy-delivery-42',
};

const qualityProposal = {
  schemaVersion: 'jinn-issue-relay-decision-proposal.v1' as const,
  lane: 'quality' as const,
  reasonCode: 'compatibility-choice',
  question: 'Should the deprecated API remain available?',
  authorityCategory: 'authorising-maintainer' as const,
  whyHumanAuthorityIsRequired: 'Both behaviors are technically valid product choices.',
  supportingEvidence: [{
    label: 'Compatibility evidence',
    digest: digest('b'),
    summary: 'Existing callers still use the deprecated entry point.',
  }],
  options: [
    {
      optionId: 'preserve-compatibility',
      title: 'Preserve compatibility',
      description: 'Keep the deprecated entry point as a forwarding wrapper.',
      effect: 'implement-change' as const,
      implementationBrief: 'Add a forwarding wrapper and regression coverage.',
      consequences: ['Existing callers continue to work.'],
      tradeoffs: ['The deprecated surface remains temporarily.'],
    },
    {
      optionId: 'remove-api',
      title: 'Remove the API',
      description: 'Delete the deprecated entry point.',
      effect: 'implement-change' as const,
      implementationBrief: 'Remove the deprecated entry point and update callers.',
      consequences: ['The public surface becomes smaller.'],
      tradeoffs: ['Existing callers must migrate.'],
    },
  ],
  recommendedOptionId: 'preserve-compatibility',
  recommendationRationale: 'Compatibility is safer inside the frozen issue scope.',
  recommendationConfidence: 'high' as const,
  proposedImplementationPolicy: 'implement-before-decision' as const,
};

const commonAttestation = {
  schemaVersion: 'jinn-issue-relay-lane-attestation.v1' as const,
  correlation,
  evaluatedHead: head('2'),
  evaluationContextDigest: digest('c'),
  evaluationAnchorDigest: digest('d'),
  adoptionReceiptDigest: digest('e'),
  checksDigest: digest('f'),
  pullRequestMetadataDigest: digest('9'),
  evaluationSpecificationDigest: digest('1'),
  publicSummary: 'The exact revision was evaluated.',
};

const securityPass = {
  ...commonAttestation,
  lane: 'security' as const,
  outcome: { kind: 'pass' as const, findings: [] },
};

const qualityDecision = {
  ...commonAttestation,
  lane: 'quality' as const,
  evaluationSpecificationDigest: digest('2'),
  outcome: {
    kind: 'decision-required' as const,
    proposal: qualityProposal,
    findings: [],
  },
};

describe('Issue Relay V2 contracts', () => {
  it('requires a patch and maintainer-facing PR metadata in every V2 solution', () => {
    const solution = {
      schemaVersion: 'jinn-issue-relay-solution.v2',
      patch: 'diff --git a/a.ts b/a.ts\n+change\n',
      pullRequest: {
        title: 'Fix the exact Relay issue',
        body: '## Summary\n\nFixes the issue.\n\n## Testing\n\n- yarn test',
      },
    };
    expect(IssueRelaySolutionV2Schema.parse(solution)).toEqual(solution);
    expect(issueRelayPullRequestMetadataDigest(solution.pullRequest))
      .toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(IssueRelaySolutionV2Schema.safeParse({
      schemaVersion: solution.schemaVersion,
      patch: solution.patch,
    }).success).toBe(false);
    expect(IssueRelaySolutionV2Schema.safeParse({
      ...solution,
      pullRequest: {
        ...solution.pullRequest,
        body: '<!-- jinn-issue-relay:pull-request:v1 -->',
      },
    }).success).toBe(false);
    expect(IssueRelaySolutionV2Schema.safeParse({
      ...solution,
      pullRequest: {
        ...solution.pullRequest,
        body: ` ${solution.pullRequest.body}`,
      },
    }).success).toBe(false);
  });

  it('parses the published dual-lane bundle fixture', () => {
    const path = fileURLToPath(new URL(
      '../fixtures/autopilot/issue-relay-evaluation-bundle.v2.json',
      import.meta.url,
    ));
    const fixture = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    expect(IssueRelayEvaluationBundleV2Schema.parse(fixture)).toEqual(fixture);
  });

  it('accepts a decision-implementation round and rejects its binding elsewhere', () => {
    const decisionKey = issueRelayDecisionKey({
      generation: correlation.generation,
      snapshotDigest: correlation.snapshotDigest,
      proposal: qualityProposal,
    });
    const decisionRound = {
      schemaVersion: 'jinn-issue-relay-round.v2',
      generation: correlation.generation,
      round: 2,
      snapshotDigest: correlation.snapshotDigest,
      targetRepository: 'Jinn-Network/mono',
      workspaceRepository: 'jinn-relay/mono',
      inputHead: head('2'),
      purpose: 'decision-implementation',
      findings: [],
      prNumber: 42,
      decisionBinding: {
        decisionKey,
        proposalDigest: digest('3'),
        optionId: 'preserve-compatibility',
        authorization: 'repository-policy-safe-preimplementation',
        sourceHead: head('2'),
        frozenImplementationBrief: 'Add a forwarding wrapper and regression coverage.',
      },
    };

    expect(IssueRelayRoundV2Schema.parse(decisionRound)).toEqual(decisionRound);
    expect(IssueRelayRoundV2Schema.safeParse({
      ...decisionRound,
      purpose: 'repair',
    }).success).toBe(false);
  });

  it('requires two to four unique options and a real recommendation', () => {
    expect(IssueRelayDecisionProposalV1Schema.parse(qualityProposal)).toEqual(qualityProposal);
    expect(IssueRelayDecisionProposalV1Schema.safeParse({
      ...qualityProposal,
      options: [qualityProposal.options[0]],
    }).success).toBe(false);
    expect(IssueRelayDecisionProposalV1Schema.safeParse({
      ...qualityProposal,
      recommendedOptionId: 'missing-option',
    }).success).toBe(false);
    expect(IssueRelayDecisionProposalV1Schema.safeParse({
      ...qualityProposal,
      options: [qualityProposal.options[0], qualityProposal.options[0]],
    }).success).toBe(false);
  });

  it('keeps security and quality as separately bound lane objects', () => {
    const bundle = {
      schemaVersion: 'jinn-issue-relay-evaluation-bundle.v2',
      correlation,
      evaluatedHead: head('2'),
      evaluationContextDigest: digest('c'),
      lanes: { security: securityPass, quality: qualityDecision },
      overallProjection: 'unresolved',
    };

    expect(IssueRelayEvaluationBundleV2Schema.parse(bundle)).toEqual(bundle);
    expect(IssueRelayEvaluationBundleV2Schema.safeParse({
      ...bundle,
      lanes: {
        ...bundle.lanes,
        security: { ...securityPass, evaluatedHead: head('3') },
      },
    }).success).toBe(false);
    expect(IssueRelayEvaluationBundleV2Schema.safeParse({
      ...bundle,
      overallProjection: 'pass',
    }).success).toBe(false);
  });

  it('binds optional automated scanner evidence into a lane attestation', () => {
    const automatedEvidence = [{
      tool: 'snyk-code',
      version: '1.1297.3',
      status: 'findings' as const,
      digest: digest('9'),
      summary: 'Snyk Code completed with findings for semantic adjudication.',
    }];
    expect(IssueRelayEvaluationBundleV2Schema.parse({
      schemaVersion: 'jinn-issue-relay-evaluation-bundle.v2',
      correlation,
      evaluatedHead: head('2'),
      evaluationContextDigest: digest('c'),
      lanes: {
        security: { ...securityPass, automatedEvidence },
        quality: qualityDecision,
      },
      overallProjection: 'unresolved',
    }).lanes.security).toMatchObject({ automatedEvidence });
  });

  it('allows critical blocks only in the security lane', () => {
    const critical = {
      ...commonAttestation,
      lane: 'security' as const,
      outcome: {
        kind: 'critical-block' as const,
        publicSummary: 'A critical trust-boundary violation was found.',
        restrictedEvidencePresent: true,
        restrictedEvidenceDigest: digest('4'),
        findings: [],
      },
    };
    const bundle = {
      schemaVersion: 'jinn-issue-relay-evaluation-bundle.v2',
      correlation,
      evaluatedHead: head('2'),
      evaluationContextDigest: digest('c'),
      lanes: { security: critical, quality: qualityDecision },
      overallProjection: 'fail',
    };

    expect(IssueRelayEvaluationBundleV2Schema.safeParse(bundle).success).toBe(true);
    expect(IssueRelayEvaluationBundleV2Schema.safeParse({
      ...bundle,
      lanes: {
        security: securityPass,
        quality: { ...critical, lane: 'quality' },
      },
    }).success).toBe(false);
  });

  it('binds decision requests and human receipts to canonical digests', () => {
    const decisionKey = issueRelayDecisionKey({
      generation: correlation.generation,
      snapshotDigest: correlation.snapshotDigest,
      proposal: qualityProposal,
    });
    const requestWithoutDigest = {
      schemaVersion: 'jinn-issue-relay-decision-request.v1' as const,
      decisionKey,
      generation: correlation.generation,
      round: 1,
      snapshotDigest: correlation.snapshotDigest,
      exactHead: head('2'),
      lane: 'quality' as const,
      proposal: qualityProposal,
      effectiveImplementationPolicy: 'implement-before-decision' as const,
      implementation: {
        status: 'verified' as const,
        optionId: 'preserve-compatibility',
        sourceHead: head('1'),
        implementedHead: head('2'),
        implementationRound: 1,
        conformanceAttestationDigest: digest('5'),
      },
      requiredRole: 'original-authorising-maintainer' as const,
      allowedActions: ['select-option', 'clarify-scope', 'cancel', 'defer'] as const,
      createdAt: '2026-08-06T12:00:00.000Z',
      expiresAt: '2026-08-20T12:00:00.000Z',
    };
    const request = {
      ...requestWithoutDigest,
      requestDigest: issueRelayDecisionRequestDigest(requestWithoutDigest),
    };
    expect(IssueRelayDecisionRequestV1Schema.parse(request)).toEqual(request);
    expect(IssueRelayDecisionRequestV1Schema.safeParse({
      ...request,
      exactHead: head('3'),
    }).success).toBe(false);

    const receiptWithoutDigest = {
      schemaVersion: 'jinn-issue-relay-human-decision.v1' as const,
      requestDigest: request.requestDigest,
      decisionKey,
      generation: correlation.generation,
      round: 1,
      snapshotDigest: correlation.snapshotDigest,
      requestHead: head('2'),
      lane: 'quality' as const,
      action: 'select-option' as const,
      selectedOptionId: 'preserve-compatibility',
      binding: 'exact-head-acceptance' as const,
      actor: { githubLogin: 'maintainer', githubUserId: 'MDQ6VXNlcjE=' },
      authority: {
        requiredRole: 'original-authorising-maintainer' as const,
        observedPermission: 'WRITE' as const,
        checkedAt: '2026-08-06T12:05:00.000Z',
      },
      sourceComment: {
        commentId: 123,
        nodeId: 'IC_kwDOExample',
        bodyDigest: digest('6'),
        createdAt: '2026-08-06T12:04:00.000Z',
        updatedAt: '2026-08-06T12:04:00.000Z',
      },
      decidedAt: '2026-08-06T12:05:00.000Z',
    };
    const receipt = {
      ...receiptWithoutDigest,
      receiptDigest: issueRelayHumanDecisionReceiptDigest(receiptWithoutDigest),
    };
    expect(IssueRelayHumanDecisionReceiptV1Schema.parse(receipt)).toEqual(receipt);
    expect(IssueRelayHumanDecisionReceiptV1Schema.safeParse({
      ...receipt,
      authority: { ...receipt.authority, observedPermission: 'READ' },
    }).success).toBe(false);
    expect(IssueRelayHumanDecisionReceiptV1Schema.safeParse({
      ...receipt,
      sourceComment: {
        ...receipt.sourceComment,
        updatedAt: '2026-08-06T12:04:01.000Z',
      },
    }).success).toBe(false);
  });
});
