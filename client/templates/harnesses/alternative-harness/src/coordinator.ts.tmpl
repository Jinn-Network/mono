import type {
  HarnessContext,
  Solution,
} from '@jinn-network/sdk/harness';
import type { HarnessAdapter } from './harness.js';
import { runOrient } from './phases/orient.js';
import { runStrategize } from './phases/strategize.js';
import { runPlan } from './phases/plan.js';
import { runExecute } from './phases/execute.js';
import { runDebrief } from './phases/debrief.js';
import { runImprove } from './phases/improve.js';
import { runMemory } from './phases/memory.js';

export interface CoordinatorArgs {
  ctx: HarnessContext;
  harness: HarnessAdapter;
}

/**
 * Sequence the seven phases (orient, strategize, plan, execute,
 * debrief, improve, memory). Mirrors `spec/2026-04-30-plug-in-surface.md`
 * §3.3.3 and `docs/superpowers/specs/2026-04-23-default-learning-harness-design.md` §2.
 */
export async function runCoordinator({
  ctx,
  harness,
}: CoordinatorArgs): Promise<Solution> {
  const orient = await runOrient({ ctx, harness });
  const strategy = await runStrategize({ ctx, harness, orient });
  const plan = await runPlan({ ctx, harness, strategy, orient });
  const execute = await runExecute({ ctx, harness, plan, strategy });
  const debrief = await runDebrief({ ctx, harness, execute, strategy });
  await runImprove({ ctx, harness, debrief });
  await runMemory({ ctx, harness, debrief });

  return {
    venueRef: { name: harness.name },
    gating: {
      timingPosture: strategy.timingPosture,
      executeReturnReason: execute.returnReason,
      debriefVerdict: debrief.successCriteriaMet,
    },
    informational: {
      strategyApproach: strategy.approach,
      planSteps: plan.steps.length,
      stepsCompleted: execute.stepsCompleted.length,
      stepsFailed: execute.stepsFailed.length,
    },
  };
}
