// SPDX-License-Identifier: Apache-2.0

import type {
  EvidenceRepository,
} from "@jinn-network/evidence-repository";

import type {
  ExecutionId,
  FinalizedExecutionReceipt,
} from "./types.js";

export type ExecutionProducerContractScenario =
  | "completed"
  | "failed"
  | "abandoned"
  | "interrupted-finalization";

export interface ExecutionProducerContractObservation {
  readonly executionId: ExecutionId;
  readonly workspaceDir: string;
  readonly captureStartedAt: string;
  readonly executorStartedAt: string;
  readonly repository: EvidenceRepository;
  readonly receipt: FinalizedExecutionReceipt;
  readonly expectedTaskBytes: Uint8Array;
  readonly expectedTraceBytes: Uint8Array;
  readonly expectedResultBytes?: Uint8Array;
  readonly cleanup?: () => Promise<void> | void;
}

export interface ExecutionProducerContractDriver {
  run(
    scenario: ExecutionProducerContractScenario,
  ): Promise<ExecutionProducerContractObservation>;
}
