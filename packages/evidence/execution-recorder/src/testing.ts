// SPDX-License-Identifier: Apache-2.0

import type { EvidenceRepository } from "@jinn-network/evidence-repository";
import {
  describe,
  expect,
  test,
} from "vitest";

import { verifyExecutionProducerContractObservation } from "./producer-contract-verifier.js";
import type {
  ExecutionId,
  FinalizedExecutionReceipt,
} from "./types.js";

export type CompletedExecutionProducerContractScenario = "completed";
export type FailedExecutionProducerContractScenario = "failed";
export type AbandonedExecutionProducerContractScenario = "abandoned";
export type InterruptedFinalizationExecutionProducerContractScenario =
  "interrupted-finalization";

export type ExecutionProducerContractScenario =
  | CompletedExecutionProducerContractScenario
  | FailedExecutionProducerContractScenario
  | AbandonedExecutionProducerContractScenario
  | InterruptedFinalizationExecutionProducerContractScenario;

export type ExecutionProducerContractFinalizedScenario =
  | CompletedExecutionProducerContractScenario
  | FailedExecutionProducerContractScenario
  | AbandonedExecutionProducerContractScenario;

export interface ExecutionProducerContractResult {
  readonly repository: EvidenceRepository;
  readonly receipt: FinalizedExecutionReceipt;
}

interface ExecutionProducerContractObservationBase {
  readonly scenario: ExecutionProducerContractScenario;
  readonly executionId: ExecutionId;
  readonly workspaceDir: string;
  readonly captureStartedAt: string;
  readonly executorStartedAt: string;
  readonly expectedTaskBytes: Uint8Array;
  readonly expectedTraceBytes: Uint8Array;
  readonly cleanup?: () => Promise<void> | void;
}

interface ExecutionProducerContractFinalizedObservationBase
  extends ExecutionProducerContractObservationBase,
    ExecutionProducerContractResult {}

export interface CompletedExecutionProducerContractObservation
  extends ExecutionProducerContractFinalizedObservationBase {
  readonly scenario: CompletedExecutionProducerContractScenario;
  readonly expectedResultBytes: Uint8Array;
}

export interface FailedExecutionProducerContractObservation
  extends ExecutionProducerContractFinalizedObservationBase {
  readonly scenario: FailedExecutionProducerContractScenario;
  readonly expectedResultBytes?: Uint8Array;
}

export interface AbandonedExecutionProducerContractObservation
  extends ExecutionProducerContractFinalizedObservationBase {
  readonly scenario: AbandonedExecutionProducerContractScenario;
  readonly expectedResultBytes?: Uint8Array;
}

export interface InterruptedFinalizationExecutionProducerContractObservation
  extends ExecutionProducerContractFinalizedObservationBase {
  readonly scenario: InterruptedFinalizationExecutionProducerContractScenario;
  readonly expectedResultBytes: Uint8Array;
}

export type ExecutionProducerContractFinalizedObservation =
  | CompletedExecutionProducerContractObservation
  | FailedExecutionProducerContractObservation
  | AbandonedExecutionProducerContractObservation;

export type ExecutionProducerContractObservation =
  | ExecutionProducerContractFinalizedObservation
  | InterruptedFinalizationExecutionProducerContractObservation;

export type ExecutionProducerContractFinalizationInterruption = () => never;

export interface ExecutionProducerContractDriver {
  run(
    scenario: ExecutionProducerContractFinalizedScenario,
  ): Promise<ExecutionProducerContractFinalizedObservation>;

  runUntilFinalizationInterrupted(
    interruptFinalization: ExecutionProducerContractFinalizationInterruption,
  ): Promise<never>;

  recoverFinalization(): Promise<InterruptedFinalizationExecutionProducerContractObservation>;
}

export type ExecutionProducerContractDriverFactory = () =>
  | ExecutionProducerContractDriver
  | Promise<ExecutionProducerContractDriver>;

export function describeExecutionProducerContract(
  driverFactory: ExecutionProducerContractDriverFactory,
): void {
  describe("ExecutionProducerContract", () => {
    test.each<ExecutionProducerContractFinalizedScenario>([
      "completed",
      "failed",
      "abandoned",
    ])("satisfies the %s scenario", async (scenario) => {
      const driver = await driverFactory();
      const observation = await driver.run(scenario);
      try {
        await verifyExecutionProducerContractObservation(
          scenario,
          observation,
        );
      } finally {
        await observation.cleanup?.();
      }
    });

    test(
      "surfaces an injected finalization interruption before recovering",
      async () => {
        const driver = await driverFactory();
        const injectedInterruption = new Error(
          "execution producer contract finalization interruption",
        );
        let interruptionCount = 0;

        await expect(
          driver.runUntilFinalizationInterrupted(() => {
            interruptionCount += 1;
            throw injectedInterruption;
          }),
        ).rejects.toBe(injectedInterruption);
        expect(interruptionCount).toBe(1);

        const recoveredObservation = await driver.recoverFinalization();
        try {
          await verifyExecutionProducerContractObservation(
            "interrupted-finalization",
            recoveredObservation,
          );
        } finally {
          await recoveredObservation.cleanup?.();
        }
      },
    );
  });
}
