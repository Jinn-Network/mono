/**
 * Env-gated stub harness for the T2.2 producer/evaluator gate.
 *
 * When JINN_HARNESS_STUB_INSTANCE is set, the canned patch at
 * <fixturesDir>/<instanceMatcher>.patch is returned as a SWE-rebench v2
 * restoration solution. Never calls an LLM; never accepts tasks whose
 * spec.instance_id differs from the configured matcher.
 *
 * Activated by environment variables:
 *   JINN_HARNESS_STUB_INSTANCE     — instance ID this stub responds to (required to activate)
 *   JINN_HARNESS_STUB_FIXTURES_DIR — dir containing <instanceMatcher>.patch files
 *                                    (default: client/test/release/tier-2/fixtures)
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Harness, HarnessContext, ReadyStatus, Solution } from '../types.js';

export interface StubHarnessConfig {
  /** Directory containing <instanceMatcher>.patch files. */
  fixturesDir: string;
  /** The instance ID this stub will accept. Tasks with other instance IDs are rejected. */
  instanceMatcher: string;
}

/**
 * A zero-LLM Harness that returns a canned patch for a specific SWE-rebench v2
 * instance. Intended exclusively for T2.2 release-gate automation.
 */
export class StubHarness implements Harness {
  readonly name = 'harness:stub';
  readonly version = '0.1.0-stub';

  private readonly fixturesDir: string;
  private readonly instanceMatcher: string;

  constructor(config: StubHarnessConfig) {
    this.fixturesDir = config.fixturesDir;
    this.instanceMatcher = config.instanceMatcher;
  }

  supports(ctx: { solverType: string; role?: 'restoration' | 'evaluation' }): boolean {
    if (ctx.role === 'evaluation') return false;
    return ctx.solverType === 'swe-rebench-v2.v1';
  }

  async isReady(): Promise<ReadyStatus> {
    return { ready: true };
  }

  async run(ctx: HarnessContext): Promise<Solution> {
    const taskInstanceId = (ctx.task.spec as Record<string, unknown> | undefined)?.['instance_id'];
    if (taskInstanceId !== this.instanceMatcher) {
      throw new Error(
        `stub harness: task.spec.instance_id=${String(taskInstanceId)} does not match configured instanceMatcher=${this.instanceMatcher}`,
      );
    }
    const patchPath = path.join(this.fixturesDir, `${this.instanceMatcher}.patch`);
    const patch = await fs.readFile(patchPath, 'utf-8');
    return {
      venueRef: { name: this.name },
      gating: {},
      solutionPayload: {
        schemaVersion: 'swe-rebench-v2-solution.v1',
        patch,
      },
    };
  }
}

/**
 * Factory that reads JINN_HARNESS_STUB_INSTANCE and JINN_HARNESS_STUB_FIXTURES_DIR
 * from the environment and returns a configured StubHarness, or null if the env
 * var is absent (allowing the registry to skip registration silently).
 */
export function maybeCreateStubHarnessFromEnv(): StubHarness | null {
  const instanceMatcher = process.env['JINN_HARNESS_STUB_INSTANCE'];
  if (!instanceMatcher) return null;
  const fixturesDir =
    process.env['JINN_HARNESS_STUB_FIXTURES_DIR'] ??
    path.resolve(process.cwd(), 'test', 'release', 'tier-2', 'fixtures');
  return new StubHarness({ instanceMatcher, fixturesDir });
}
