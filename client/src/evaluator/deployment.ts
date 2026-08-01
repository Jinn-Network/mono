import { createEvaluatorDeployment } from '@jinn-network/task-execution-evaluator-adapters';
import type { EvaluationHarnessDeployment } from '@jinn-network/task-execution-evaluation-harness';
import { EVALUATOR_SIGNER_GRANT_KEY } from './submission.js';
import { evaluatorSettings, operatorEvidenceWriter } from './settings.js';

/**
 * The deployment the evaluation-harness launcher spawns against. The adapters tree owns the
 * registrations and the parser allowlist; the host supplies only its evidence writer, its
 * signer handle, and its evaluator identity.
 */
export const evaluationHarnessDeployment: EvaluationHarnessDeployment =
  createEvaluatorDeployment({
    evidenceWriter: operatorEvidenceWriter(),
    maxClaimEvidenceBytes: evaluatorSettings().maxClaimEvidenceBytes,
    signerHandle: EVALUATOR_SIGNER_GRANT_KEY,
    evaluatorId: evaluatorSettings().evaluatorAgentIri,
  });
