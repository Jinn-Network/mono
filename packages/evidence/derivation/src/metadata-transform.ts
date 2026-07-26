// SPDX-License-Identifier: Apache-2.0

import type { ExecutionEvidenceDocument } from "@jinn-network/evidence-protocol";

import type { SurfaceDispositionResult } from "./disposition.js";
import { setJsonPointer } from "./codecs/json.js";
import type { ValidatedDerivationSource } from "./source.js";
import type { SurfaceExtraction } from "./surfaces.js";
import type { DerivationHoldReason, DispositionCount } from "./types.js";

export type MetadataTransformationSet =
  | {
      readonly status: "transformed";
      readonly graph: ExecutionEvidenceDocument;
      readonly changed: boolean;
      readonly counts: readonly DispositionCount[];
    }
  | {
      readonly status: "review-required";
    }
  | {
      readonly status: "withhold-record";
      readonly reasons: readonly DerivationHoldReason[];
    };

export function transformSourceMetadata(
  source: ValidatedDerivationSource,
  extraction: SurfaceExtraction,
  results: ReadonlyMap<string, SurfaceDispositionResult>,
): MetadataTransformationSet {
  const graph = structuredClone(source.document);
  const counts: DispositionCount[] = [];
  let changed = false;
  for (const surface of extraction.surfaces.filter(({ surfaceId }) =>
    surfaceId.startsWith("metadata:"),
  )) {
    const result = results.get(surface.surfaceId);
    if (!result || result.status === "retained") continue;
    if (result.status === "review-required") {
      return { status: "review-required" };
    }
    if (result.status === "withhold-record") return result;
    if (result.status === "withhold-artifact") {
      return {
        status: "withhold-record",
        reasons: [{ code: "metadata-withheld" }],
      };
    }
    setJsonPointer(graph, surface.location, result.text);
    counts.push(...result.counts);
    changed = true;
  }
  return {
    status: "transformed",
    graph,
    changed,
    counts: Object.freeze(counts),
  };
}
