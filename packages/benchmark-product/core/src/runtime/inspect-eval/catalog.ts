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

export function inspectCatalogSnapshotSha256(input: {
  readonly sampleIds: readonly (string | number)[];
  readonly taskSourceDigest: string;
  readonly datasetName: string | null;
  readonly datasetLocation: string | null;
  readonly datasetSampleCount: number;
}): string {
  return sha256Hex(canonicalJsonBytes({
    sampleIds: [...input.sampleIds],
    taskSourceDigest: input.taskSourceDigest,
    datasetName: input.datasetName,
    datasetLocation: input.datasetLocation,
    datasetSampleCount: input.datasetSampleCount,
  } as never));
}
