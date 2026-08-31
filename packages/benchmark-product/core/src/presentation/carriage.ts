/**
 * Workspace-side report-presentation carriage: the one place that turns
 * `RunState.presentationSha256` into the exact bytes a bundle carries at `presentation.json`.
 *
 * Mirrors `anchor/carriage.ts` and `disclosure/carriage.ts`, rule for rule:
 *
 * - **Bytes come out of the sealed store, never out of RunState.** RunState names one digest;
 *   `getSealedBytes` re-verifies it on read, so a record edited in place surfaces as its own
 *   `record-integrity` refusal naming the store path, before anything projects it.
 * - **The projection is the shared one.** `deriveReportPresentation` lives in
 *   `@colophon-claims/verify` and is the same function the portable verifier authenticates the
 *   member with. One function over the same bytes, not two implementations that can disagree about
 *   what a reader is being shown.
 * - **A projection failure is a typed product refusal.** A record that no longer parses, or that
 *   names a report other than the one this bundle materializes, is `record-integrity` here.
 *
 * Returns `undefined` for a run that never set one — which is what keeps every existing bundle
 * byte-identical, and what makes the whole member strictly opt-in at produce time.
 */

import { ReportPresentationProjectionError, deriveReportPresentation } from "@colophon-claims/verify";
import type { ReportPresentation } from "@colophon-claims/verify";
import { refuse } from "../errors.js";
import type { RunState } from "../run/state.js";
import { getSealedBytes } from "../workspace/sealed-store.js";

export interface RunPresentationCarriage {
  /** The exact sealed bytes — what `presentation.json` carries. */
  readonly bytes: Uint8Array;
  readonly recordSha256: string;
  readonly presentation: ReportPresentation;
}

export interface ReadRunPresentationCarriageInput {
  readonly workspaceDir: string;
  readonly runState: Pick<RunState, "presentationSha256">;
  /**
   * The Report identity pair THIS bundle materializes from. A run publishes one bundle per analysis
   * and the presentation names exactly one report, so this is also the scoping rule: a sibling
   * analysis's bundle resolves a different report, does not match, and publishes byte-identically
   * to how it published before the run had a presentation at all.
   */
  readonly reportSha256: string;
  readonly reportEnvelopeSha256: string;
  /** The closure version this bundle is about to declare. */
  readonly bundleFormat: string;
}

/**
 * Reads this run's sealed presentation, if it has one that belongs to this bundle's report.
 *
 * A presentation that parses but names ANOTHER of this run's reports is not an error: it is the
 * ordinary case of a multi-analysis run whose sibling bundles carry no presentation. A presentation
 * that names this report and then fails to project is an error, and refuses.
 */
export function readRunPresentationCarriage(
  input: ReadRunPresentationCarriageInput,
): RunPresentationCarriage | undefined {
  const recordSha256 = input.runState.presentationSha256;
  if (recordSha256 === undefined) return undefined;
  const bytes = getSealedBytes(input.workspaceDir, recordSha256);
  let named: string | undefined;
  try {
    named = (JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as {
      readonly provenance?: { readonly reportSha256?: unknown };
    } | null)?.provenance?.reportSha256 as string | undefined;
  } catch {
    named = undefined;
  }
  // Selection before projection, so a sibling analysis's bundle never has to satisfy a projection
  // written for another report. Unparseable bytes fall through to the projection below, which is
  // where the refusal belongs and where it names the reason.
  if (named !== undefined && named !== input.reportSha256) return undefined;
  try {
    return {
      bytes,
      recordSha256,
      presentation: deriveReportPresentation({
        bytes,
        reportSha256: input.reportSha256,
        reportEnvelopeSha256: input.reportEnvelopeSha256,
        bundleFormat: input.bundleFormat,
      }),
    };
  } catch (cause) {
    if (cause instanceof ReportPresentationProjectionError) {
      refuse("record-integrity", "presentation.json", cause.message);
    }
    throw cause;
  }
}
