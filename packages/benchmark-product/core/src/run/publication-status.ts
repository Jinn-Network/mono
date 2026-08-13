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
  readonly digests: readonly string[];
}
export interface PublicationStatusProjection {
  readonly mode: "local" | "prospective";
  /** The Run is an analysis commitment; public-registration timing is a separate assurance. */
  readonly analysisPreregistration: "not-locked" | "fixed-in-run";
  readonly registrationTiming: "not-registered" | "pre-dispatch" | "post-hoc";
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
    digests: Object.values(value.digests ?? {}).sort(),
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
  const inProgress = stages.some((candidate) => candidate.state === "in-progress");
  const closed = input.lifecycleState === "closed" || input.lifecycleState === "reported" || input.lifecycleState === "published-bundle";
  const registrationTiming = publication.registration.state === "not-started"
    ? "not-registered"
    : publication.registration.postHoc === true || (closed && (publication.mode ?? "local") === "local")
      ? "post-hoc"
      : "pre-dispatch";
  return {
    mode: publication.mode ?? "local",
    analysisPreregistration: input.state.runSha256 === undefined ? "not-locked" : "fixed-in-run",
    registrationTiming,
    ...(publication.source.publicBaseUrl === undefined ? {} : { publicBaseUrl: publication.source.publicBaseUrl }),
    stages,
    compatibility: input.compatibility,
    postHocPublicationAvailable: closed && input.state.publication !== undefined && input.compatibility.status === "ready",
    recovery: inProgress
      ? { resumable: true, guidance: "A previous publication attempt was interrupted. Retry its stage; durable receipts and exact bytes are retained locally." }
      : { resumable: false, guidance: "Publication remains local until you explicitly configure and register a public source." },
  };
}
