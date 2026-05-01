/**
 * @jinn-examples/alternative-harness — Path 2 worked example.
 *
 * Restorer for `prediction.v0` running the seven-phase learning
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
  RestorerImpl,
  ExternalRestorerEnv,
  RestorationContext,
  RestorationOutput,
} from '@jinn-network/restorer-sdk';
import type { HarnessAdapter } from './harness.js';
import { runCoordinator } from './coordinator.js';
import { createMockHarness } from './mock-harness.js';

export interface AlternativeHarnessConfig {
  /** The harness to drive. Defaults to the deterministic mock for tests. */
  harnessFactory?: (env: ExternalRestorerEnv) => HarnessAdapter;
}

export default function createRestorer(
  env: ExternalRestorerEnv,
  config: AlternativeHarnessConfig = {},
): RestorerImpl {
  const factory = config.harnessFactory ?? createMockHarness;
  const harness = factory(env);
  return {
    name: env.implName,
    version: env.implVersion,
    supports({ kind, type }) {
      return kind === 'prediction.v0' && type !== 'evaluation';
    },
    async isReady() {
      return env.stub
        ? { ready: false, reason: 'stub mode' }
        : { ready: true };
    },
    async run(ctx: RestorationContext): Promise<RestorationOutput> {
      env.log({
        level: 'info',
        msg: 'alternative-harness.start',
        data: { intentId: ctx.intent.id },
      });
      return runCoordinator({ ctx, harness });
    },
  };
}

export type { HarnessAdapter, HarnessPromptArgs } from './harness.js';
export { createMockHarness } from './mock-harness.js';
