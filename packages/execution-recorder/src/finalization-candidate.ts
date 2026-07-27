// SPDX-License-Identifier: Apache-2.0

import { validateExecutionEvidence } from "@jinn-network/evidence-protocol";
import type { Sha256Digest } from "@jinn-network/evidence-repository";

import { finalizationIntentFingerprint } from "./finalization-intent.js";
import {
  buildExecutionEvidence,
  type ExecutionEvidenceMapperInput,
} from "./graph.js";
import { objectDigest } from "./object-store.js";

export interface FinalizationCandidate {
  readonly intentFingerprint: Sha256Digest;
  readonly metadataBytes: Uint8Array;
  readonly metadata: {
    readonly digest: Sha256Digest;
    readonly size: number;
  };
  readonly artifactDigests: readonly Sha256Digest[];
  readonly validation: ReturnType<typeof validateExecutionEvidence>;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function buildFinalizationCandidate(
  input: ExecutionEvidenceMapperInput,
): FinalizationCandidate {
  const metadataBytes = buildExecutionEvidence(input);
  const validation = validateExecutionEvidence(metadataBytes);
  const artifactDigests =
    validation.value === undefined
      ? []
      : [
          ...new Set(
            validation.value["@graph"]
              .filter(
                (entity) =>
                  entity["@id"] !== "ro-crate-metadata.json",
              )
              .map((entity) =>
                typeof entity.sha256 === "string"
                  ? (`sha256:${entity.sha256}` as Sha256Digest)
                  : null,
              )
              .filter(
                (digest): digest is Sha256Digest => digest !== null,
              ),
          ),
        ].sort(compareStrings);
  const metadata = {
    digest: objectDigest(metadataBytes),
    size: metadataBytes.byteLength,
  };
  return {
    intentFingerprint: finalizationIntentFingerprint({
      outcome: input.outcome,
      endedAt: input.endedAt,
      results: input.results,
      nativeTrace: input.nativeTrace,
      finalizedAt: input.finalizedAt,
      metadata,
      artifactDigests,
    }),
    metadataBytes,
    metadata,
    artifactDigests,
    validation,
  };
}
