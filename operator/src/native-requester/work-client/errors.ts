/**
 * The work-client module's strict error taxonomy. Category is the operator-facing bucket (it
 * drives the preflight report and the read-plane posting-status projection); code is the stable
 * machine discriminator. Both are closed sets — a new failure mode adds a code, never a free
 * string.
 *
 * This file is part of the extractable `native-requester/work-client/` seam; it imports nothing
 * outside the module (see test/architecture/native-requester-work-client-boundary.test.ts).
 */
export const REQUESTER_ERROR_CATEGORIES = [
  'config',
  'funds',
  'venue',
  'target',
  'freshness',
  'documents',
  'broadcast',
  'delivery',
  'adoption',
  'settlement',
] as const;

export type RequesterErrorCategory = (typeof REQUESTER_ERROR_CATEGORIES)[number];

export class RequesterError extends Error {
  override readonly name = 'RequesterError';

  constructor(
    readonly category: RequesterErrorCategory,
    readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export function isRequesterError(value: unknown): value is RequesterError {
  return value instanceof RequesterError;
}
