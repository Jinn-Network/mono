/**
 * Versioned disposition policy (#1969 / design §6.5).
 *
 * disposition(class, band) -> redact | reject-publish | flag | pass
 *
 * Defaults follow §3.2's rightmost columns. C2 stays `pass` until the flag
 * review surface exists (do not redact 0x+64 tx hashes).
 */

import type { Band, Finding, ScrubClass } from './finding.js';

export type Disposition = 'redact' | 'reject-publish' | 'flag' | 'pass';

export const POLICY_VERSION = '1.0.0';

/** Per-band dispositions for one class. Missing bands fall back to `pass`. */
export type ClassDispositionRow = Partial<Record<Band, Disposition>>;

export interface PolicyTable {
  version: string;
  dispositions: Partial<Record<ScrubClass, ClassDispositionRow>>;
}

/**
 * Default policy. High-confidence deterministic classes redact; reject classes
 * (A4/A5) reject-publish; A2 mid-band flags; C2 passes pending flag surface.
 */
export const DEFAULT_POLICY: PolicyTable = {
  version: POLICY_VERSION,
  dispositions: {
    A1: {
      VERY_HIGH: 'redact',
      HIGH: 'redact',
      MEDIUM: 'redact',
      LOW: 'flag',
      VERY_LOW: 'pass',
    },
    A2: {
      VERY_HIGH: 'redact',
      HIGH: 'redact',
      MEDIUM: 'flag',
      LOW: 'pass',
      VERY_LOW: 'pass',
    },
    A3: {
      VERY_HIGH: 'redact',
      HIGH: 'redact',
      MEDIUM: 'redact',
      LOW: 'flag',
      VERY_LOW: 'pass',
    },
    A4: {
      VERY_HIGH: 'reject-publish',
      HIGH: 'reject-publish',
      MEDIUM: 'reject-publish',
      LOW: 'flag',
      VERY_LOW: 'pass',
    },
    A5: {
      VERY_HIGH: 'reject-publish',
      HIGH: 'reject-publish',
      MEDIUM: 'reject-publish',
      LOW: 'flag',
      VERY_LOW: 'pass',
    },
    B1: {
      VERY_HIGH: 'redact',
      HIGH: 'redact',
      MEDIUM: 'redact',
      LOW: 'flag',
      VERY_LOW: 'pass',
    },
    B2: {
      VERY_HIGH: 'redact',
      HIGH: 'redact',
      MEDIUM: 'redact',
      LOW: 'flag',
      VERY_LOW: 'pass',
    },
    B3: {
      VERY_HIGH: 'redact',
      HIGH: 'flag',
      MEDIUM: 'flag',
      LOW: 'pass',
      VERY_LOW: 'pass',
    },
    B4: {
      VERY_HIGH: 'redact',
      HIGH: 'redact',
      MEDIUM: 'flag',
      LOW: 'pass',
      VERY_LOW: 'pass',
    },
    B5: {
      VERY_HIGH: 'redact',
      HIGH: 'redact',
      MEDIUM: 'flag',
      LOW: 'pass',
      VERY_LOW: 'pass',
    },
    B6: {
      VERY_HIGH: 'flag',
      HIGH: 'flag',
      MEDIUM: 'flag',
      LOW: 'pass',
      VERY_LOW: 'pass',
    },
    B7: {
      VERY_HIGH: 'redact',
      HIGH: 'redact',
      MEDIUM: 'flag',
      LOW: 'pass',
      VERY_LOW: 'pass',
    },
    C1: {
      VERY_HIGH: 'redact',
      HIGH: 'redact',
      MEDIUM: 'redact',
      LOW: 'flag',
      VERY_LOW: 'pass',
    },
    // C2: §3.2 default is flag, but provenance receipts (0x+64 tx hashes) must
    // survive — leave as pass (locked Q / deferred from review-queue landing).
    C2: {
      VERY_HIGH: 'pass',
      HIGH: 'pass',
      MEDIUM: 'pass',
      LOW: 'pass',
      VERY_LOW: 'pass',
    },
    D1: {
      VERY_HIGH: 'redact',
      HIGH: 'redact',
      MEDIUM: 'redact',
      LOW: 'flag',
      VERY_LOW: 'pass',
    },
    D2: {
      VERY_HIGH: 'redact',
      HIGH: 'redact',
      MEDIUM: 'flag',
      LOW: 'pass',
      VERY_LOW: 'pass',
    },
    D3: {
      VERY_HIGH: 'redact',
      HIGH: 'redact',
      MEDIUM: 'flag',
      LOW: 'pass',
      VERY_LOW: 'pass',
    },
    E1: {
      VERY_HIGH: 'flag',
      HIGH: 'flag',
      MEDIUM: 'flag',
      LOW: 'pass',
      VERY_LOW: 'pass',
    },
  },
};

export function resolveDisposition(
  scrubClass: ScrubClass,
  band: Band,
  policy: PolicyTable = DEFAULT_POLICY,
): Disposition {
  return policy.dispositions[scrubClass]?.[band] ?? 'pass';
}

/**
 * Check-mode mapping (design §6.5): any non-`pass` disposition → reject.
 * One mapping line — not a second pipeline.
 */
export function checkModeRejects(
  findings: Finding[],
  policy: PolicyTable = DEFAULT_POLICY,
): boolean {
  return findings.some((f) => resolveDisposition(f.class, f.confidence, policy) !== 'pass');
}
