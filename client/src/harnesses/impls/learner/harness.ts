import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  Harness,
  HarnessContext,
  HarnessMode,
  ReadyStatus,
  RuntimePlugin,
  Solution,
} from '../../types.js';
import { displayPath, type HarnessAuthSource } from '../../auth-source.js';
import type { Task } from '../../../types/task.js';
import { vettedPoolRefSemanticsMismatch } from '../../../solver-types/_swe-rebench-v2-validated-pool.js';
import { syntheticClaimBlocked } from '../../../solver-types/_swe-rebench-v2-synthetic-claim.js';
import { CLAUDE_CODE_HARNESS, CODEX_HARNESS, canonicalHarnessName } from '../../names.js';
import { LEARNER_PUBLIC_V1 } from '../../hash-profile.js';
import { harnessHashOptions } from '../../freeze.js';
import type {
  HarnessAdapter,
  TaskSessionInputs,
  LearnerHarnessConfig,
} from './types.js';
import {
  CANDIDATE_DIR_ENV,
  emitCandidate,
  inlineMutationEnabled,
  INLINE_MUTATION_ENV,
  provisionCandidateWorkspace,
  type LearnerCandidateConfig,
  type ProvisionedCandidate,
} from './candidate.js';
import { routingSupports, type LearnerRoutingConfig } from './routing.js';
import { resolvePluginRoot } from './plugin-path.js';
import { digestDirectory } from '../../../plugins/digest.js';
import { findSolverPluginManifest } from '../../../plugins/manifest.js';
import { harvestOutput } from './harvest.js';
import { buildClaudeIsReady } from '../../../preflight/claude-auth.js';
import { probeCodexDoctor } from '../../../api/codex-doctor-endpoint.js';

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
  /**
   * The learner's impl-state is digested under the `learner-public.v1` profile
   * (#2118). The profile excludes `.git/` for the reason this harness has always
   * excluded it — `implStateDir` is git-backed
   * (`plugins/learner/hooks/session-start` runs `git init`), so hashing `.git`
   * would make a commit's codeDigest irreproducible from its tree, breaking the
   * commit→codeDigest mapping the per-codeDigest revert selection relies on
   * (#764) — and additionally excludes the three roots the learner deliberately
   * fills with operator-private material (`secrets/`, `transcripts/`,
   * `operator-requests/`). One scheme now covers the freeze fence, the delivery
   * `codeDigest`, and the daemon status surface.
   *
   * See docs/runbooks/learner-public-v1-digest-migration.md for the recorded
   * digest break.
   */
  readonly freezeStateHashProfile = LEARNER_PUBLIC_V1;
  private readonly adapter: HarnessAdapter;
  private readonly pluginRoot: string;
  private readonly claudePath: string;
  private readonly codexPath: string | undefined;
  private readonly codexDoctorTimeoutMs: number | undefined;
  private readonly runtimeMode: 'bare' | 'container' | 'docker-compose';
  private readonly routing: LearnerRoutingConfig | undefined;
  private readonly candidateConfig: LearnerCandidateConfig;
  /** Memoized #1035 attribution descriptors (built lazily on first request). */
  private attributionPluginsCache: RuntimePlugin[] | undefined;

  constructor(config: LearnerHarnessConfig) {
    this.adapter = config.adapter;
    this.routing = config.routing;
    this.candidateConfig = config.candidate ?? {};
    this.name = config.name ?? CLAUDE_CODE_HARNESS;
    this.version = config.version ?? '0.1.0-shim';
    this.pluginRoot = config.pluginRoot ?? resolvePluginRoot();
    this.claudePath = config.claudePath ?? 'claude';
    this.codexPath = config.codexPath;
    this.codexDoctorTimeoutMs = config.codexDoctorTimeoutMs;
    this.runtimeMode = config.runtimeMode ?? 'bare';
  }

  /**
   * #1035 — advertise the bundled learner plugin for envelope attribution so it
   * lands in the envelope's executor.plugins like any SolverNet runtime plugin.
   *
   * Built lazily and memoized: the directory digest is stable per run, but the
   * plugin root may legitimately lack a manifest in non-production contexts
   * (unit tests pass synthetic roots), so we degrade to an empty array rather
   * than failing the run. We do NOT use resolveSolverPlugin/
   * loadSolverPluginManifest here: the learner manifest
   * (.claude-plugin/plugin.json) has only name+version and no jinn.supports, so
   * the SolverPlugin validator would reject it. Read name+version directly.
   */
  attributionPlugins(): RuntimePlugin[] {
    if (this.attributionPluginsCache === undefined) {
      const plugin = this.buildAttributionPlugin();
      this.attributionPluginsCache = plugin ? [plugin] : [];
    }
    return this.attributionPluginsCache;
  }

  private buildAttributionPlugin(): RuntimePlugin | null {
    try {
      const manifestPath = findSolverPluginManifest(this.pluginRoot);
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { name?: string; version?: string };
      return {
        name: manifest.name ?? 'claude-code-learner',
        version: manifest.version ?? '0.0.0',
        source: 'bundled:learner',
        sourceKind: 'bundled',
        root: this.pluginRoot,
        manifestPath,
        sha256: digestDirectory(this.pluginRoot),
        provenance: 'default',
      };
    } catch (err) {
      console.warn(
        `[learner] attributionPlugins: no plugin manifest at ${this.pluginRoot}; ` +
          `skipping self-attribution (${err instanceof Error ? err.message : String(err)})`,
      );
      return null;
    }
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
   * #564 — auth source depends on the backing CLI:
   *   - claude-code → session auth (`claude auth status`), no stat-able file.
   *   - codex       → `OPENAI_API_KEY` env if set, else `auth.json` at
   *                   `CODEX_HOME` or `~/.codex/auth.json`.
   * The daemon's resolver reads only a masked suffix; codex `auth.json` is JSON
   * (no plain key field), so the resolver reports `loaded` from file existence
   * but masks the suffix to null — the operator still sees the path, mtime, and
   * state.
   */
  async getAuthSource(): Promise<HarnessAuthSource> {
    if (canonicalHarnessName(this.name) === CODEX_HARNESS) {
      if ((process.env['OPENAI_API_KEY']?.trim() ?? '').length > 0) {
        return { sourceKind: 'env', envKey: 'OPENAI_API_KEY', docAnchor: 'codex' };
      }
      const codexHome = process.env['CODEX_HOME']?.trim();
      const absolutePath = codexHome
        ? join(codexHome, 'auth.json')
        : join(homedir(), '.codex', 'auth.json');
      return {
        sourceKind: 'file',
        sourcePath: displayPath(absolutePath),
        absolutePath,
        envKey: 'OPENAI_API_KEY',
        docAnchor: 'codex',
        credentialIsJson: true,
      };
    }
    // claude-code (default)
    return { sourceKind: 'session', docAnchor: 'claude-code' };
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

  /**
   * Routing is explicit: this harness claims the SolverTypes its configuration
   * names, and nothing else.
   *
   * The former posture — return `true` for every non-evaluation SolverType, with
   * a two-item blocklist bolted on — was self-documented architectural debt. It
   * is retired here because it collides with controlled arms: a campaign cannot
   * compare policies on a route the learner claims regardless of what anyone
   * configured, and an unconfigured learner quietly wrapping the whole network
   * is not a policy anybody pinned (product design §10).
   *
   * The old behaviour survives behind `JINN_LEARNER_DEFAULT_ROUTING` so existing
   * deployments keep working while they migrate to an explicit allowlist. See
   * `routing.ts` for the two-item blocklist that holds in *both* modes and for
   * the conditions under which it can finally be deleted.
   */
  supports(spec: { solverType: string; role?: 'restoration' | 'evaluation' }): boolean {
    return routingSupports(this.routing, spec, this.name);
  }

  /**
   * gh #300 — solver-side ghost-task admission (Tier 1, zero-fetch).
   * Reject tasks whose on-chain `vettedPoolRef` announces an
   * `evalSemanticsVersion` no local evaluator could grade (the swe-rebench-v2
   * ghost class). Fails open when the ref is absent, so non-swe-rebench-v2
   * SolverTypes the learner also serves are unaffected. See
   * `spec/2026-05-29-ghost-task-admission-symmetric-gate.md`.
   */
  async canAttempt(task: Task): Promise<{ ok: true } | { ok: false; reason: string }> {
    const mismatch = vettedPoolRefSemanticsMismatch(task.eligibility);
    if (mismatch) return { ok: false, reason: mismatch };
    const synthetic = task.eligibility?.['syntheticProvenance'] as
      | { synthetic?: boolean; minterSafe?: string; sourceSolverSafe?: string }
      | undefined;
    const operatorSafe = task.eligibility?.['claimantSafe'] as string | undefined;
    if (operatorSafe) {
      const blocked = syntheticClaimBlocked(synthetic, operatorSafe);
      if (blocked) return { ok: false, reason: blocked };
    }
    return { ok: true };
  }

  /**
   * Candidate mode's write target: a copy of the ACTIVE state the plugin's
   * Improve and Consolidate phases mutate instead of the live directory. The
   * active directory itself stays byte-identical, enforced by the freeze-fence
   * (which takes its non-train branch for candidate mode).
   */
  private async provisionCandidate(ctx: HarnessContext): Promise<ProvisionedCandidate> {
    const workspaceRoot = this.candidateConfig.workspaceRoot
      ?? join(ctx.implStateDir, '..', 'candidates');
    return await provisionCandidateWorkspace({
      activeDir: ctx.implStateDir,
      workspaceRoot,
      runId: ctx.requestId ?? ctx.task.id,
      hashOpts: harnessHashOptions(this) ?? {},
    });
  }

  /** Seal the proposal. Never throws — a failed emission must not fail the solve. */
  private async emitCandidateManifest(
    ctx: HarnessContext,
    provisioned: ProvisionedCandidate,
  ): Promise<void> {
    try {
      const emission = await emitCandidate({
        provisioned,
        workingDir: ctx.workingDir,
        axes: {
          harness: this.name,
          model: ctx.solverNet?.model ?? null,
          // Every launcher supports exactly one isolation policy, so this axis
          // is `vacuous` in the substrate's §4.3 sense — agreement on it asserts
          // nothing. It is still pinned, so the tuple is honest about what ran.
          isolationPolicy: 'unrestricted',
        },
        config: this.candidateConfig,
        hashOpts: harnessHashOptions(this) ?? {},
      });
      if (emission.error) {
        console.warn(
          `[learner:${this.name}] candidate ${emission.runId}: tree emitted, manifest refused — ${emission.error}`,
        );
      } else {
        console.log(
          `[learner:${this.name}] candidate ${emission.runId}: ${emission.manifestDigest} ` +
            `(parent tree ${emission.parentTreeDigest.slice(0, 12)} → candidate tree ${emission.candidateTreeDigest.slice(0, 12)})`,
        );
      }
    } catch (err) {
      console.warn(
        `[learner:${this.name}] candidate emission failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * The mode the PLUGIN is told to run in, which is the daemon's mode except
   * when an operator has opted out of deprecated inline self-mutation
   * (`JINN_LEARNER_INLINE_MUTATION=0`). Train mode then runs the plugin under
   * frozen semantics: Orient through Debrief, no Improve, no Consolidate, no
   * write to `implStateDir`.
   *
   * Scope, stated rather than implied: this suppresses the *instruction*, not
   * the *capability*. The daemon-wide freeze-fence still branches on the
   * daemon's mode, which is `train`, so a plugin that ignored the steer and
   * wrote anyway would not be caught here. The flag is a deprecation off-ramp
   * for operators who want the learner to stop adapting in place; operators who
   * need the write actually prevented run `frozen` or `candidate` mode, where
   * the fence enforces it. Doing this at the harness rather than the engine is
   * deliberate too — the flag is learner-specific, and forcing the engine's
   * global mode would silently freeze every other harness in the registry.
   */
  private pluginMode(ctx: HarnessContext): HarnessMode {
    if (ctx.mode === 'train' && !inlineMutationEnabled()) return 'frozen';
    return ctx.mode;
  }

  async run(ctx: HarnessContext): Promise<Solution> {
    const window = ctx.task.window ?? { startTs: 0, endTs: 0 };
    const candidate = ctx.mode === 'candidate' ? await this.provisionCandidate(ctx) : undefined;
    const mode = this.pluginMode(ctx);
    if (mode !== ctx.mode) {
      console.warn(
        `[learner:${this.name}] ${INLINE_MUTATION_ENV} is disabled — running train-mode task ` +
          `${ctx.task.id} under frozen semantics (no Improve, no Memory consolidation). ` +
          'Inline self-mutation is deprecated; candidate mode is the supported replacement.',
      );
    }
    const inputs: TaskSessionInputs = {
      taskId: ctx.task.id,
      requestId: ctx.requestId,
      taskCid: ctx.taskCid,
      solverType: ctx.task.solverType,
      model: ctx.solverNet?.model,
      ...(ctx.solverNet?.provider !== undefined ? { provider: ctx.solverNet.provider } : {}),
      claudeModel: ctx.solverNet?.model,
      taskBody: ctx.task as TaskSessionInputs['taskBody'],
      implStateDir: ctx.implStateDir,
      workingDir: ctx.workingDir,
      pluginRoots: [...(ctx.solverPluginRoots ?? [])],
      windowStartTs: window.startTs,
      windowEndTs: window.endTs,
      msUntilEndTs: ctx.msUntilEndTs(),
      abort: ctx.abort,
      mode,
      ...(candidate ? { adapterEnv: { [CANDIDATE_DIR_ENV]: candidate.treeDir } } : {}),
    };

    await this.adapter.runTask(inputs, this.pluginRoot);

    // Seal the proposal before harvesting. `declaredChanges` is read from the
    // phase artifacts the plugin just wrote, so everything the manifest needs
    // already exists — and sealing here means a harvest failure costs the
    // delivery, not the candidate.
    if (candidate) await this.emitCandidateManifest(ctx, candidate);

    // Frozen mode skips the learning phases (improve, memory-consolidation), so
    // harvest must not require their artifacts — solve-only requires none. Train
    // and candidate mode (undefined → 'full') both run them; candidate mode only
    // changes WHERE they write, not whether they run. Keyed on the PLUGIN's mode
    // so an inline-mutation opt-out does not then fail harvest for the very
    // artifacts it just told the plugin not to produce.
    const phaseRange = mode === 'frozen' ? 'solve-only' : undefined;
    const solution = await harvestOutput(ctx.workingDir, phaseRange, ctx.task);
    return {
      ...solution,
      venueRef: { ...solution.venueRef, name: this.name },
    };
  }
}
