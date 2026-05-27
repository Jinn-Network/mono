import type {
  Harness,
  HarnessContext,
  ReadyStatus,
  Solution,
} from '../../types.js';
import { CLAUDE_CODE_HARNESS, CODEX_HARNESS, canonicalHarnessName } from '../../names.js';
import type {
  HarnessAdapter,
  TaskSessionInputs,
  LearnerHarnessConfig,
} from './types.js';
import { resolvePluginRoot } from './plugin-path.js';
import { harvestOutput } from './harvest.js';
import { buildClaudeIsReady } from '../../../preflight/claude-auth.js';
import { probeCodexDoctor } from '../../../api/codex-doctor-endpoint.js';
import { isLocalCodexBaseUrl } from './adapters/codex-code.js';

const DEFAULT_CODEX_PROVIDER_PROBE_TIMEOUT_MS = 2_000;

/**
 * `Harness` shell. Bridges the engine's dispatch contract
 * (`await impl.run(ctx)`) into the harness adapter + markdown plugin.
 *
 * `supports()` returns true for any non-evaluation SolverType. The registry
 * keeps this Harness as the default, so explicit specialists can still claim
 * their SolverTypes without being wrapped.
 */
export class LearnerHarness implements Harness {
  readonly name: string;
  readonly version: string;
  private readonly adapter: HarnessAdapter;
  private readonly pluginRoot: string;
  private readonly claudePath: string;
  private readonly codexPath: string | undefined;
  private readonly codexBaseUrl: string | undefined;
  private readonly codexDoctorTimeoutMs: number | undefined;
  private readonly codexProviderProbeTimeoutMs: number;
  private readonly codexProviderFetch: typeof fetch;
  private readonly runtimeMode: 'bare' | 'container' | 'docker-compose';

  constructor(config: LearnerHarnessConfig) {
    this.adapter = config.adapter;
    this.name = config.name ?? CLAUDE_CODE_HARNESS;
    this.version = config.version ?? '0.1.0-shim';
    this.pluginRoot = config.pluginRoot ?? resolvePluginRoot();
    this.claudePath = config.claudePath ?? 'claude';
    this.codexPath = config.codexPath;
    this.codexBaseUrl = config.codexBaseUrl;
    this.codexDoctorTimeoutMs = config.codexDoctorTimeoutMs;
    this.codexProviderProbeTimeoutMs =
      config.codexProviderProbeTimeoutMs ?? DEFAULT_CODEX_PROVIDER_PROBE_TIMEOUT_MS;
    this.codexProviderFetch = config.codexProviderFetch ?? fetch;
    this.runtimeMode = config.runtimeMode ?? 'bare';
  }

  private readonly claudeIsReady = buildClaudeIsReady({
    getClaudePath: () => this.claudePath,
    getContext: () => this.runtimeMode,
  });

  /**
   * Readiness probe.
   *
   * The `LearnerHarness` shell backs two distinct CLIs: claude-code (the
   * default) and Codex (`name === CODEX_HARNESS`). The probe MUST match the
   * CLI actually invoked — delegating the Codex variant to the claude auth
   * probe makes a missing/unconfigured `codex` install look always-ready and
   * burns N/N failed claims (#348, the same-shape bug as #330).
   *
   *   - claude-code → `buildClaudeIsReady` (shells `claude auth status`).
   *   - Codex       → `probeCodexDoctor` (shells `codex --version`, then
   *     checks for `OPENAI_API_KEY` / a `codex login` auth file).
   */
  async isReady(
    ctx?: { solverType: string; role?: 'restoration' | 'evaluation' },
  ): Promise<ReadyStatus> {
    if (canonicalHarnessName(this.name) === CODEX_HARNESS) {
      return await this.codexIsReady();
    }
    return this.claudeIsReady(ctx);
  }

  /**
   * Codex-specific readiness probe. Shells `codex --version` via the shared
   * `probeCodexDoctor` helper (same logic the SPA precheck endpoint uses).
   * Reports:
   *   - `installed: false` → binary not on PATH → ready=false with an install
   *     nextStep so the operator sees an actionable message instead of N/N
   *     failed claims (#348).
   *   - `exitCode !== 0` → binary exists but `codex --version` failed →
   *     ready=false pointing at the Codex precheck panel.
   *   - local `codexBaseUrl` → binary runs and the local sidecar owns auth, so
   *     Codex auth is not required.
   *   - `authStatus: 'not_configured'` → binary runs but no `OPENAI_API_KEY`
   *     and no `codex login` session → ready=false with a sign-in nextStep.
   *   - `authStatus: 'expired'` → an `auth.json` is present but its OAuth
   *     session has expired (or the file is malformed) → ready=false with a
   *     re-login nextStep. Distinct from `not_configured` so a logged-out
   *     operator with a leftover file is not treated as ready (#366).
   *   - otherwise → ready=true.
   */
  private async codexIsReady(): Promise<ReadyStatus> {
    const config: { codexPath?: string; codexDoctorTimeoutMs?: number } = {};
    if (this.codexPath !== undefined) config.codexPath = this.codexPath;
    if (this.codexDoctorTimeoutMs !== undefined) {
      config.codexDoctorTimeoutMs = this.codexDoctorTimeoutMs;
    }
    const result = await probeCodexDoctor(config);
    if (!result.installed) {
      return {
        ready: false,
        reason: 'codex binary not installed',
        nextStep: {
          description:
            'Install the Codex CLI — see the Codex precheck panel in the operator dashboard for the install command.',
          url: '/api/codex/doctor',
        },
      };
    }
    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim();
      const stdout = result.stdout.trim();
      const detail = stderr.length > 0 ? stderr : stdout;
      return {
        ready: false,
        reason: `codex --version exit ${result.exitCode}${detail ? `: ${detail}` : ''}`,
        nextStep: {
          description:
            'Run `codex --version` locally to surface the problem, or open the Codex precheck panel in the operator dashboard.',
          url: '/api/codex/doctor',
        },
      };
    }
    if (this.codexBaseUrl) {
      if (isLocalCodexBaseUrl(this.codexBaseUrl)) {
        return this.probeLocalCodexProvider(this.codexBaseUrl);
      }
      return {
        ready: false,
        reason: 'codex base URL must be local',
        nextStep: {
          description:
            'Use a local Codex provider URL such as http://127.0.0.1:11434/v1 or unset JINN_CODEX_BASE_URL.',
          url: '/api/codex/doctor',
        },
      };
    }
    if (result.authStatus === 'expired') {
      return {
        ready: false,
        reason: 'codex auth expired',
        nextStep: {
          description:
            'Codex sign-in has expired — run `codex login` to refresh the session (or set OPENAI_API_KEY), then re-check the Codex precheck panel in the operator dashboard.',
          url: '/api/codex/doctor',
        },
      };
    }
    if (result.authStatus !== 'ok') {
      return {
        ready: false,
        reason: 'codex auth not configured',
        nextStep: {
          description:
            'Sign in to Codex — set OPENAI_API_KEY or run `codex login`, then re-check the Codex precheck panel in the operator dashboard.',
          url: '/api/codex/doctor',
        },
      };
    }
    return { ready: true };
  }

  private async probeLocalCodexProvider(baseUrl: string): Promise<ReadyStatus> {
    const providerRoot = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    const modelsUrl = new URL('models', providerRoot).toString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.codexProviderProbeTimeoutMs);
    try {
      const response = await this.codexProviderFetch(modelsUrl, {
        method: 'GET',
        headers: { Authorization: 'Bearer jinn-local' },
        signal: controller.signal,
      });
      if (response.ok) return { ready: true };
      return {
        ready: false,
        reason: `local Codex provider /models returned HTTP ${response.status}`,
        nextStep: {
          description:
            'Start the local OpenAI-compatible provider and verify its /v1/models endpoint responds.',
          url: '/api/codex/doctor',
        },
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const reason = err instanceof Error && err.name === 'AbortError'
        ? 'local Codex provider /models probe timed out'
        : `local Codex provider unavailable${detail ? `: ${detail}` : ''}`;
      return {
        ready: false,
        reason,
        nextStep: {
          description:
            'Start the local OpenAI-compatible provider and verify its /v1/models endpoint responds.',
          url: '/api/codex/doctor',
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  supports(spec: { solverType: string; role?: 'restoration' | 'evaluation' }): boolean {
    if (spec.role === 'evaluation') return false;
    // These SolverTypes have first-party restoration Harnesses that return
    // typed solutionPayload objects. The learner emits phase artifacts for its
    // own pipeline; letting it claim these specialist tasks can run Claude but
    // fail packaging when the phase artifacts are absent.
    //
    // Architectural debt: this blocklist is the symptom — the learner can't
    // currently handle prediction.v1 / prediction.apy.v0 generically because
    // jinn-prediction-plugin lacks a submission-shape skill the way
    // swe-rebench-v2-runtime has plan/SKILL.md. Once that plugin gets a
    // submission skill and the harvest's prediction.v1 special-path
    // (harvest.ts ~520) is migrated to the generic .execute/solution-payload.json
    // path, this whole branch can be deleted.
    //
    // Related: jinn-mono-kzlj (deferred — Prediction frozen per
    // DR-2026-05-11-a). kzlj is scoped to prediction.v1; the prediction.apy.v0
    // path needs the same migration when the apy SolverNet's freeze lifts
    // (file a sibling bead when that happens). Reopen kzlj + file the apy
    // analogue when the freezes lift.
    if (spec.solverType === 'prediction.v1' || spec.solverType === 'prediction.apy.v0') {
      return false;
    }
    return true;
  }

  async run(ctx: HarnessContext): Promise<Solution> {
    const window = ctx.task.window ?? { startTs: 0, endTs: 0 };
    const inputs: TaskSessionInputs = {
      taskId: ctx.task.id,
      requestId: ctx.requestId,
      taskCid: ctx.taskCid,
      solverType: ctx.task.solverType,
      model: ctx.solverNet?.model,
      claudeModel: ctx.solverNet?.model,
      taskBody: ctx.task as TaskSessionInputs['taskBody'],
      implStateDir: ctx.implStateDir,
      workingDir: ctx.workingDir,
      pluginRoots: [...(ctx.solverPluginRoots ?? [])],
      windowStartTs: window.startTs,
      windowEndTs: window.endTs,
      msUntilEndTs: ctx.msUntilEndTs(),
      abort: ctx.abort,
      mode: ctx.mode,
    };

    await this.adapter.runTask(inputs, this.pluginRoot);

    const solution = await harvestOutput(ctx.workingDir, undefined, ctx.task);
    return {
      ...solution,
      venueRef: { ...solution.venueRef, name: this.name },
    };
  }
}
