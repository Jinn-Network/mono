// SPDX-License-Identifier: MIT

/**
 * Reports (product design §6.1, §6.3; program ruling R3).
 *
 * > Reports produced through the method registry […] New statistics a campaign needs (e.g. a bandit
 * > posterior) land as named methods in the benchmarking registry with reference implementations, so
 * > policy-value estimates stay third-party recomputable.
 *
 * So this file computes nothing. It resolves one of the campaign's declared objective methods,
 * hands `produceReport` the exact Matrix bytes, and gets back a signed Report. The only thing it
 * adds is the refusal that keeps the campaign honest: a method the *campaign* did not declare
 * cannot be reported on through this path. Without that, an owner who did not like the objective's
 * answer could produce a Report under a different method and journal it against the same campaign.
 */

import {
  BENCHMARKING_METHOD_REGISTRY,
  produceReport,
  type DsseSigner,
  type MethodPorts,
  type ProducedReport,
} from "@jinn-network/benchmarking-aggregate";
import { refuse } from "./errors.js";
import type { CampaignDocument, ObjectiveMethodRef } from "./types.js";

/** `benchmarking-aggregate`'s contract-wide verdict reduction, named where a caller must choose one. */
export type WaveVerdictRule = "sole" | "unanimous" | "any-pass" | "majority";

export interface WaveReportInput {
  readonly campaign: CampaignDocument;
  /** Which of the campaign's objective methods to report under. Must be one of them, exactly. */
  readonly method: Pick<ObjectiveMethodRef, "id" | "version">;
  /** Exact canonical Matrix bytes, in Report subject order. */
  readonly subjects: readonly Uint8Array[];
  readonly verdictRule: WaveVerdictRule;
  readonly author: string;
  readonly resolve: Omit<MethodPorts, "registry"> & Partial<Pick<MethodPorts, "registry">>;
  readonly limitations?: readonly string[];
}

/** The campaign's declared reference for a method, or a refusal naming what it does declare. */
export function objectiveMethod(
  campaign: CampaignDocument,
  method: Pick<ObjectiveMethodRef, "id" | "version">,
): ObjectiveMethodRef {
  const declared = campaign.objective.methods.find(
    (candidate) => candidate.id === method.id && candidate.version === method.version,
  );
  if (declared === undefined) {
    refuse("invalid-document", "objective.methods",
      `${method.id}@${method.version} is not one of this campaign's objective methods (${campaign.objective.methods.map((entry) => `${entry.id}@${entry.version}`).join(", ")}); a Report under an undeclared method is not a Report about this campaign's objective`);
  }
  return declared;
}

/**
 * Produces one signed Report over the wave's Matrix.
 *
 * `preregistered` is **not** an argument and never could be: `produceReport` derives it by comparing
 * the resolved Runs' `analysisPlan` against the method it actually computed. A development wave
 * seals no analysis plan and therefore derives `false`; the promotion Run seals the objective and
 * derives `true`. §6.2's "labeled exploratory by construction" is that derivation, not a flag this
 * package sets.
 */
export async function produceWaveReport(
  input: WaveReportInput,
  signer: DsseSigner,
): Promise<ProducedReport> {
  const declared = objectiveMethod(input.campaign, input.method);
  if (input.subjects.length === 0) {
    refuse("invalid-document", "subjects", "a Report over no subjects reports nothing");
  }
  return produceReport({
    subjects: input.subjects,
    method: { id: declared.id, version: declared.version, parameters: { ...declared.parameters } },
    verdictRule: input.verdictRule,
    author: input.author,
    resolveVerdictBytes: input.resolve.resolveVerdictBytes,
    resolveRunBytes: input.resolve.resolveRunBytes,
    resolveTaskBytes: input.resolve.resolveTaskBytes,
    ...(input.resolve.resolveAnchoredBenchmarkAnnouncement === undefined
      ? {}
      : { resolveAnchoredBenchmarkAnnouncement: input.resolve.resolveAnchoredBenchmarkAnnouncement }),
    ...(input.resolve.verifyAnchoredBenchmarkAnnouncement === undefined
      ? {}
      : { verifyAnchoredBenchmarkAnnouncement: input.resolve.verifyAnchoredBenchmarkAnnouncement }),
    registry: input.resolve.registry ?? BENCHMARKING_METHOD_REGISTRY,
    ...(input.limitations === undefined ? {} : { limitations: input.limitations }),
  }, signer);
}

export type { DsseSigner, ProducedReport };
