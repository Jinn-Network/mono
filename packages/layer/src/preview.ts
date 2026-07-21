/**
 * Harness-layer scrub preview — "see exactly what would leave your machine".
 *
 * `preview(pending)` renders a `PendingEnvelope` as a `ScrubReport`: the
 * canonical EpisodeV1 payload exactly as it would publish, plus the redaction
 * diff. Consent is the publish action; it is not duplicated inside the shared
 * local/public evidence payload.
 *
 * `redactions[].before` values are the original (sensitive) content: local
 * display only, NEVER persisted — anything that serialises a report for
 * storage or transport must strip them (`stripBeforeValues`).
 *
 * Plan: docs/superpowers/plans/2026-07-02-jinn-harness-network-v0-plan.md
 * Task 3 (issue #1310).
 */

import type { EpisodeV1Write } from '@jinn-network/plugin';
import type { PendingEnvelope, ScrubRedaction } from './capture.js';
import { toPublishedEpisode } from './publish.js';

export interface ScrubReport {
  /** The envelope exactly as it would publish (consent flags asserted). */
  envelope: EpisodeV1Write;
  /** The redaction diff. `before` is local-display-only, never persisted. */
  redactions: ScrubRedaction[];
}

/** Render the pending envelope's scrub report. Pure and local — no I/O. */
export function preview(pending: PendingEnvelope): ScrubReport {
  return { envelope: toPublishedEpisode(pending), redactions: pending.redactions };
}

/**
 * The persistence-safe projection of a redaction list: identical minus every
 * `before` value. Use this for ANY serialised output (e.g. `--json`) — the
 * originals exist for the operator's eyes on their own terminal, nothing else.
 */
export function stripBeforeValues(redactions: ScrubRedaction[]): Array<Omit<ScrubRedaction, 'before'>> {
  return redactions.map(({ before: _before, ...rest }) => rest);
}
