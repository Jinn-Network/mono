// operator/src/harnesses/impls/hermes-agent/adapter.ts
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { copyFileSync, createWriteStream, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import { HERMES_AGENT_HARNESS } from '../../names.js';
import {
  providerRefName,
  providerRefBaseUrl,
  providerRefAuthVar,
  isOpenRouterModelId,
  type ProviderRef,
} from '../../provider-ref.js';
import type { TaskSessionInputs } from '../learner/types.js';
import { writePerTaskHermesConfig } from './bootstrap.js';
import {
  assertResolvedHermesModelFromConfig,
  parseT31ResolvedModelGuardPolicy,
} from './resolved-model-guard.js';
import { buildInitialPrompt } from './prompt.js';
import type { ConfigBuilderEnv } from './config-builder.js';

const ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TERM', 'TMPDIR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'NODE_PATH', 'NODE_OPTIONS', 'NPM_CONFIG_PREFIX',
];

/**
 * Pattern allowlist for provider credentials.
 *
 * Without this passthrough, `hermes chat` spawns with a stripped env, hits
 * "Provider resolver returned an empty API key" and exits 1 ~14s after
 * launching (after plugin discovery + MCP registration but before the first
 * model call). The per-Task `.env` merge in `bootstrap.ts` only catches
 * operator API keys that live in `$HERMES_HOME/.env`; daemons launched with
 * `set -a; . <somewhere>/.env; set +a` (the substrate / autopilot pattern,
 * and any operator who keeps their key in shell env instead of
 * `~/.hermes/.env`) have the key in `process.env` but NOT in the per-Task
 * `.env`. Passing those through is the canonical path for shell-supplied
 * credentials and matches what `hermes doctor` / `hermes auth list` (which
 * the readiness probe shells out to) already see.
 *
 * Pattern is intentionally broad: any env var ending in `_API_KEY`,
 * `_API_TOKEN`, or `_TOKEN` is treated as a provider credential. Hermes
 * itself reads these by name (e.g. `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`,
 * `GOOGLE_API_KEY`, `XAI_API_KEY`, `GROQ_API_KEY`, …). Plus an explicit
 * carve-out for `OPENAI_API_KEY` (canonical OpenAI name doesn't end in
 * `_API_KEY` in some lists) and any `HERMES_*` knob the operator may have
 * set (e.g. `HERMES_ACCEPT_HOOKS`).
 */
const ENV_PATTERN_ALLOWLIST: readonly RegExp[] = [
  /_API_KEY$/,
  /_API_TOKEN$/,
  /_TOKEN$/,
  /^HERMES_/,
];

/**
 * Detects OpenRouter-style `<org>/<model>` model ids so the adapter can default
 * `--provider openrouter` for the catalog entries shipped in `HERMES_MODELS`.
 *
 * As of issue #1243, provider is FIRST-CLASS: it flows through the catalog →
 * join config → `joinedSolverNets` → `TaskSessionInputs.provider`, and a
 * load-time backfill stamps `provider: 'openrouter'` onto legacy `{model}`-only
 * joined entries. This inference is now the FINAL MIGRATION BRIDGE — it only
 * fires when neither a per-task `inputs.provider` nor a daemon-global
 * `hermesProvider` is set. Full removal is deferred because the top-level
 * operator `config.hermesModel` (hand-typed, no `hermesProvider`) is a separate
 * legacy path the joinedSolverNets backfill does not cover; deleting inference
 * outright would regress it. See the issue #1243 design note.
 */
function inferProviderFromModelId(modelId: string | undefined): string | undefined {
  return isOpenRouterModelId(modelId) ? 'openrouter' : undefined;
}

export interface HermesHarnessAdapterConfig {
  hermesPath?: string;
  hermesModel?: string;
  hermesProvider?: string;
  hermesBaseUrl?: string;
  daemonApiUrl: string;
  daemonApiToken: string;
  corpusEnv: ConfigBuilderEnv['corpusEnv'];
  storePath?: string;
  /**
   * The operator's real Hermes home — auth credentials are seeded from here
   * into each per-Task `$HERMES_HOME`. Defaults to `process.env.HERMES_HOME`
   * (if the operator customised it) or `~/.hermes`. Tests pass an empty dir to
   * make the seed a no-op.
   */
  operatorHermesHome?: string;
  _spawnFn?: typeof spawn;
}

/**
 * Snapshot the newest existing `session_*.json` mtime BEFORE the solve runs so
 * the post-solve lift can distinguish a record THIS run wrote from a prior
 * task's. Returns 0 when the dir is missing/unreadable or holds no records.
 */
function snapshotHermesSessionMtime(hermesHome: string): number {
  try {
    const sessionsDir = join(hermesHome, 'sessions');
    return readdirSync(sessionsDir)
      .filter((f) => /^session_.*\.json$/.test(f))
      .reduce((max, f) => Math.max(max, statSync(join(sessionsDir, f)).mtimeMs), 0);
  } catch {
    return 0;
  }
}

/**
 * Copies THIS run's `$HERMES_HOME/sessions/session_*.json` (Hermes's finished
 * session record) into `<workingDir>/.hermes-agent/session.json` so it (a)
 * rides system_snapshot — which tars only workingDir — and (b) is readable by
 * the hermes-session-json transcript-to-spans parser (#1670).
 *
 * `$HERMES_HOME` (= implStateDir) is shared and persistent across tasks of the
 * same solverType — NOT fresh per solve — so `sessions/` accumulates prior
 * tasks' records. We therefore lift only a record strictly newer than `sinceMs`
 * (the pre-spawn baseline). If no record post-dates the baseline (a solve that
 * wrote none), we degrade and lift nothing rather than bleed another task's
 * transcript into this task's signed snapshot and trajectory. Wrapped so any
 * failure only warns and never throws — a missing record must not fail an
 * otherwise-successful solve. The `.hermes-agent/` target dir already exists
 * (created on the spawn path before the child runs).
 */
function liftHermesSession(hermesHome: string, workingDir: string, sinceMs: number): void {
  try {
    const sessionsDir = join(hermesHome, 'sessions');
    const candidate = readdirSync(sessionsDir)
      .filter((f) => /^session_.*\.json$/.test(f))
      .map((f) => ({ f, m: statSync(join(sessionsDir, f)).mtimeMs }))
      .filter((e) => e.m > sinceMs)
      .sort((a, b) => b.m - a.m)[0];
    if (!candidate) return;
    copyFileSync(join(sessionsDir, candidate.f), join(workingDir, '.hermes-agent', 'session.json'));
  } catch (err) {
    console.warn(`hermes-agent: session record lift skipped: ${String(err)}`);
  }
}

function buildAgentEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  // Pattern passthrough — provider credentials supplied via the operator's
  // shell env (e.g. `set -a; . operator/.env; set +a`) must reach `hermes chat`
  // or it dies at first model call with "empty API key" / exit 1. See the
  // ENV_PATTERN_ALLOWLIST docstring above.
  for (const [key, value] of Object.entries(process.env)) {
    if (value == null || key in env) continue;
    if (ENV_PATTERN_ALLOWLIST.some((re) => re.test(key))) {
      env[key] = value;
    }
  }
  return { ...env, ...extra };
}

export class HermesHarnessAdapter {
  readonly name = HERMES_AGENT_HARNESS;

  private readonly hermesPath: string;
  private readonly hermesModel: string | undefined;
  private readonly hermesProvider: string | undefined;
  private readonly hermesBaseUrl: string | undefined;
  private readonly daemonApiUrl: string;
  private readonly daemonApiToken: string;
  private readonly corpusEnv: ConfigBuilderEnv['corpusEnv'];
  private readonly storePath: string | undefined;
  private readonly operatorHermesHome: string;
  private readonly spawnFn: typeof spawn;

  constructor(config: HermesHarnessAdapterConfig) {
    this.hermesPath = config.hermesPath ?? 'hermes';
    this.hermesModel = config.hermesModel;
    this.hermesProvider = config.hermesProvider;
    this.hermesBaseUrl = config.hermesBaseUrl;
    this.daemonApiUrl = config.daemonApiUrl;
    this.daemonApiToken = config.daemonApiToken;
    this.corpusEnv = config.corpusEnv;
    this.storePath = config.storePath;
    this.operatorHermesHome =
      config.operatorHermesHome ?? (process.env['HERMES_HOME']?.trim() || join(homedir(), '.hermes'));
    this.spawnFn = config._spawnFn ?? spawn;
  }

  async runTask(inputs: TaskSessionInputs): Promise<void> {
    const hermesHome = inputs.implStateDir;
    const model = this.hermesBaseUrl ? this.hermesModel : (inputs.model ?? inputs.claudeModel ?? this.hermesModel);
    // Provider resolution (issue #1243). Precedence, highest first:
    //   1. local `hermesBaseUrl` — an OpenAI-compatible endpoint must use
    //      Hermes' `custom` provider (unchanged local-endpoint behaviour).
    //   2. per-task `inputs.provider` — the first-class route stamped from the
    //      joined SolverNet catalog entry.
    //   3. daemon-global `hermesProvider`.
    //   4. legacy `inferProviderFromModelId(model)` — the final migration
    //      bridge (see its docstring); string form only.
    const resolvedProvider: ProviderRef | undefined = this.hermesBaseUrl
      ? { name: 'custom', baseUrl: this.hermesBaseUrl }
      : (inputs.provider ?? this.hermesProvider ?? inferProviderFromModelId(model));
    const provider = providerRefName(resolvedProvider);
    const providerBaseUrl = providerRefBaseUrl(resolvedProvider) ?? this.hermesBaseUrl;
    const providerAuthVar = providerRefAuthVar(resolvedProvider);

    // Step 1: bootstrap — seed auth from the operator's home, write config.yaml + .env.
    //
    // The MCP server (`operator/src/mcp/server.ts`) reads task identity from a
    // family of `DESIRED_STATE_*` env vars; without them, `submit_typed_payload`
    // fails with `missing_solver_type` and `get_task` returns an empty record.
    // Mirror what claude-code-learner / codex-code-learner adapters do.
    const taskContextJson = (() => {
      const ctx = inputs.taskBody?.['context'];
      if (!ctx || typeof ctx !== 'object') return '';
      try { return JSON.stringify(ctx); } catch { return ''; }
    })();
    writePerTaskHermesConfig({
      hermesHome,
      workingDir: inputs.workingDir,
      model,
      provider,
      baseUrl: providerBaseUrl,
      solverPluginRoots: inputs.pluginRoots ?? [],
      env: {
        storePath: this.storePath,
        daemonApiUrl: this.daemonApiUrl,
        daemonApiToken: this.daemonApiToken,
        corpusEnv: this.corpusEnv,
        task: {
          id: inputs.taskId,
          description: typeof inputs.taskBody?.description === 'string' ? inputs.taskBody.description : '',
          contextJson: taskContextJson,
          role: typeof inputs.taskBody?.role === 'string' ? inputs.taskBody.role : '',
          solverType: inputs.taskBody?.solverType ?? inputs.solverType ?? '',
          restorationRequestId: typeof inputs.taskBody?.restorationRequestId === 'string'
            ? inputs.taskBody.restorationRequestId : '',
          requestId: inputs.requestId ?? inputs.taskId,
          workingDir: inputs.workingDir,
        },
      },
      seedFrom: this.operatorHermesHome,
    });

    const t31ModelGuard = parseT31ResolvedModelGuardPolicy();
    if (t31ModelGuard) {
      assertResolvedHermesModelFromConfig({
        configPath: join(hermesHome, 'config.yaml'),
        requested: t31ModelGuard.requested,
        approvedOverride: t31ModelGuard.approvedOverride,
      });
    }

    // Step 2: build prompt + args.
    //
    // `hermes chat -q <prompt> -Q --yolo --accept-hooks` —
    //   -q PROMPT     single-query non-interactive mode
    //   -Q            quiet/programmatic (suppress banner, spinner, tool previews)
    //   --yolo        bypass dangerous-command approval prompts (hardline floor
    //                 — rm -rf /, mkfs, sudo password injection, etc. — still
    //                 blocks even with --yolo). Required for daemon-driven
    //                 execution: there is no human at a TTY to approve, so
    //                 without this flag any tirith "warn" or pattern-based
    //                 "dangerous command" verdict (e.g. git reset --hard,
    //                 chmod -R 777) drops to the default-deny prompt path and
    //                 the agent dead-ends. The per-Task workingDir is a fresh
    //                 sandboxed tmpdir, so blast radius is bounded.
    //   --accept-hooks  auto-approve any unseen shell hooks (config.yaml
    //                 `hooks:` declarations) without a TTY prompt.
    // Model/provider passed when the daemon or SolverNet config specifies
    // them; otherwise Hermes resolves from $HERMES_HOME/config.yaml. No `-w`
    // flag — `hermes chat` has `--worktree` (a boolean that makes Hermes
    // create a git worktree, which we do NOT want); the working directory is
    // set via the spawn cwd + `terminal.cwd` in the per-Task config.yaml.
    const prompt = buildInitialPrompt(inputs);
    const args: string[] = ['chat', '-q', prompt, '-Q', '--yolo', '--accept-hooks'];
    if (model) {
      args.push('--model', model);
    }
    if (provider) {
      args.push('--provider', provider);
    }

    // Inject a custom provider's credential env var when it is named and
    // present in `process.env` but would not otherwise pass the pattern
    // allowlist (e.g. a bespoke `MYENDPOINT_KEY`). See ENV_PATTERN_ALLOWLIST.
    const extraEnv: Record<string, string> = { HERMES_HOME: hermesHome };
    if (providerAuthVar && process.env[providerAuthVar]) {
      extraEnv[providerAuthVar] = process.env[providerAuthVar]!;
    } else if (providerAuthVar) {
      // The provider named a credential var but it is absent/empty in the
      // environment. Injection is skipped (behavior preserved); Hermes would
      // otherwise die later at the first model call with a generic "empty API
      // key" and no clue why. Name the missing var so it is diagnosable.
      console.warn(
        `[hermes-agent] provider authVar ${providerAuthVar} is not set — skipping credential injection; Hermes will fail at the first model call with an empty API key`,
      );
    }
    const env = buildAgentEnv(extraEnv);

    const spawnOpts: SpawnOptions = {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      cwd: inputs.workingDir,
    };

    // Step 3: spawn + lifecycle
    return new Promise<void>((resolvePromise, reject) => {
      const logDir = join(inputs.workingDir, '.hermes-agent');
      mkdirSync(logDir, { recursive: true });
      const stdoutLog = createWriteStream(join(logDir, 'stdout.log'), { flags: 'a' });
      const stderrLog = createWriteStream(join(logDir, 'stderr.log'), { flags: 'a' });
      const closeLogs = async (): Promise<void> => {
        if (!stdoutLog.writableEnded) stdoutLog.end();
        if (!stderrLog.writableEnded) stderrLog.end();
        await Promise.all([finished(stdoutLog), finished(stderrLog)]);
      };

      const sessionBaselineMs = snapshotHermesSessionMtime(hermesHome);
      const child: ChildProcess = this.spawnFn(this.hermesPath, args, spawnOpts);

      if (inputs.abort.aborted) {
        if (!child.killed) child.kill('SIGTERM');
      }
      const onAbort = () => {
        if (!child.killed) child.kill('SIGTERM');
      };
      inputs.abort.addEventListener('abort', onAbort);

      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => stdoutLog.write(d));
      child.stderr?.on('data', (d: Buffer) => {
        stderrLog.write(d);
        stderr += d.toString();
      });

      let settled = false;
      const settle = (cb: () => void, onLogErr: (e: Error) => void = reject) => {
        if (settled) return;
        settled = true;
        inputs.abort.removeEventListener('abort', onAbort);
        closeLogs().then(cb, onLogErr);
      };

      child.on('exit', (code, signal) => {
        settle(() => {
          if (code === 0) {
            // Lift the finished Hermes session record into workingDir so it
            // rides system_snapshot and the transcript-to-spans parser can read
            // it (#1670). Wrapped so a missing/failed lift never fails an
            // otherwise-successful solve (degrade, not fail).
            liftHermesSession(hermesHome, inputs.workingDir, sessionBaselineMs);
            resolvePromise();
          } else if (inputs.abort.aborted) {
            resolvePromise(); // graceful-abort exits are success
          } else {
            reject(new Error(
              `hermes-agent: child exited code=${code} signal=${signal}: ${stderr.slice(0, 500)}`,
            ));
          }
        });
      });

      child.on('error', (err) => {
        settle(() => reject(err), () => reject(err));
      });
    });
  }
}
