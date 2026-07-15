/**
 * LocalLearningPort adapter (#1660) — drives the rung-1 `Distiller` behind the
 * plugin's `LocalLearningPort`. `run` mints a runId, kicks the distillation
 * asynchronously, and returns `ok({ runId })` immediately; a failed
 * distillation is a `'failed'` run STATE, not a port error.
 *
 * The returned object exposes `awaitRun(runId)` beyond the port surface so
 * tests can observe the terminal state deterministically (no timers).
 */
import type { LocalLearningPort, LocalLearningRun, PortResult } from '@jinn-network/plugin';
import { ok, unavailable } from '@jinn-network/plugin';
import type { CapturedTask } from '../capture.js';
import type { Distiller } from '../distiller.js';

export interface LocalLearningAdapterDeps {
  distiller: Distiller;
  /** Resolve episodeIds → the captures the distiller consumes. */
  loadCaptures: (episodeIds: string[]) => Promise<CapturedTask[]>;
}

/** The port plus a test-only completion handle. */
export interface LocalLearningAdapter extends LocalLearningPort {
  /** Resolve once the run reaches a terminal (`done`/`failed`) state. */
  awaitRun(runId: string): Promise<void>;
}

export function createLocalLearningAdapter(deps: LocalLearningAdapterDeps): LocalLearningAdapter {
  const runs = new Map<string, LocalLearningRun>();
  const completions = new Map<string, Promise<void>>();
  let runCounter = 0;

  return {
    async run(input: { episodeIds: string[] }): Promise<PortResult<{ runId: string }>> {
      runCounter += 1;
      const runId = `run-${Date.now()}-${runCounter}`;
      runs.set(runId, { runId, state: 'pending' });

      const completion = (async () => {
        runs.set(runId, { runId, state: 'running' });
        try {
          const captures = await deps.loadCaptures(input.episodeIds);
          await deps.distiller.distill(captures);
          runs.set(runId, { runId, state: 'done' });
        } catch {
          // A failed distillation is a legitimate run state, not a port error.
          runs.set(runId, { runId, state: 'failed' });
        }
      })();
      completions.set(runId, completion);

      return ok({ runId });
    },

    async status(runId: string): Promise<PortResult<LocalLearningRun>> {
      const run = runs.get(runId);
      if (!run) return unavailable(`no such run: ${runId}`);
      return ok(run);
    },

    async list(): Promise<PortResult<LocalLearningRun[]>> {
      return ok([...runs.values()]);
    },

    async awaitRun(runId: string): Promise<void> {
      await completions.get(runId);
    },
  };
}
