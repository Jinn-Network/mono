import { describe, expect, it } from 'vitest';
import {
  formatIssueRelayAdoptionReceiptComment,
  formatIssueRelayEvaluationAnchorComment,
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
  adoptionReceiptDigest: `sha256:${'c'.repeat(64)}`,
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
