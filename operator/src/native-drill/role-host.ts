// operator/src/native-drill/role-host.ts
/**
 * The role-host program one restart-drill child process runs (#2434).
 *
 * The driver launches this three times per checkpoint — once uninterrupted, once to be killed at
 * the boundary, once to recover — always as a real OS process. The child never decides its own
 * fate: at the boundary it prints the marker and then waits forever, so the parent's SIGKILL is
 * what ends it. That is the difference between this drill and an in-process failure injection.
 */
import { z } from 'zod/v3';
import { PHASE_B_RESTART_CHECKPOINT_SET } from '../daemon/phase-b-closure-manifest.js';
import { createAnvilDrillChain } from './chain.js';
import { RunObservationSchema, type RunObservation } from './observation.js';
import { runPostingScenario } from './scenarios/posting.js';
import { runClaimScenario } from './scenarios/claim.js';
import { runSolutionScenario } from './scenarios/solution.js';
import { runVerdictScenario } from './scenarios/verdict.js';
import type { ScenarioContext, ScenarioMode } from './scenarios/support.js';

/** Printed on stdout the instant the child reaches the injected boundary. */
export const BOUNDARY_MARKER = '@@JINN-DRILL-BOUNDARY';
/** Printed on stdout, followed by the observation JSON, when a run completes. */
export const OBSERVATION_MARKER = '@@JINN-DRILL-OBSERVATION';

export const RoleRunSpecSchema = z.object({
  checkpoint: z.enum(PHASE_B_RESTART_CHECKPOINT_SET),
  seed: z.string().min(1),
  runId: z.string().min(1),
  stateDir: z.string().min(1),
  mode: z.enum(['uninterrupted', 'crash', 'resume']),
  rpcUrl: z.string().url(),
}).strict();

export type RoleRunSpec = z.infer<typeof RoleRunSpecSchema>;

function scenarioFor(checkpoint: RoleRunSpec['checkpoint']) {
  switch (checkpoint) {
    case 'posting': return runPostingScenario;
    case 'claim': return runClaimScenario;
    case 'backend-submit':
    case 'evidence':
    case 'solution-settlement':
      return (context: ScenarioContext) => runSolutionScenario(context, checkpoint);
    case 'verdict-settlement': return runVerdictScenario;
  }
}

/**
 * Run one role host to completion, or to the boundary. Resolves with the observation only in the
 * `uninterrupted` and `resume` modes; in `crash` mode the returned promise never settles.
 */
export async function runRoleHost(
  spec: RoleRunSpec,
  emit: (line: string) => void,
): Promise<RunObservation> {
  const chain = await createAnvilDrillChain(spec.rpcUrl);
  const mode: ScenarioMode = spec.mode;
  const context: ScenarioContext = {
    checkpoint: spec.checkpoint,
    seed: spec.seed,
    runId: spec.runId,
    stateDir: spec.stateDir,
    mode,
    chain,
    boundary: async () => {
      if (mode !== 'crash') return;
      emit(`${BOUNDARY_MARKER} ${spec.checkpoint}`);
      // Never resolves. The parent SIGKILLs this process; nothing here unwinds, flushes, or
      // persists, which is exactly the failure the checkpoint is drilling.
      await new Promise<never>(() => {});
    },
  };
  const observation = await scenarioFor(spec.checkpoint)(context);
  if (observation === undefined) {
    throw new Error(`restart drill scenario ${spec.checkpoint} produced no observation`);
  }
  return RunObservationSchema.parse(observation);
}

/** Entry point for the child process: read a spec file, run it, print the observation. */
export async function main(specJson: string): Promise<void> {
  const spec = RoleRunSpecSchema.parse(JSON.parse(specJson));
  const observation = await runRoleHost(spec, (line) => {
    process.stdout.write(`${line}\n`);
  });
  process.stdout.write(`${OBSERVATION_MARKER} ${JSON.stringify(observation)}\n`);
}
