/**
 * @jinn-examples/alternative-harness — Path 2 worked example.
 *
 * Harness for `prediction.v0` running the seven-phase learning
 * pipeline (Orient → Strategize → Plan → Execute → Debrief → Improve
 * → Memory) against a non-Claude-Code harness. The package owns the
 * coordinator + per-phase modules; the harness is swappable through
 * the `HarnessAdapter` interface in `src/harness.ts`.
 *
 * Tests use a deterministic in-process mock harness; real builders
 * pass a `harnessFactory` that wraps their preferred runtime
 * (Pi.dev, Codex CLI, Gemini CLI, custom subprocess).
 */

import type {
  Harness,
  ExternalHarnessEnv,
  HarnessContext,
  Solution,
} from '@jinn-network/harness-sdk';
import type { HarnessAdapter } from './harness.js';
import { runCoordinator } from './coordinator.js';
import { createMockHarness } from './mock-harness.js';

export interface AlternativeHarnessConfig {
  /** The harness to drive. Defaults to the deterministic mock for tests. */
  harnessFactory?: (env: ExternalHarnessEnv) => HarnessAdapter;
}

export default function createHarness(
  env: ExternalHarnessEnv,
  config: AlternativeHarnessConfig = {},
): Harness {
  const factory = config.harnessFactory ?? createMockHarness;
  const harness = factory(env);
  return {
    name: env.implName,
    version: env.implVersion,
    supports({ solverType, role }) {
      return solverType === 'prediction.v0' && role !== 'evaluation';
    },
    async isReady() {
      return env.stub
        ? { ready: false, reason: 'stub mode' }
        : { ready: true };
    },
    async run(ctx: HarnessContext): Promise<Solution> {
      env.log({
        level: 'info',
        msg: 'alternative-harness.start',
        data: { taskId: ctx.task.id },
      });
      return runCoordinator({ ctx, harness });
    },
  };
}

export type { HarnessAdapter, HarnessPromptArgs } from './harness.js';
export { createMockHarness } from './mock-harness.js';
