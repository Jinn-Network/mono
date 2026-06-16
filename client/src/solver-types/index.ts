/**
 * Single dispatch table for in-repo SolverTypes — jinn-mono-6q1.1.
 */

import { portfolioV0 } from './portfolio-v0.js';
import { predictionV1 } from './prediction-v1.js';
import { predictionApyV0 } from './prediction-apy-v0.js';
import { learnerLoopTest } from './learner-loop-test.js';
import { sweRebenchV2 } from './swe-rebench-v2.js';
import { jinnRepo } from './jinn-repo-definition.js';
import { sessionDerived } from './session-derived.js';
import type { SolverTypeDefinition } from './solver-type.js';

export type { ParsedSpecOverlay, ParseDeps, SolverTypeDefinition, TestnetAutoContext } from './solver-type.js';
export { PREDICTION_V1_KIND } from './constants.js';

/** Insertion order is stable for error messages and tests. */
export const SOLVER_TYPES: Record<string, SolverTypeDefinition<any>> = {
  'portfolio.v0': portfolioV0,
  'prediction.v1': predictionV1,
  'prediction.apy.v0': predictionApyV0,
  'learner-loop-test': learnerLoopTest,
  'swe-rebench-v2.v1': sweRebenchV2,
  'jinn-repo.v1': jinnRepo,
  'session-derived.v1': sessionDerived,
};

export function knownSolverTypes(): string[] {
  return Object.keys(SOLVER_TYPES);
}

export function unknownSolverTypeMessage(kind: string | undefined): string {
  const k = kind === undefined || kind === '' ? 'missing' : kind;
  return `unknown SolverType: ${k}; known SolverTypes: ${knownSolverTypes().join(', ')}`;
}

// `collectTestnetAutoTaskGenerators` was retired by Task 22 of
// spec/2026-05-05-solvernet-creation-and-launch.md — the daemon constructs
// generators from launched-record ownership instead of a config-block-keyed
// auto-task helper. SolverType-specific `getTestnetAutoConfig` definitions
// remain available for direct/test consumers.
