import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  formatIssueRelayAdoptionReceiptComment,
  formatIssueRelayEvaluationAnchorComment,
  parseIssueRelayAssuranceComment,
  parseIssueRelayAdoptionReceiptComment,
  parseIssueRelayEvaluationAnchorComment,
} from '../src/issue-relay-comment.js';

const correlation = {
  generation: 'R_kgDOExample:42:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  round: 1,
  snapshotDigest: `sha256:${'a'.repeat(64)}`,
  taskId: 'task-42',
  attemptIndex: 0,
  requestId: 'request-42',
  deliveryEnvelopeCid: 'bafyrelay42',
};

const receipt = {
  schemaVersion: 'jinn-issue-relay-adoption.v1' as const,
  disposition: 'accepted' as const,
  correlation,
  targetRepository: 'Jinn-Network/mono',
  workspaceRepository: 'Jinn-Network/mono',
  issueNumber: 1889,
  prNumber: 42,
  headRef: 'relay/1889',
  inputHead: '1'.repeat(40),
  resultingHead: '2'.repeat(40),
  patchDigest: `sha256:${'b'.repeat(64)}`,
  solutionSafe: `0x${'a'.repeat(40)}`,
  adoptedAt: '2026-07-28T12:00:00.000Z',
};

function canonicalJson(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(
        (value as Record<string, unknown>)[key],
      )}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

const anchor = {
  schemaVersion: 'jinn-issue-relay-evaluation-anchor.v1' as const,
  correlation,
  targetRepository: 'Jinn-Network/mono',
  workspaceRepository: 'Jinn-Network/mono',
  prNumber: 42,
  targetBase: 'main',
  baseOid: '1'.repeat(40),
  headRef: 'relay/1889',
  evaluatedHead: '2'.repeat(40),
  adoptionReceiptDigest: digest(receipt),
  checksDigest: `sha256:${'d'.repeat(64)}`,
  anchoredAt: '2026-07-28T12:01:00.000Z',
};

describe('Issue Relay evidence comments', () => {
  it('formats and parses exactly one canonical adoption receipt block', () => {
    const body = formatIssueRelayAdoptionReceiptComment(receipt);
    expect(body).toBe([
      '<!-- jinn-issue-relay:adoption:v1 -->',
      '```json',
      JSON.stringify(receipt),
      '```',
    ].join('\n'));
    expect(parseIssueRelayAdoptionReceiptComment(body)).toEqual(receipt);
  });

  it('formats and parses exactly one canonical evaluation-anchor block', () => {
    const body = formatIssueRelayEvaluationAnchorComment(anchor);
    expect(parseIssueRelayEvaluationAnchorComment(body)).toEqual(anchor);
  });

  it('selects one exact correlation from a multi-round composed assurance comment', () => {
    const earlierReceipt = {
      ...receipt,
      correlation: {
        ...receipt.correlation,
        round: 0,
        taskId: 'task-41',
        requestId: 'request-41',
        deliveryEnvelopeCid: 'bafyrelay41',
      },
      inputHead: '0'.repeat(40),
      resultingHead: '1'.repeat(40),
    };
    const earlierAnchor = {
      ...anchor,
      correlation: earlierReceipt.correlation,
      evaluatedHead: earlierReceipt.resultingHead,
      adoptionReceiptDigest: digest(earlierReceipt),
    };
    const body = [
      '<!-- jinn-issue-relay:assurance:v1 -->',
      '',
      '# READY FOR HUMAN REVIEW',
      '',
      '<details>',
      '<summary>Technical receipts and evidence</summary>',
      '',
      formatIssueRelayAdoptionReceiptComment(earlierReceipt),
      '',
      formatIssueRelayAdoptionReceiptComment(receipt),
      '',
      formatIssueRelayEvaluationAnchorComment(earlierAnchor),
      '',
      formatIssueRelayEvaluationAnchorComment(anchor),
      '</details>',
    ].join('\n');

    expect(parseIssueRelayAssuranceComment(body, correlation)).toEqual({
      receipt,
      anchor,
    });
    expect(parseIssueRelayAssuranceComment(
      body.replace(
        '<!-- jinn-issue-relay:assurance:v1 -->',
        '<!-- jinn-issue-relay:assurance:v2 -->',
      ),
      correlation,
    )).toEqual({ receipt, anchor });
  });

  it('rejects duplicate or contradictory correlations in composed assurance comments', () => {
    const block = formatIssueRelayAdoptionReceiptComment(receipt);
    const duplicate = [
      '<!-- jinn-issue-relay:assurance:v1 -->',
      block,
      block,
      formatIssueRelayEvaluationAnchorComment(anchor),
    ].join('\n');
    const contradictory = [
      '<!-- jinn-issue-relay:assurance:v1 -->',
      block,
      formatIssueRelayEvaluationAnchorComment({
        ...anchor,
        correlation: { ...anchor.correlation, generation: 'other-generation' },
      }),
    ].join('\n');

    expect(() => parseIssueRelayAssuranceComment(duplicate, correlation))
      .toThrow(/duplicate|correlation/i);
    expect(() => parseIssueRelayAssuranceComment(contradictory, correlation))
      .toThrow(/contradict|receipt|correlation/i);
  });

  it.each([
    ['multiple matching blocks', (body: string) => `${body}\n${body}`],
    ['malformed JSON', (body: string) => body.replace(JSON.stringify(receipt), '{')],
    ['extra fields', (body: string) => body.replace(
      JSON.stringify(receipt),
      JSON.stringify({ ...receipt, unexpected: true }),
    )],
    ['noncanonical schema version', (body: string) => body.replace(
      'jinn-issue-relay-adoption.v1',
      'jinn-issue-relay-adoption.v2',
    )],
  ])('rejects adoption comments with %s', (_label, mutate) => {
    expect(parseIssueRelayAdoptionReceiptComment(
      mutate(formatIssueRelayAdoptionReceiptComment(receipt)),
    )).toBeNull();
  });
});
