import { createEvaluatorDeployment } from '@jinn-network/task-execution-evaluator-adapters';
import type { EvaluationHarnessDeployment } from '@jinn-network/task-execution-evaluation-harness';
import type { EvaluatorConfig } from '../config.js';
import { EVALUATOR_SIGNER_GRANT_KEY } from './submission.js';
import { evaluatorSettings, operatorEvidenceWriter } from './settings.js';

export function createEvaluationHarnessDeployment(
  config?: Pick<EvaluatorConfig, 'maxClaimEvidenceBytes' | 'evaluatorAgentIri'>,
): EvaluationHarnessDeployment {
  const settings = evaluatorSettings(config);
  return createEvaluatorDeployment({
    evidenceWriter: operatorEvidenceWriter(),
    maxClaimEvidenceBytes: settings.maxClaimEvidenceBytes,
    signerHandle: EVALUATOR_SIGNER_GRANT_KEY,
    evaluatorId: settings.evaluatorAgentIri,
  });
}

/**
 * The deployment the evaluation-harness launcher spawns against. The adapters tree owns the
 * registrations and the parser allowlist; the host supplies only its evidence writer, its
 * signer handle, and its evaluator identity.
 */
export const evaluationHarnessDeployment: EvaluationHarnessDeployment =
  createEvaluationHarnessDeployment();
