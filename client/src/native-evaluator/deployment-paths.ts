import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { documentDigest } from '@jinn-network/task-execution-protocol';

/**
 * Paths and digest helpers for the committed production evaluator deployment module
 * (`client/deployments/evaluator/`). The module ships as a plain committed ES module,
 * not a tsc build artifact -- its bytes (and therefore its `moduleDigest`) are exactly
 * what is in git, computable without a build step. See
 * `docs/operator/native-evaluator-deployment.md` for the operational path and why.
 *
 * This file resolves the deployment directory relative to its own compiled location so
 * the same relative depth (two directories below `client/`) works from both
 * `client/src/native-evaluator/` (ts-node/tsx dev path) and `client/dist/native-evaluator/`
 * (the built, published package).
 */
const DEPLOYMENT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'deployments', 'evaluator');

export const PREDICTION_EVALUATOR_DEPLOYMENT_MODULE_PATH = join(
  DEPLOYMENT_DIR,
  'prediction-market-deployment.mjs',
);

export const PREDICTION_EVALUATOR_METHOD_DESCRIPTOR_PATH = join(
  DEPLOYMENT_DIR,
  'prediction-market-evaluation-method.v1.json',
);

/**
 * Per-operator sidecar the deployment module reads at import time (never git-committed --
 * see this repo's `.gitignore` and `docs/operator/native-evaluator-deployment.md`). Not
 * part of `moduleDigest`: it carries only per-operator parameters (identity, evidence
 * root), not deployment logic.
 */
export const PREDICTION_EVALUATOR_DEPLOYMENT_SIDECAR_PATH = join(
  DEPLOYMENT_DIR,
  'prediction-market-deployment.local.json',
);

/** sha256 of the deployment module's exact file bytes -- the config's `moduleDigest`. */
export async function predictionEvaluatorModuleDigest(): Promise<`sha256:${string}`> {
  return documentDigest(await readFile(PREDICTION_EVALUATOR_DEPLOYMENT_MODULE_PATH));
}

/** sha256 of the evaluation-method descriptor -- the config's `evaluationMethodDigest`. */
export async function predictionEvaluatorMethodDigest(): Promise<`sha256:${string}`> {
  return documentDigest(await readFile(PREDICTION_EVALUATOR_METHOD_DESCRIPTOR_PATH));
}

/**
 * Writes the per-operator sidecar file the deployment module requires. Exposed for
 * tests and for operator tooling; the same effect as hand-authoring the JSON file per
 * `docs/operator/native-evaluator-deployment.md`.
 */
export async function writePredictionEvaluatorSidecar(input: {
  readonly agent: string;
  readonly claimEvidenceDir?: string;
}): Promise<void> {
  const body: { agent: string; claimEvidenceDir?: string } = { agent: input.agent };
  if (input.claimEvidenceDir !== undefined) body.claimEvidenceDir = input.claimEvidenceDir;
  await writeFile(PREDICTION_EVALUATOR_DEPLOYMENT_SIDECAR_PATH, `${JSON.stringify(body, null, 2)}\n`);
}
