/**
 * The workspace-side report presentation: what an operator hands `presentation set`, and the one
 * function that turns it into the sealed `presentation.json` bytes a bundle carries.
 *
 * Mirrors `disclosure/state.ts` in shape, and departs from it in exactly one place, deliberately:
 *
 * - **The payload is COMPLETE as supplied.** A disclosure declaration is six sentences a human
 *   writes, around which the workspace composes a record. A presentation is authored by a per-report
 *   export script that already read this workspace's sealed Report and Matrix, so there is nothing
 *   left for the workspace to fill in. Filling anything in here would be worse than useless: a
 *   payload that named the wrong report would be silently retargeted to the right one instead of
 *   refused, which is the single failure this whole member exists to prevent.
 * - **So the workspace VERIFIES instead of composing.** The report and report-envelope digests in
 *   the payload are compared against this run's own, and a mismatch refuses.
 * - **Bytes are canonicalized here, once.** The operator's file is ordinary JSON. What gets sealed
 *   is its exact canonical encoding, which is also what the verifier re-derives, so the member can
 *   never be two encodings of one document.
 *
 * The schema and the binding rule both come from `@colophon-claims/verify`, which the reader also
 * uses. There is no second copy of the presentation contract in this package.
 */

import { canonicalJsonBytes } from "@jinn-network/trust-core";
import {
  REPORT_PRESENTATION_MEMBER,
  ReportPresentationProjectionError,
  ReportPresentationSchema,
  deriveReportPresentation,
  type ReportPresentation,
} from "@colophon-claims/verify";
import { createHash } from "node:crypto";
import { refuse } from "../errors.js";

/**
 * The closure versions whose member list allows `presentation.json`. Checked at seal time so an
 * operator learns their payload targets a closure that cannot carry it while they can still fix the
 * file, rather than at `publish` after a run has completed. Materialization checks the ACTUAL
 * computed format against the payload again; this is the early half of that pair, not a substitute
 * for it.
 */
export const PRESENTATION_BEARING_BUNDLE_FORMATS = [
  "benchmark-product-public-bundle/7",
] as const;

export interface SealReportPresentationInput {
  /** The parsed contents of the operator's payload file. */
  readonly payload: unknown;
  /** The slug the operator named on the command line. */
  readonly slug: string;
  /** This run's sealed Report identity pair. */
  readonly reportSha256: string;
  readonly reportEnvelopeSha256: string;
}

export interface SealedReportPresentation {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly presentation: ReportPresentation;
}

/**
 * Validates the supplied payload, binds it to this run, and seals it.
 *
 * A schema failure is a typed `validation` refusal naming the offending field rather than a thrown
 * zod error: the person writing a page about their own experiment should be told which field is
 * wrong, in the product's own error shape. A BINDING failure is `conflict`, because nothing about
 * the payload is malformed — it is a well-formed presentation of something else.
 */
export function sealReportPresentation(
  input: SealReportPresentationInput,
): SealedReportPresentation {
  const parsed = ReportPresentationSchema.safeParse(input.payload);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    refuse(
      "validation",
      `presentation.${issue?.path.join(".") ?? "(root)"}`,
      issue?.message ?? "report presentation is invalid",
    );
  }
  if (parsed.data.slug !== input.slug) {
    refuse(
      "conflict",
      "presentation.slug",
      `this payload presents "${parsed.data.slug}" but the publication slug named is "${input.slug}";`
      + " a presentation copied from another report has to be edited, not re-slugged at the command line",
    );
  }
  if (!(PRESENTATION_BEARING_BUNDLE_FORMATS as readonly string[]).includes(parsed.data.verification.bundleFormat)) {
    refuse(
      "conflict",
      "presentation.verification.bundleFormat",
      `no closure version other than ${PRESENTATION_BEARING_BUNDLE_FORMATS.join(", ")} carries`
      + ` ${REPORT_PRESENTATION_MEMBER}, so a payload declaring "${parsed.data.verification.bundleFormat}"`
      + " could never be published",
    );
  }
  // Canonical first, then derive: the projection's own encoding check then holds by construction,
  // and what is checked is exactly what will be sealed.
  const bytes = canonicalJsonBytes(parsed.data);
  let presentation: ReportPresentation;
  try {
    presentation = deriveReportPresentation({
      bytes,
      reportSha256: input.reportSha256,
      reportEnvelopeSha256: input.reportEnvelopeSha256,
      bundleFormat: parsed.data.verification.bundleFormat,
    });
  } catch (cause) {
    if (cause instanceof ReportPresentationProjectionError) {
      refuse("conflict", "presentation", cause.message);
    }
    throw cause;
  }
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), presentation };
}
