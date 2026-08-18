/** Catalog snapshot digest for Inspect eval. Not a HuggingFace git SHA. */
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { sha256Hex } from "../../workspace/sealed-store.js";

export interface InspectCatalog {
  readonly sampleIds: readonly (string | number)[];
  readonly specifiedEpochs: number;
  readonly epochsReducer?: string | null;
  readonly taskVersion?: string | null;
  readonly datasetName: string | null;
  readonly datasetLocation: string | null;
  readonly datasetSampleCount: number;
}

/**
 * Covers everything the drift re-probe must be able to detect, which is why the epochs
 * configuration is inside the digest rather than merely beside it:
 * `assertInspectSelectionUndrifted` compares this digest and nothing else, so any field the
 * digest omits is a field that can move between select and lock without refusing.
 * `specifiedEpochs` matters most — it is the eval's own declared k, the value
 * `officialInspectEvalConformance` judges the planned run against, and an eval can change it
 * without touching `eval.py`'s source digest.
 */
export function inspectCatalogSnapshotSha256(input: {
  readonly sampleIds: readonly (string | number)[];
  readonly taskSourceDigest: string;
  readonly specifiedEpochs: number;
  readonly epochsReducer: string | null;
  readonly taskVersion: string | null;
  readonly datasetName: string | null;
  readonly datasetLocation: string | null;
  readonly datasetSampleCount: number;
}): string {
  return sha256Hex(canonicalJsonBytes({
    sampleIds: [...input.sampleIds],
    taskSourceDigest: input.taskSourceDigest,
    specifiedEpochs: input.specifiedEpochs,
    epochsReducer: input.epochsReducer ?? null,
    taskVersion: input.taskVersion ?? null,
    datasetName: input.datasetName,
    datasetLocation: input.datasetLocation,
    datasetSampleCount: input.datasetSampleCount,
  } as never));
}
