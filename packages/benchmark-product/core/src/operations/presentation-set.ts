/**
 * `presentation set` and `presentation show`: the operation that seals this run's reader-facing
 * page copy, and the read-back.
 *
 * Four disciplines, each one the reason this is an operation rather than a flag on `publish`:
 *
 * - **The subject is a sealed REPORT, so the window opens at report.** The payload names the Report
 *   and Report-envelope digests it presents, and those do not exist before `run.report`. Setting
 *   earlier would have nothing to name.
 * - **The window never closes, and that is the deliberate difference from every neighbouring
 *   operation.** `anchor` is write-once because it is third-party evidence. `disclosure declare`
 *   refuses after `report` because its record is projected into the sealed claim, so a later
 *   declaration could never enter the claim a bundle carries. A presentation is neither: it enters
 *   no claim, no signed envelope, and no evidence catalog, and nothing verifies against it. It is
 *   display copy, and the report it presents is finished before anyone can write it. Refusing after
 *   `report` would make the member unusable for the only thing it is for.
 * - **Changing it is loud, not silent.** The member is an ordinary manifest entry, so its bytes are
 *   inside the bundle digest. Re-setting a presentation and republishing produces a DIFFERENT
 *   bundle identity, at a different digest-addressed path, leaving the previously published one
 *   exactly as it was. That is the honest signal, and it is the whole reason this is safe to allow
 *   after publication: nothing already published can change under a reader.
 * - **Nothing derivable is stored.** RunState records the record's digest and nothing else. Every
 *   fact about the presentation — its slug, its title, the report it names — is read back from the
 *   sealed bytes.
 */

import { refuse } from "../errors.js";
import { sealReportPresentation } from "../presentation/state.js";
import { requireRunState, writeRunState } from "../run/state.js";
import { getSealedBytes, putSealedBytes } from "../workspace/sealed-store.js";
import type { OperationContext } from "./context.js";
import { operate } from "./operate.js";
import type { OperationResult } from "./result.js";
import { ReportPresentationSchema } from "@colophon-claims/verify";

export interface PresentationSetInput {
  readonly draftId: string;
  /** The publication slug this presentation is for. Must equal the payload's own `slug`. */
  readonly slug: string;
  /** The parsed payload, in the shape `ReportPresentationSchema` accepts. */
  readonly presentation: unknown;
}

export interface PresentationSetResult {
  readonly recordSha256: string;
  readonly slug: string;
  readonly title: string;
  readonly reportSha256: string;
  readonly bundleFormat: string;
  /** True when this call replaced an earlier presentation on the same run. */
  readonly replaced: boolean;
}

/** Seals this run's report presentation and records its digest. Gated like every other operation;
 * see `../authority/policy.ts`. */
export function presentationSet(
  context: OperationContext,
  input: PresentationSetInput,
): OperationResult<PresentationSetResult> {
  return operate({
    context,
    action: "presentation.set",
    subject: input.draftId,
    inputs: { draftId: input.draftId, slug: input.slug },
    run: () => {
      const state = requireRunState(context.workspaceDir, input.draftId);
      if (state.reportSha256 === undefined || state.reportEnvelopeSha256 === undefined) {
        refuse(
          "illegal-transition",
          `runs.${input.draftId}.reportSha256`,
          "a presentation names the sealed Report it presents; report this run before presenting it",
        );
      }
      const sealed = sealReportPresentation({
        payload: input.presentation,
        slug: input.slug,
        reportSha256: state.reportSha256,
        reportEnvelopeSha256: state.reportEnvelopeSha256,
      });
      putSealedBytes(context.workspaceDir, sealed.bytes);
      const replaced = state.presentationSha256 !== undefined && state.presentationSha256 !== sealed.sha256;
      writeRunState(context.workspaceDir, input.draftId, {
        ...state,
        presentationSha256: sealed.sha256,
      });
      return {
        recordSha256: sealed.sha256,
        slug: sealed.presentation.slug,
        title: sealed.presentation.title,
        reportSha256: sealed.presentation.provenance.reportSha256,
        bundleFormat: sealed.presentation.verification.bundleFormat,
        replaced,
      };
    },
  });
}

export interface PresentationShowResult {
  readonly recordSha256: string;
  readonly slug: string;
  readonly title: string;
  readonly schema: string;
  readonly reportSha256: string;
  readonly bundleFormat: string;
}

/**
 * Reads the sealed presentation back. Every field returned is parsed out of the stored bytes — this
 * is a view of the record, not of any product state that might have drifted from it.
 */
export function presentationShow(
  context: OperationContext,
  input: { readonly draftId: string },
): OperationResult<PresentationShowResult> {
  return operate({
    context,
    action: "presentation.show",
    subject: input.draftId,
    inputs: input,
    run: () => {
      const state = requireRunState(context.workspaceDir, input.draftId);
      if (state.presentationSha256 === undefined) {
        refuse("not-found", `runs.${input.draftId}.presentationSha256`, "this run has no report presentation");
      }
      const bytes = getSealedBytes(context.workspaceDir, state.presentationSha256);
      const record = ReportPresentationSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
      return {
        recordSha256: state.presentationSha256,
        slug: record.slug,
        title: record.title,
        schema: record.schema,
        reportSha256: record.provenance.reportSha256,
        bundleFormat: record.verification.bundleFormat,
      };
    },
  });
}
