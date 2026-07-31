// SPDX-License-Identifier: Apache-2.0
import type { AdmissionFilter } from "./relevance/admission.js";
import type { RelevanceIndex } from "./relevance/index-store.js";
import type { EvidencePlane } from "./relevance/planes.js";
import { RELEVANCE_FLOOR } from "./relevance/search.js";
import { deriveSearchTerms, discriminatingTerms } from "./relevance/terms.js";
import {
  DEFAULT_PROJECTION_MAX_RECORDS,
  projectContext,
  type ProjectionBudget,
  type ProjectionResult,
} from "./projection/project.js";

export interface PickupDeps {
  readonly index: RelevanceIndex;
  readonly admission: AdmissionFilter;
}

export interface PickupRequest {
  /** The session's first message. */
  readonly message: string;
  readonly repositorySlug?: string;
  readonly planes?: readonly EvidencePlane[];
  readonly budget?: ProjectionBudget;
  readonly maxTerms?: number;
  readonly floor?: number;
}

/**
 * First-turn pickup: derive terms, search both planes, admit the selected handful, and
 * project the survivors.
 *
 * The search vocabulary and the scoring vocabulary differ by exactly one term — the
 * repository name — and the split lives here, at the call site where the policy is, rather
 * than hidden inside the matcher.
 *
 * Selection happens *before* admission and not inside `projectContext`, which is the whole
 * point of the ruling: admission is asked over the couple of records that are actually
 * about to enter the model's context, never over the index and never over the full result
 * set. A rejected candidate is dropped rather than backfilled from rank N+1 — being
 * ranked highly is not a claim to be trusted, and silently promoting the next record would
 * make a rejection invisible.
 */
export async function runPickup(
  deps: PickupDeps,
  request: PickupRequest,
): Promise<ProjectionResult> {
  const searchTerms = deriveSearchTerms(
    request.message,
    request.repositorySlug,
    request.maxTerms,
  );
  const scoringTerms = discriminatingTerms(searchTerms, request.repositorySlug);

  if (scoringTerms.length === 0) {
    return projectContext([], searchTerms, request.budget);
  }

  const candidates = await deps.index.search({
    terms: scoringTerms,
    floor: request.floor ?? RELEVANCE_FLOOR,
    ...(request.planes === undefined ? {} : { planes: request.planes }),
  });

  const selected = candidates.slice(
    0,
    request.budget?.maxRecords ?? DEFAULT_PROJECTION_MAX_RECORDS,
  );
  const admitted = await deps.admission.admit(selected);

  return projectContext(admitted, searchTerms, request.budget);
}
