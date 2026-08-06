import { createHash } from 'node:crypto';
import { z } from 'zod/v3';
import {
  IssueRelayAdoptionReceiptV1Schema,
  IssueRelayCorrelationV1Schema,
  IssueRelayEvaluationAnchorV1Schema,
  type IssueRelayAdoptionReceiptV1,
  type IssueRelayCorrelationV1,
  type IssueRelayEvaluationAnchorV1,
} from './issue-relay.js';

const ADOPTION_MARKER = '<!-- jinn-issue-relay:adoption:v1 -->';
const EVALUATION_ANCHOR_MARKER = '<!-- jinn-issue-relay:evaluation-anchor:v1 -->';
const ASSURANCE_MARKER = '<!-- jinn-issue-relay:assurance:v1 -->';
const MAX_ASSURANCE_BYTES = 1024 * 1024;
const MAX_ASSURANCE_BLOCKS_PER_KIND = 100;

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

function sameCorrelation(
  left: IssueRelayCorrelationV1,
  right: IssueRelayCorrelationV1,
): boolean {
  return left.generation === right.generation
    && left.round === right.round
    && left.snapshotDigest === right.snapshotDigest
    && left.taskId === right.taskId
    && left.attemptIndex === right.attemptIndex
    && left.requestId === right.requestId
    && left.deliveryEnvelopeCid === right.deliveryEnvelopeCid;
}

function sameStableDelivery(
  left: IssueRelayCorrelationV1,
  right: IssueRelayCorrelationV1,
): boolean {
  return left.taskId === right.taskId
    && left.attemptIndex === right.attemptIndex
    && left.requestId === right.requestId
    && left.deliveryEnvelopeCid === right.deliveryEnvelopeCid;
}

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

function canonicalDigest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function parseEmbeddedBlocks<T>(
  lines: readonly string[],
  marker: string,
  schema: z.ZodTypeAny,
): readonly T[] {
  const values: T[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] !== marker) continue;
    const fenceIndex = lines[index + 1] === '' ? index + 2 : index + 1;
    const jsonIndex = fenceIndex + 1;
    const closeIndex = fenceIndex + 2;
    if (
      lines[fenceIndex] !== '```json'
      || lines[jsonIndex] === undefined
      || lines[closeIndex] !== '```'
    ) {
      throw new Error(`Malformed ${marker} block in Relay assurance comment`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(lines[jsonIndex]!);
    } catch {
      throw new Error(`Malformed JSON in ${marker} Relay assurance block`);
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success || JSON.stringify(parsed.data) !== lines[jsonIndex]) {
      throw new Error(`Noncanonical ${marker} block in Relay assurance comment`);
    }
    values.push(parsed.data as T);
    if (values.length > MAX_ASSURANCE_BLOCKS_PER_KIND) {
      throw new Error('Relay assurance comment exceeds its evidence-block bound');
    }
    index = closeIndex;
  }
  return values;
}

export interface ParsedIssueRelayAssuranceComment {
  readonly receipt: IssueRelayAdoptionReceiptV1;
  readonly anchor?: IssueRelayEvaluationAnchorV1;
}

/**
 * Selects the one exact delivery from Autopilot's single composed assurance
 * comment. Other rounds may coexist in the same bounded comment.
 */
export function parseIssueRelayAssuranceComment(
  body: string,
  expectedCorrelation: IssueRelayCorrelationV1,
): ParsedIssueRelayAssuranceComment | null {
  if (!body.startsWith(`${ASSURANCE_MARKER}\n`) && body !== ASSURANCE_MARKER) {
    return null;
  }
  if (new TextEncoder().encode(body).byteLength > MAX_ASSURANCE_BYTES) {
    throw new Error('Relay assurance comment exceeds its byte bound');
  }
  const parsedExpected = IssueRelayCorrelationV1Schema.safeParse(
    expectedCorrelation,
  );
  if (!parsedExpected.success) {
    throw new Error('Expected Relay assurance correlation is malformed');
  }
  const lines = body.split('\n');
  if (
    lines[0] !== ASSURANCE_MARKER
    || lines.slice(1).includes(ASSURANCE_MARKER)
  ) {
    throw new Error('Relay assurance marker is duplicated or misplaced');
  }

  const receipts = parseEmbeddedBlocks<IssueRelayAdoptionReceiptV1>(
    lines,
    ADOPTION_MARKER,
    IssueRelayAdoptionReceiptV1Schema,
  );
  const anchors = parseEmbeddedBlocks<IssueRelayEvaluationAnchorV1>(
    lines,
    EVALUATION_ANCHOR_MARKER,
    IssueRelayEvaluationAnchorV1Schema,
  );

  for (let index = 0; index < receipts.length; index += 1) {
    const receipt = receipts[index]!;
    const conflicting = receipts.slice(index + 1).find((other) =>
      sameStableDelivery(receipt.correlation, other.correlation));
    if (conflicting !== undefined) {
      if (conflicting.disposition !== receipt.disposition) {
        throw new Error('Relay assurance contains accepted and rejected receipts for the same delivery');
      }
      throw new Error('Relay assurance contains duplicate or contradictory receipt correlations');
    }
  }
  for (let index = 0; index < anchors.length; index += 1) {
    const anchor = anchors[index]!;
    if (anchors.slice(index + 1).some((other) =>
      sameStableDelivery(anchor.correlation, other.correlation))) {
      throw new Error('Relay assurance contains duplicate or contradictory anchor correlations');
    }
    const matchingReceipt = receipts.find((receipt) =>
      sameCorrelation(receipt.correlation, anchor.correlation));
    if (matchingReceipt?.disposition !== 'accepted') {
      throw new Error('Relay assurance anchor has no matching accepted receipt');
    }
    if (anchor.adoptionReceiptDigest !== canonicalDigest(matchingReceipt)) {
      throw new Error('Relay assurance anchor contradicts its adoption receipt digest');
    }
  }

  const expected = parsedExpected.data as IssueRelayCorrelationV1;
  const stableReceipts = receipts.filter((receipt) =>
    sameStableDelivery(receipt.correlation, expected));
  const stableAnchors = anchors.filter((anchor) =>
    sameStableDelivery(anchor.correlation, expected));
  if (
    stableReceipts.some((receipt) => !sameCorrelation(receipt.correlation, expected))
    || stableAnchors.some((anchor) => !sameCorrelation(anchor.correlation, expected))
  ) {
    throw new Error('Relay assurance evidence contradicts the expected correlation');
  }
  const receipt = stableReceipts[0];
  if (receipt === undefined) return null;
  const anchor = stableAnchors[0];
  return {
    receipt,
    ...(anchor === undefined ? {} : { anchor }),
  };
}
