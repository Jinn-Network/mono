// operator/src/harnesses/impls/hermes-agent/harness.ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Harness, HarnessContext, ReadyStatus, Solution } from '../../types.js';
import { displayPath, type HarnessAuthSource } from '../../auth-source.js';
import type { Task } from '../../../types/task.js';
import { vettedPoolRefSemanticsMismatch } from '../../../solver-types/_swe-rebench-v2-validated-pool.js';
import { HERMES_AGENT_HARNESS } from '../../names.js';
import type { HermesHarnessAdapter } from './adapter.js';
import { harvestOutput } from '../learner/harvest.js';
import {
  probeHermesDoctor,
  probeHermesAuthStatus,
  probeOpenRouterCredit,
  DEFAULT_OPENROUTER_CREDIT_FLOOR_USD,
  type OpenRouterCreditConfig,
} from '../../../api/hermes-doctor-endpoint.js';
import { isLocalHttpBaseUrl, urlAtBasePath } from '../../../local-provider-url.js';

const DEFAULT_HERMES_PROVIDER_PROBE_TIMEOUT_MS = 2_000;

export interface HermesHarnessConfig {
  adapter: HermesHarnessAdapter;
  version?: string;
  /** Hermes binary path used by `isReady()`. Defaults to `hermes` (PATH lookup). */
  hermesPath?: string;
  /** Timeout for the `hermes doctor` probe. Defaults to 30s. */
  hermesDoctorTimeoutMs?: number;
  /** Local OpenAI-compatible Hermes base URL. */
  hermesBaseUrl?: string;
  /** Timeout (ms) for probing the local OpenAI-compatible provider. */
  hermesProviderProbeTimeoutMs?: number;
  /** Test hook for the local provider readiness probe. */
  hermesProviderFetch?: typeof fetch;
  /**
   * Per-task OpenRouter credit floor in USD. Below this, `isReady()` reports
   * not-ready with a top-up nextStep. Defaults to
   * {@link DEFAULT_OPENROUTER_CREDIT_FLOOR_USD}. Tests can inject a custom
   * `creditProbe` to bypass the network probe entirely.
   */
  openrouterCreditFloorUsd?: number;
  /**
   * Optional injection point for the OpenRouter credit probe — tests use this
   * to mock the network round-trip. Production code lets the harness call the
   * exported `probeOpenRouterCredit` directly.
   */
  creditProbe?: (config: OpenRouterCreditConfig) => Promise<Awaited<ReturnType<typeof probeOpenRouterCredit>>>;
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
  private readonly hermesBaseUrl: string | undefined;
  private readonly hermesProviderProbeTimeoutMs: number;
  private readonly hermesProviderFetch: typeof fetch;
  private readonly openrouterCreditFloorUsd: number;
  private readonly creditProbe: (config: OpenRouterCreditConfig) => Promise<Awaited<ReturnType<typeof probeOpenRouterCredit>>>;

  constructor(config: HermesHarnessConfig) {
    this.adapter = config.adapter;
    this.version = config.version ?? '0.1.0';
    this.hermesPath = config.hermesPath;
    this.hermesDoctorTimeoutMs = config.hermesDoctorTimeoutMs;
    this.hermesBaseUrl = config.hermesBaseUrl;
    this.hermesProviderProbeTimeoutMs =
      config.hermesProviderProbeTimeoutMs ?? DEFAULT_HERMES_PROVIDER_PROBE_TIMEOUT_MS;
    this.hermesProviderFetch = config.hermesProviderFetch ?? fetch;
    this.openrouterCreditFloorUsd = config.openrouterCreditFloorUsd ?? DEFAULT_OPENROUTER_CREDIT_FLOOR_USD;
    this.creditProbe = config.creditProbe ?? probeOpenRouterCredit;
  }

  /**
   * Readiness probe — shells out to `hermes doctor` via the shared
   * `probeHermesDoctor` helper (same logic the SPA precheck endpoint
   * uses). Reports:
   *   - `installed: false` → binary not on PATH → ready=false with install
   *     nextStep so the operator sees an actionable message instead of
   *     N/N failed claims (#330).
   *   - `JINN_HERMES_BASE_URL` set → binary exists and the configured local
   *     OpenAI-compatible provider answers `/models` → ready=true. This mode
   *     deliberately bypasses the OpenRouter-specific auth/credit gates.
   *   - `exitCode !== 0` → binary exists but `hermes doctor` reports a
   *     configuration problem (e.g. provider not signed in) → ready=false
   *     with a nextStep that points at the SPA precheck panel.
   *   - OpenRouter has no usable credential → ready=false. `hermes doctor`
   *     exits 0 even when every provider is logged out (it treats missing
   *     providers as warnings), so this third gate probes `hermes auth list
   *     openrouter` directly. `auth list` reads the credential pool, so it
   *     recognises API-key credentials (the normal `OPENROUTER_API_KEY`
   *     setup) as well as OAuth — unlike `auth status`, which only reflects
   *     interactive-OAuth-login state. In the default Jinn/Hermes path,
   *     Hermes uses OpenRouter, so an OpenRouter with no usable credential
   *     means Hermes has no model provider and every claim would burn
   *     (#332/#330/#348).
   *   - OpenRouter credential is present but credit is exhausted → ready=false.
   *     Production bug, 2026-05-23: `auth list openrouter` reported the
   *     api_key credential as healthy, but every solve attempt for the day
   *     returned HTTP 402 ("This request requires more credits, or fewer
   *     max_tokens.") and the harness silently burned 12 claims. The fourth
   *     gate probes `GET https://openrouter.ai/api/v1/key` to verify the
   *     credential has spendable credit at or above the per-task floor.
   *     Fail-safe: network errors and non-200 responses are treated as
   *     unknown (ready), not exhausted, so a transient OpenRouter outage
   *     doesn't shut every operator down. Only a clearly-confirmed
   *     insufficient-credit signal flips ready=false.
   *   - all four gates pass → ready=true.
   */
  async isReady(_ctx?: { solverType: string; role?: 'restoration' | 'evaluation' }): Promise<ReadyStatus> {
    const config: { hermesPath?: string; hermesDoctorTimeoutMs?: number } = {};
    if (this.hermesPath !== undefined) config.hermesPath = this.hermesPath;
    if (this.hermesDoctorTimeoutMs !== undefined) config.hermesDoctorTimeoutMs = this.hermesDoctorTimeoutMs;
    const result = await probeHermesDoctor(config);
    if (!result.installed) {
      return {
        ready: false,
        reason: 'hermes binary not installed',
        nextStep: {
          description:
            'Install the Hermes agent runner — see the Hermes precheck panel in the operator dashboard for the install command.',
        },
      };
    }
    if (this.hermesBaseUrl) {
      if (!isLocalHttpBaseUrl(this.hermesBaseUrl)) {
        return {
          ready: false,
          reason: 'hermes base URL must be local',
          nextStep: {
            description:
              'Use a local Hermes provider URL such as http://127.0.0.1:11434/v1 or unset JINN_HERMES_BASE_URL.',
          },
        };
      }
      return this.probeLocalHermesProvider(this.hermesBaseUrl);
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
        },
      };
    }
    // Third gate: `hermes doctor` exits 0 even when every model provider is
    // logged out. The default Jinn/Hermes path relies on OpenRouter, so probe
    // OpenRouter auth directly — a logged-out OpenRouter means Hermes cannot
    // run a task.
    const auth = await probeHermesAuthStatus('openrouter', config);
    if (!auth.authed) {
      return {
        ready: false,
        reason: 'OpenRouter not connected — Hermes has no usable model provider',
        nextStep: {
          description:
            'Connect OpenRouter — sign in via the Hermes precheck panel in the operator dashboard, or run `hermes login` locally.',
        },
      };
    }
    // Fourth gate: probe OpenRouter's `/api/v1/key` for spendable credit.
    // Catches the case where the credential is present and pool-healthy but
    // the account is out of money — without this, the harness burns claims
    // on 402 responses (production bug, 2026-05-23). Fail-safe: only a
    // clearly-confirmed exhausted state flips ready=false.
    const credit = await this.creditProbe({ floorUsd: this.openrouterCreditFloorUsd });
    if (credit.state === 'exhausted') {
      const remaining = typeof credit.remainingUsd === 'number'
        ? `$${credit.remainingUsd.toFixed(2)}`
        : 'below floor';
      const floor = `$${credit.floorUsd.toFixed(2)}`;
      return {
        ready: false,
        reason: `OpenRouter credit insufficient for the next solve — remaining ${remaining} < floor ${floor}`,
        nextStep: {
          description:
            'OpenRouter credit insufficient for the next solve — top up at https://openrouter.ai/credits, then re-check readiness.',
          url: 'https://openrouter.ai/credits',
        },
      };
    }
    return { ready: true };
  }

  /**
   * #564 — declare the operator's Hermes credential location: the
   * `OPENROUTER_API_KEY` line in `$HERMES_HOME/.env` (default `~/.hermes/.env`).
   * The daemon's resolver reads only the last-4 suffix; this method never reads
   * the key itself.
   */
  async getAuthSource(): Promise<HarnessAuthSource> {
    const home = process.env['HERMES_HOME']?.trim() || join(homedir(), '.hermes');
    const absolutePath = join(home, '.env');
    return {
      sourceKind: 'file',
      sourcePath: displayPath(absolutePath),
      absolutePath,
      envKey: 'OPENROUTER_API_KEY',
      docAnchor: 'hermes-agent',
    };
  }

  private async probeLocalHermesProvider(baseUrl: string): Promise<ReadyStatus> {
    const modelsUrl = urlAtBasePath(baseUrl, 'models');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.hermesProviderProbeTimeoutMs);
    try {
      const response = await this.hermesProviderFetch(modelsUrl, {
        method: 'GET',
        headers: { Authorization: 'Bearer jinn-local' },
        signal: controller.signal,
      });
      if (response.ok) return { ready: true };
      return {
        ready: false,
        reason: `local Hermes provider /models returned HTTP ${response.status}`,
        nextStep: {
          description:
            'Start the local OpenAI-compatible provider and verify its /v1/models endpoint responds.',
        },
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const reason = err instanceof Error && err.name === 'AbortError'
        ? 'local Hermes provider /models probe timed out'
        : `local Hermes provider unavailable${detail ? `: ${detail}` : ''}`;
      return {
        ready: false,
        reason,
        nextStep: {
          description:
            'Start the local OpenAI-compatible provider and verify its /v1/models endpoint responds.',
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  supports(spec: { solverType: string; role?: 'restoration' | 'evaluation' }): boolean {
    // Hermes currently ships a SWE-rebench v2 task prompt and runtime plugin.
    // Evaluation is not supported: Hermes has no evaluator-side plugins
    // (verdict signing, checker contracts).
    return spec.role !== 'evaluation' && spec.solverType === 'swe-rebench-v2.v1';
  }

  /**
   * gh #300 — solver-side ghost-task admission (Tier 1, zero-fetch).
   * Reject tasks whose on-chain `vettedPoolRef` announces an
   * `evalSemanticsVersion` no local evaluator could grade. Fails open when the
   * ref is absent (recency floor guards ref-less ghosts). See
   * `spec/2026-05-29-ghost-task-admission-symmetric-gate.md`.
   */
  async canAttempt(task: Task): Promise<{ ok: true } | { ok: false; reason: string }> {
    const mismatch = vettedPoolRefSemanticsMismatch(task.eligibility);
    if (mismatch) return { ok: false, reason: mismatch };
    return { ok: true };
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
