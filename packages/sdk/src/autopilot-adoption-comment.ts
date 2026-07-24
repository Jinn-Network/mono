import { z } from 'zod/v3';

import {
  AutopilotAdoptionReceiptSchema,
  type AutopilotAdoptionReceipt,
} from './autopilot-session.js';

const MARKER_PREFIX =
  '<!-- jinn-autopilot:marketplace-adoption-receipt:v1 key=';
const MARKER_SUFFIX = ' -->';
const PAYLOAD_BEGIN =
  '<!-- jinn-autopilot:marketplace-adoption-receipt-payload:v1 begin -->';
const PAYLOAD_END =
  '<!-- jinn-autopilot:marketplace-adoption-receipt-payload:v1 end -->';

const MarkerKeySchema = z.object({
  role: z.enum(['solution', 'verdict']),
  taskId: z.string().min(1),
  attemptIndex: z.number().int().nonnegative(),
  requestId: z.string().min(1),
  deliveryEnvelopeCid: z.string().min(1),
  v2AttemptId: z.string().uuid(),
  disposition: z.enum(['accepted', 'rejected']),
}).strict();

type MarkerKey = z.infer<typeof MarkerKeySchema>;

export interface ParsedAutopilotAdoptionReceiptComment {
  readonly receipt: AutopilotAdoptionReceipt;
  readonly canonicalJson: string;
}

function markerKey(receipt: AutopilotAdoptionReceipt): MarkerKey {
  return {
    role: receipt.role,
    taskId: receipt.taskId,
    attemptIndex: receipt.attemptIndex,
    requestId: receipt.requestId,
    deliveryEnvelopeCid: receipt.deliveryEnvelopeCid,
    v2AttemptId: receipt.v2AttemptId,
    disposition: receipt.disposition,
  };
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function decodeBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const standard = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function encodeMarkerKey(value: MarkerKey): string {
  return encodeBase64Url(JSON.stringify(value));
}

function parseMarkerKey(value: string): MarkerKey | null {
  const decoded = decodeBase64Url(value);
  if (decoded === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(decoded) as unknown;
  } catch {
    return null;
  }
  const parsed = MarkerKeySchema.safeParse(raw);
  if (!parsed.success || encodeMarkerKey(parsed.data) !== value) return null;
  return parsed.data;
}

function markerKeysMatch(left: MarkerKey, right: MarkerKey): boolean {
  return left.role === right.role
    && left.taskId === right.taskId
    && left.attemptIndex === right.attemptIndex
    && left.requestId === right.requestId
    && left.deliveryEnvelopeCid === right.deliveryEnvelopeCid
    && left.v2AttemptId === right.v2AttemptId
    && left.disposition === right.disposition;
}

/**
 * Canonical authenticated GitHub comment framing for one adoption receipt.
 *
 * Callers must still authenticate the GitHub author and verify the receipt
 * against authoritative Task, delivery, and PR facts.
 */
export function formatAutopilotAdoptionReceiptComment(
  input: AutopilotAdoptionReceipt,
): string {
  const receipt = AutopilotAdoptionReceiptSchema.parse(input);
  return [
    `${MARKER_PREFIX}${encodeMarkerKey(markerKey(receipt))}${MARKER_SUFFIX}`,
    PAYLOAD_BEGIN,
    '```json',
    JSON.stringify(receipt),
    '```',
    PAYLOAD_END,
  ].join('\n');
}

/**
 * Parses only the complete canonical comment. Embedded markers, prose around
 * the frame, non-canonical JSON, and marker/payload disagreements are ignored.
 */
export function parseAutopilotAdoptionReceiptComment(
  body: string,
): ParsedAutopilotAdoptionReceiptComment | null {
  const lines = body.split('\n');
  if (
    lines.length !== 6
    || !lines[0]?.startsWith(MARKER_PREFIX)
    || !lines[0].endsWith(MARKER_SUFFIX)
    || lines[1] !== PAYLOAD_BEGIN
    || lines[2] !== '```json'
    || lines[4] !== '```'
    || lines[5] !== PAYLOAD_END
  ) {
    return null;
  }

  const encodedKey = lines[0].slice(
    MARKER_PREFIX.length,
    -MARKER_SUFFIX.length,
  );
  const parsedMarker = parseMarkerKey(encodedKey);
  if (parsedMarker === null) return null;

  let rawReceipt: unknown;
  try {
    rawReceipt = JSON.parse(lines[3]!) as unknown;
  } catch {
    return null;
  }
  const parsedReceipt = AutopilotAdoptionReceiptSchema.safeParse(rawReceipt);
  if (!parsedReceipt.success) return null;
  const receipt = parsedReceipt.data;
  const canonicalJson = JSON.stringify(receipt);
  if (
    canonicalJson !== lines[3]
    || !markerKeysMatch(parsedMarker, markerKey(receipt))
  ) {
    return null;
  }
  return { receipt, canonicalJson };
}
