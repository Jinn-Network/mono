// SPDX-License-Identifier: MIT
import type { EvidenceIndexerCheckpointStore } from "@jinn-network/evidence-discovery";

import type { LocalOperationsStore } from "./operations-store.js";

export function createGenerationCheckpointStore(options: {
  readonly operations: LocalOperationsStore;
  readonly generationId: string;
}): EvidenceIndexerCheckpointStore {
  return {
    async get(sourceId) {
      return options.operations.getCheckpoint(options.generationId, sourceId);
    },
    async put() {
      throw new Error(
        "Generation checkpoints advance only with a durable indexing outcome.",
      );
    },
  };
}
