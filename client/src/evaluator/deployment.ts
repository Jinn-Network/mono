import {
  createEvaluatorDeployment,
  type EvaluatorDeploymentOptions,
} from "@jinn-network/task-execution-evaluator-adapters";
import type { EvaluationHarnessDeployment } from "@jinn-network/task-execution-evaluation-harness";

/**
 * The client keeps this facade inert until a native composition root supplies a trusted
 * deployment configuration. It intentionally has no defaults, environment lookup, signer grant,
 * launcher, or loop registration.
 */
export function createTrustedEvaluatorDeployment(
  config: EvaluatorDeploymentOptions,
): EvaluationHarnessDeployment {
  return createEvaluatorDeployment(config);
}
