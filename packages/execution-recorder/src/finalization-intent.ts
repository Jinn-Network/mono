// SPDX-License-Identifier: Apache-2.0

import type { Sha256Digest } from "@jinn-network/evidence-repository";

import type {
  JournalEvent,
  PersistedArtifactCapture,
  PersistedNativeTraceCapture,
  StoredObjectReference,
} from "./journal-types.js";
import { captureFingerprint } from "./persist-capture.js";

type FinalizationPrepared = Extract<
  JournalEvent,
  { type: "finalization-prepared" }
>;

export interface FinalizationIntentMaterial {
  readonly outcome: FinalizationPrepared["outcome"];
  readonly endedAt: string;
  readonly results: readonly PersistedArtifactCapture[];
  readonly nativeTrace: PersistedNativeTraceCapture;
  readonly finalizedAt: string;
  readonly metadata: StoredObjectReference;
  readonly artifactDigests: readonly Sha256Digest[];
}

export function finalizationIntentFingerprint(
  material: FinalizationIntentMaterial,
): Sha256Digest {
  return captureFingerprint("finalization", {
    outcome: material.outcome,
    endedAt: material.endedAt,
    results: material.results,
    nativeTrace: material.nativeTrace,
    finalizedAt: material.finalizedAt,
    metadata: material.metadata,
    artifactDigests: material.artifactDigests,
  });
}
