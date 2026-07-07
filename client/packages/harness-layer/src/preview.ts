/**
 * Harness-layer scrub preview — "see exactly what would leave your machine".
 *
 * `preview(pending)` renders a `PendingEnvelope` as a `ScrubReport`: the
 * envelope exactly as it would publish, plus the redaction diff. The
 * envelope carries the consent flags asserted (`TraceEnvelopeV0` cannot
 * exist without them) — that assertion is hypothetical here: the preview is
 * "IF you consent, this is what publishes". The pending state itself stays
 * unconsented; only the Task 4 publish path converts it for real.
 *
 * `redactions[].before` values are the original (sensitive) content: local
 * display only, NEVER persisted — anything that serialises a report for
 * storage or transport must strip them (`stripBeforeValues`).
 *
 * Plan: docs/superpowers/plans/2026-07-02-jinn-harness-network-v0-plan.md
 * Task 3 (issue #1310).
 */

import { parseTraceEnvelopeV0, type TraceEnvelopeV0 } from './envelope.js';
import type { PendingEnvelope, ScrubRedaction } from './capture.js';

export interface ScrubReport {
  /** The envelope exactly as it would publish (consent flags asserted). */
  envelope: TraceEnvelopeV0;
  /** The redaction diff. `before` is local-display-only, never persisted. */
  redactions: ScrubRedaction[];
}

/** Render the pending envelope's scrub report. Pure and local — no I/O. */
export function preview(pending: PendingEnvelope): ScrubReport {
  const envelope = parseTraceEnvelopeV0({
    ...pending.draft,
    consent: { contributionConsent: true, scrubCompleted: true },
  });
  return { envelope, redactions: pending.redactions };
}

/**
 * The persistence-safe projection of a redaction list: identical minus every
 * `before` value. Use this for ANY serialised output (e.g. `--json`) — the
 * originals exist for the operator's eyes on their own terminal, nothing else.
 */
export function stripBeforeValues(redactions: ScrubRedaction[]): Array<Omit<ScrubRedaction, 'before'>> {
  return redactions.map(({ before: _before, ...rest }) => rest);
}
