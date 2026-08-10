import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
 * Per-operator sidecar the deployment module reads at import time, next to the module
 * itself (never git-committed -- see this repo's `.gitignore` -- and never published in
 * the npm tarball -- see `client/package.json`'s negated `files` entry). Not part of
 * `moduleDigest`: it carries only per-operator parameters (identity, evidence root),
 * not deployment logic. NOT upgrade-safe: `npm install -g @jinn-network/client@latest`
 * replaces this directory, deleting the sidecar with it -- re-run
 * `writePredictionEvaluatorSidecar` (or hand-author the file again) after every version
 * bump. See `docs/operator/native-evaluator-deployment.md` for why this is the sole
 * sidecar location (not also an `os.homedir()`-based one).
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

// --- swe-rebench-v2 (container-graded, one-swap M4c / #2467) --------------------------
//
// The container-graded sibling of the prediction module. Same committed-ES-module shape,
// same per-operator sidecar mechanism (identity + claim-evidence root), same digest
// helpers. The only structural difference is that its registration is CONTAINER-GRADED:
// the module constructs its own `containerGraderReportSource` over the Docker driver
// (`client/dist/daemon/native-evaluator-container-runtime.js`), the deployment-owned
// grader source a live host object could never hand across the spawned-child boundary
// (#2467 Finding P0-5-A). See `docs/operator/native-evaluator-deployment.md`.

export const SWE_REBENCH_EVALUATOR_DEPLOYMENT_MODULE_PATH = join(
  DEPLOYMENT_DIR,
  'swe-rebench-v2-deployment.mjs',
);

export const SWE_REBENCH_EVALUATOR_METHOD_DESCRIPTOR_PATH = join(
  DEPLOYMENT_DIR,
  'swe-rebench-v2-evaluation-method.v1.json',
);

/**
 * Per-operator sidecar the swe-rebench deployment module reads at import time, next to the
 * module itself. Governed by the same `.gitignore` / negated `files` exclusion as the
 * prediction sidecar (`*.local.json`), not part of `moduleDigest`, and NOT upgrade-safe --
 * re-run `writeSweRebenchEvaluatorSidecar` after every version bump. See the prediction
 * sidecar note above and `docs/operator/native-evaluator-deployment.md`.
 */
export const SWE_REBENCH_EVALUATOR_DEPLOYMENT_SIDECAR_PATH = join(
  DEPLOYMENT_DIR,
  'swe-rebench-v2-deployment.local.json',
);

/** sha256 of the swe-rebench deployment module's exact file bytes -- the config's `moduleDigest`. */
export async function sweRebenchEvaluatorModuleDigest(): Promise<`sha256:${string}`> {
  return documentDigest(await readFile(SWE_REBENCH_EVALUATOR_DEPLOYMENT_MODULE_PATH));
}

/** sha256 of the swe-rebench evaluation-method descriptor -- the config's `evaluationMethodDigest`. */
export async function sweRebenchEvaluatorMethodDigest(): Promise<`sha256:${string}`> {
  return documentDigest(await readFile(SWE_REBENCH_EVALUATOR_METHOD_DESCRIPTOR_PATH));
}

/**
 * Writes the per-operator sidecar the swe-rebench deployment module requires. Exposed for
 * tests and operator tooling (including re-creating it after an upgrade); the same effect
 * as hand-authoring the JSON file per `docs/operator/native-evaluator-deployment.md`.
 */
export async function writeSweRebenchEvaluatorSidecar(input: {
  readonly agent: string;
  readonly claimEvidenceDir?: string;
  readonly path?: string;
}): Promise<void> {
  const body: { agent: string; claimEvidenceDir?: string } = { agent: input.agent };
  if (input.claimEvidenceDir !== undefined) body.claimEvidenceDir = input.claimEvidenceDir;
  const path = input.path ?? SWE_REBENCH_EVALUATOR_DEPLOYMENT_SIDECAR_PATH;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`);
}

/**
 * Writes the per-operator sidecar file the deployment module requires. Exposed for
 * tests and for operator tooling (including re-creating it after an upgrade); the same
 * effect as hand-authoring the JSON file per
 * `docs/operator/native-evaluator-deployment.md`.
 */
export async function writePredictionEvaluatorSidecar(input: {
  readonly agent: string;
  readonly claimEvidenceDir?: string;
  readonly path?: string;
}): Promise<void> {
  const body: { agent: string; claimEvidenceDir?: string } = { agent: input.agent };
  if (input.claimEvidenceDir !== undefined) body.claimEvidenceDir = input.claimEvidenceDir;
  const path = input.path ?? PREDICTION_EVALUATOR_DEPLOYMENT_SIDECAR_PATH;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`);
}
