// client/src/harnesses/impls/hermes-agent/harness.ts
import type { Harness, HarnessContext, ReadyStatus, Solution } from '../../types.js';
import { HERMES_AGENT_HARNESS } from '../../names.js';
import type { HermesHarnessAdapter } from './adapter.js';
import { harvestOutput } from '../learner/harvest.js';
import { probeHermesDoctor } from '../../../api/hermes-doctor-endpoint.js';

export interface HermesHarnessConfig {
  adapter: HermesHarnessAdapter;
  version?: string;
  /** Hermes binary path used by `isReady()`. Defaults to `hermes` (PATH lookup). */
  hermesPath?: string;
  /** Timeout for the `hermes doctor` probe. Defaults to 30s. */
  hermesDoctorTimeoutMs?: number;
}

/**
 * Hermes Agent harness.
 *
 * Generic restoration harness backed by the Hermes agent runner. Built-in
 * learning loop owned by Hermes (skill self-improvement, memory curation, FTS5
 * session search); Jinn-side learner plugin is NOT loaded. SolverPlugins are
 * mounted via Hermes's mcp_servers + skills config.yaml surface (see
 * config-builder.ts).
 *
 * Scoped to SWE-rebench v2 while the Hermes task prompt, SolverPlugin bundle,
 * and output harvesting are specific to `swe-rebench-v2.v1`.
 */
export class HermesHarness implements Harness {
  readonly name = HERMES_AGENT_HARNESS;
  readonly version: string;
  readonly freezeStateHashIgnore = ['auth', 'auth.json', 'bin/tirith', '.env', 'config.yaml'] as const;
  private readonly adapter: HermesHarnessAdapter;
  private readonly hermesPath: string | undefined;
  private readonly hermesDoctorTimeoutMs: number | undefined;

  constructor(config: HermesHarnessConfig) {
    this.adapter = config.adapter;
    this.version = config.version ?? '0.1.0';
    this.hermesPath = config.hermesPath;
    this.hermesDoctorTimeoutMs = config.hermesDoctorTimeoutMs;
  }

  /**
   * Readiness probe — shells out to `hermes doctor` via the shared
   * `probeHermesDoctor` helper (same logic the SPA precheck endpoint
   * uses). Reports:
   *   - `installed: false` → binary not on PATH → ready=false with install
   *     nextStep so the operator sees an actionable message instead of
   *     N/N failed claims (#330).
   *   - `exitCode !== 0` → binary exists but `hermes doctor` reports a
   *     configuration problem (e.g. provider not signed in) → ready=false
   *     with a nextStep that points at the SPA precheck panel.
   *   - `exitCode === 0` → ready=true.
   */
  async isReady(_ctx?: { solverType: string; role?: 'restoration' | 'evaluation' }): Promise<ReadyStatus> {
    const config: { hermesPath?: string; hermesDoctorTimeoutMs?: number } = {};
    if (this.hermesPath !== undefined) config.hermesPath = this.hermesPath;
    if (this.hermesDoctorTimeoutMs !== undefined) config.hermesDoctorTimeoutMs = this.hermesDoctorTimeoutMs;
    const result = probeHermesDoctor(config);
    if (!result.installed) {
      return {
        ready: false,
        reason: 'hermes binary not installed',
        nextStep: {
          description:
            'Install the Hermes agent runner — see the Hermes precheck panel in the operator dashboard for the install command.',
          url: '/api/hermes/doctor',
        },
      };
    }
    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim();
      const stdout = result.stdout.trim();
      const detail = stderr.length > 0 ? stderr : stdout;
      return {
        ready: false,
        reason: `hermes doctor exit ${result.exitCode}${detail ? `: ${detail}` : ''}`,
        nextStep: {
          description:
            'Run `hermes doctor` locally to surface the configuration problem, or open the Hermes precheck panel in the operator dashboard to sign in / select a provider.',
          url: '/api/hermes/doctor',
        },
      };
    }
    return { ready: true };
  }

  supports(spec: { solverType: string; role?: 'restoration' | 'evaluation' }): boolean {
    // Hermes currently ships a SWE-rebench v2 task prompt and runtime plugin.
    // Evaluation is not supported: Hermes has no evaluator-side plugins
    // (verdict signing, checker contracts).
    return spec.role !== 'evaluation' && spec.solverType === 'swe-rebench-v2.v1';
  }

  async run(ctx: HarnessContext): Promise<Solution> {
    const window = ctx.task.window ?? { startTs: 0, endTs: 0 };
    await this.adapter.runTask({
      taskId: ctx.task.id,
      requestId: ctx.requestId,
      taskCid: ctx.taskCid,
      solverType: ctx.task.solverType,
      model: ctx.solverNet?.model,
      taskBody: ctx.task as any,
      implStateDir: ctx.implStateDir,
      workingDir: ctx.workingDir,
      pluginRoots: [...(ctx.solverPluginRoots ?? [])],
      windowStartTs: window.startTs,
      windowEndTs: window.endTs,
      msUntilEndTs: ctx.msUntilEndTs(),
      abort: ctx.abort,
      mode: ctx.mode,
    });

    const solution = await harvestOutput(ctx.workingDir, undefined, ctx.task);
    return { ...solution, venueRef: { ...solution.venueRef, name: this.name } };
  }
}
