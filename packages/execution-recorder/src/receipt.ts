// SPDX-License-Identifier: Apache-2.0

import type { FinalizedExecutionReceipt } from "./types.js";

export function copyFinalizedExecutionReceipt(
  receipt: FinalizedExecutionReceipt,
): FinalizedExecutionReceipt {
  return {
    executionId: receipt.executionId,
    record: {
      family: receipt.record.family,
      digest: receipt.record.digest,
    },
    artifacts: receipt.artifacts.map(({ digest }) => ({ digest })),
    finalizedAt: receipt.finalizedAt,
  };
}
