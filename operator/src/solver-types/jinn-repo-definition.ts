/**
 * SolverTypeDefinition for jinn-repo.v1 — registration only (G1).
 *
 * Tasks are real merged Jinn-Network/mono PRs. The corpus, evaluator, admission
 * gate, and pool/slate loaders ship separately; this file only makes the daemon
 * recognise `jinn-repo.v1` across the SolverType registry. The generator is a
 * stub until G4.
 *
 * The bare task schema stays in `./jinn-repo.ts`; the generator lives in
 * `./jinn-repo-auto.ts` (G4) so the generator/slate wiring does not create an
 * import cycle with those supporting modules.
 */

import { JinnRepoTaskSchema } from './jinn-repo.js';
import { loadHeldOutSlate } from './_swe-rebench-v2-held-out-slate.js';
import { makeJinnRepoGenerator, type JinnRepoGeneratorConfig } from './jinn-repo-auto.js';
import type { SolverTypeDefinition } from './solver-type.js';

const SOLVER_TYPE = 'jinn-repo.v1';

export const jinnRepo: SolverTypeDefinition<JinnRepoGeneratorConfig> = {
  solverType: SOLVER_TYPE,
  async parseSpec(raw) {
    const task = JinnRepoTaskSchema.parse(raw);
    return {
      window: undefined,
      spec: task,
      eligibility: {},
    };
  },
  buildGenerator: (config) => makeJinnRepoGenerator(config),
  loadHeldOutSlate: (version) => loadHeldOutSlate(SOLVER_TYPE, version),
  ui: {
    description: 'Real merged Jinn-Network/mono PRs',
    category: 'code',
  },
};
