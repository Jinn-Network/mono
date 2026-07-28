import { z } from 'zod/v3';
import {
  IssueRelayAdoptionReceiptV1Schema,
  IssueRelayEvaluationAnchorV1Schema,
  type IssueRelayAdoptionReceiptV1,
  type IssueRelayEvaluationAnchorV1,
} from './issue-relay.js';

const ADOPTION_MARKER = '<!-- jinn-issue-relay:adoption:v1 -->';
const EVALUATION_ANCHOR_MARKER = '<!-- jinn-issue-relay:evaluation-anchor:v1 -->';

function formatCanonicalComment(marker: string, value: unknown): string {
  return [marker, '```json', JSON.stringify(value), '```'].join('\n');
}

function parseCanonicalComment(
  body: string,
  marker: string,
  schema: z.ZodTypeAny,
): unknown | null {
  const lines = body.split('\n');
  if (
    lines.length !== 4
    || lines[0] !== marker
    || lines[1] !== '```json'
    || lines[3] !== '```'
  ) {
    return null;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(lines[2]!);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success || JSON.stringify(parsed.data) !== lines[2]) return null;
  return parsed.data;
}

export function formatIssueRelayAdoptionReceiptComment(
  receipt: IssueRelayAdoptionReceiptV1,
): string {
  return formatCanonicalComment(
    ADOPTION_MARKER,
    IssueRelayAdoptionReceiptV1Schema.parse(receipt),
  );
}

export function parseIssueRelayAdoptionReceiptComment(
  body: string,
): IssueRelayAdoptionReceiptV1 | null {
  return parseCanonicalComment(
    body,
    ADOPTION_MARKER,
    IssueRelayAdoptionReceiptV1Schema,
  ) as IssueRelayAdoptionReceiptV1 | null;
}

export function formatIssueRelayEvaluationAnchorComment(
  anchor: IssueRelayEvaluationAnchorV1,
): string {
  return formatCanonicalComment(
    EVALUATION_ANCHOR_MARKER,
    IssueRelayEvaluationAnchorV1Schema.parse(anchor),
  );
}

export function parseIssueRelayEvaluationAnchorComment(
  body: string,
): IssueRelayEvaluationAnchorV1 | null {
  return parseCanonicalComment(
    body,
    EVALUATION_ANCHOR_MARKER,
    IssueRelayEvaluationAnchorV1Schema,
  ) as IssueRelayEvaluationAnchorV1 | null;
}
