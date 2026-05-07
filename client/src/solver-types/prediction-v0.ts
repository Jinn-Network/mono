import {
  predictionV1TemplateNeedsReadCurrent,
  resolvePredictionV1Template,
} from './prediction-v0-template.js';
import { makePredictionV1Generator, type PredictionV1AutoConfig } from './prediction-v0-auto.js';
import type { SolverTypeDefinition } from './solver-type.js';
import { PREDICTION_V1_KIND } from './constants.js';

/**
 * Legacy Chainlink prediction.v1 SolverType — retained for spec parsing only.
 * This module is not registered in the SOLVER_TYPES dispatch table; the
 * Polymarket-driven `predictionV1` definition in `./prediction-v1.ts` is the
 * canonical entry. Task 22 of
 * spec/2026-05-05-solvernet-creation-and-launch.md retired the
 * `getTestnetAutoConfig` plumbing; existing test consumers wire
 * `makePredictionV1Generator` (the Chainlink-specific factory in
 * `./prediction-v0-auto.ts`) directly.
 */
export const legacyChainlinkPredictionV1: SolverTypeDefinition<PredictionV1AutoConfig> = {
  solverType: PREDICTION_V1_KIND,
  async parseSpec(raw, deps) {
    if (predictionV1TemplateNeedsReadCurrent(raw) && !deps?.readCurrent) {
      throw new Error(
        'prediction.v1 parseSpec requires readCurrent (Chainlink) when the template uses a current[±…] threshold sentinel',
      );
    }
    const task = await resolvePredictionV1Template(raw, {
      readCurrent: deps?.readCurrent,
    });
    return { window: task.window, spec: task.spec, eligibility: task.eligibility };
  },
  buildGenerator: (config) => makePredictionV1Generator(config),
  ui: {
    description: 'Price threshold prediction (Chainlink oracle)',
    category: 'prediction',
  },
};
