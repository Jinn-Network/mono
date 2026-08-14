/** Read-only product projection for the publication lifecycle.
 *
 * This deliberately projects workspace state, rather than probing a venue or a public URL. A
 * caller can therefore explain a pending/recoverable publication honestly without making a
 * backend call or accidentally treating a locator as proof of public availability.
 */

import type { LifecycleState } from "../domain/lifecycle.js";
import type { PublicationCompatibilityAssessment } from "./publication-compatibility.js";
import type { PublicationStage, PublicationState, RunState } from "./state.js";

export type PublicationStageName = "registration" | "accounting" | "matrix" | "report";
export interface PublicationStageStatus {
  readonly name: PublicationStageName;
  readonly state: PublicationStage["state"];
  readonly receipt?: { readonly sourceSequence: string; readonly entrySha256: string };
  readonly sourceCutoff?: { readonly sourceSequence: string; readonly entrySha256: string };
  readonly digests: Readonly<Record<string, string>>;
}
export interface PublicationStatusProjection {
  readonly mode: "local" | "prospective";
  /** The Run is an analysis commitment; public-registration timing is a separate assurance. */
  readonly analysisPreregistration: "not-locked" | "fixed-in-run";
  readonly registrationTiming: "not-registered" | "pending-verification" | "pre-dispatch" | "post-hoc";
  readonly publicBaseUrl?: string;
  readonly stages: readonly PublicationStageStatus[];
  readonly compatibility: PublicationCompatibilityAssessment;
  /** A closed managed run can publish registration/accounting later from retained evidence. */
  readonly postHocPublicationAvailable: boolean;
  readonly recovery: { readonly resumable: boolean; readonly guidance: string };
}

function stage(name: PublicationStageName, value: PublicationStage): PublicationStageStatus {
  return {
    name,
    state: value.state,
    ...(value.receipt === undefined ? {} : { receipt: value.receipt }),
    ...(value.sourceCutoff === undefined ? {} : { sourceCutoff: value.sourceCutoff }),
    digests: Object.fromEntries(Object.entries(value.digests ?? {}).sort(([left], [right]) => left.localeCompare(right))),
  };
}

export function projectPublicationStatus(input: {
  readonly state: RunState;
  readonly lifecycleState: LifecycleState;
  readonly compatibility: PublicationCompatibilityAssessment;
}): PublicationStatusProjection {
  const publication: PublicationState = input.state.publication ?? {
    mode: "local", source: { agentKeyRef: "unavailable", name: "unavailable" },
    registration: { state: "not-started" }, accounting: { state: "not-started" },
    matrixV2: { state: "not-started" }, report: { state: "not-started" },
  };
  const stages = [
    stage("registration", publication.registration), stage("accounting", publication.accounting),
    stage("matrix", publication.matrixV2), stage("report", publication.report),
  ];
  const closed = input.lifecycleState === "closed" || input.lifecycleState === "reported" || input.lifecycleState === "published-bundle";
  const registrationTiming = publication.registration.state === "not-started"
    ? "not-registered"
    : publication.registration.state === "in-progress" || publication.registration.receipt === undefined
      ? "pending-verification"
      : publication.registration.postHoc === true
        ? "post-hoc"
        : "pre-dispatch";
  const publicComplete = publication.registration.state === "complete"
    && publication.registration.receipt !== undefined
    && publication.accounting.state === "complete"
    && publication.accounting.receipt !== undefined
    && publication.matrixV2.state === "complete"
    && publication.matrixV2.receipt !== undefined;
  const unverifiedComplete = stages.some((candidate) => candidate.state === "complete" && candidate.receipt === undefined);
  const pending = stages.some((candidate) => candidate.state === "in-progress");
  return {
    mode: publication.mode ?? "local",
    analysisPreregistration: input.state.runSha256 === undefined ? "not-locked" : "fixed-in-run",
    registrationTiming,
    ...(publication.source.publicBaseUrl === undefined ? {} : { publicBaseUrl: publication.source.publicBaseUrl }),
    stages,
    compatibility: input.compatibility,
    postHocPublicationAvailable: closed && input.compatibility.status === "ready",
    recovery: unverifiedComplete
      ? { resumable: true, guidance: "A stage is marked complete without its durable receipt and remains unverified. Retry that stage; exact local bytes are retained and no timing assurance is claimed." }
      : pending
        ? { resumable: true, guidance: "A previous publication attempt was interrupted. Retry its stage; durable progress and exact bytes are retained locally." }
      : publicComplete
        ? { resumable: false, guidance: publication.report.state === "complete" ? "Accounting, Matrix, and Report publication are complete." : "Accounting and Matrix publication are complete. A Report is optional and remains separate." }
        : publication.registration.state === "complete"
          ? { resumable: false, guidance: "Public registration is complete; accounting has not yet completed." }
          : { resumable: false, guidance: "Publication remains local until you explicitly configure and register a public source." },
  };
}
