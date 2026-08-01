// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import type { CorpusMirror } from "../../corpus/index.js";
import type { RuntimeLogger } from "../../logger.js";
import { runPickup as defaultRunPickup } from "../../pickup.js";
import type { ProjectionResult } from "../../projection/project.js";
import type { AdmissionFilter } from "../../relevance/admission.js";
import type { RelevanceIndex } from "../../relevance/index.js";
import { type ToolResponse, toolJson } from "../result.js";

export const pickupInputShape = {
  message: z
    .string()
    .min(1)
    .max(8000)
    .describe("The turn's user message. Search terms are derived from it."),
  repositorySlug: z.string().max(200).optional().describe("owner/name of the repository under work."),
  planes: z.array(z.enum(["local", "public"])).min(1).optional(),
  maxChars: z.number().int().min(200).max(20_000).optional(),
  maxRecords: z.number().int().min(1).max(10).optional(),
} as const;

export type PickupArgs = z.infer<z.ZodObject<typeof pickupInputShape>>;

export interface PickupDeps {
  readonly index: RelevanceIndex;
  readonly admission: AdmissionFilter;
  readonly mirror?: CorpusMirror;
  readonly log: RuntimeLogger;
  /** Test seam. Production passes C6's `runPickup`. */
  readonly runPickup?: typeof defaultRunPickup;
}

export const PICKUP_DESCRIPTION =
  "Build the first-turn evidence projection for a session. Adapter-facing: the host's model loop never calls this.";

/**
 * Contract 5: pickup serves the mirror as it stands and never waits on a sync.
 * The sync is kicked afterwards, unawaited and unbounded by this call; C5's
 * `syncOnce` returns `skipped-locked` immediately when the advisory lock is
 * held, so concurrent sessions never queue behind one another.
 */
function kickSync(deps: PickupDeps): void {
  if (!deps.mirror) return;
  void Promise.resolve()
    .then(() => deps.mirror?.syncOnce())
    .then((outcome) => {
      if (outcome) deps.log.debug(`mirror sync ${outcome.status}`);
    })
    .catch((error: unknown) => {
      deps.log.warn(
        `mirror sync failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
}

export async function handlePickup(deps: PickupDeps, args: PickupArgs): Promise<ToolResponse> {
  const run = deps.runPickup ?? defaultRunPickup;
  let result: ProjectionResult | undefined;
  try {
    result = await run(
      { index: deps.index, admission: deps.admission },
      {
        message: args.message,
        ...(args.repositorySlug ? { repositorySlug: args.repositorySlug } : {}),
        ...(args.planes ? { planes: args.planes } : {}),
        ...(args.maxChars !== undefined || args.maxRecords !== undefined
          ? {
              budget: {
                ...(args.maxChars !== undefined ? { maxChars: args.maxChars } : {}),
                ...(args.maxRecords !== undefined ? { maxRecords: args.maxRecords } : {}),
              },
            }
          : {}),
      },
    );
  } catch (error) {
    // Retrieval absence is fail-open (contract 1): work proceeds untouched.
    deps.log.warn(
      `pickup unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    kickSync(deps);
    return toolJson({ status: "unavailable", terms: [], recordCount: 0, text: "" });
  }
  kickSync(deps);
  return toolJson({
    status: result.status,
    terms: result.terms,
    recordCount: result.records.length,
    usedChars: result.usedChars,
    text: result.text,
  });
}
