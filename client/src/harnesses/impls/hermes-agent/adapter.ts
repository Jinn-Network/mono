// client/src/harnesses/impls/hermes-agent/adapter.ts
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import { HERMES_AGENT_HARNESS } from '../../names.js';
import type { TaskSessionInputs } from '../learner/types.js';
import { writePerTaskHermesConfig } from './bootstrap.js';
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
 * `set -a; . <somewhere>/.env; set +a` (the substrate / eng-loop pattern,
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
 * This is a v0.1.6 PATCH — it routes the catalog correctly today by exploiting
 * the fact that every catalog entry happens to be OpenRouter-routed. The
 * PROPER fix is provider as a first-class field on the catalog + join config
 * (gh issue #295); when that lands, this inference goes away.
 *
 * Explicit `hermesProvider` always wins — this fallback only fires when nothing
 * was configured at the join site.
 */
const OPENROUTER_MODEL_FORMAT = /^[a-z0-9_-]+\/[a-z0-9_.\-:]+$/i;
function inferProviderFromModelId(modelId: string | undefined): string | undefined {
  if (!modelId) return undefined;
  return OPENROUTER_MODEL_FORMAT.test(modelId) ? 'openrouter' : undefined;
}

export interface HermesHarnessAdapterConfig {
  hermesPath?: string;
  hermesModel?: string;
  hermesProvider?: string;
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

function buildAgentEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  // Pattern passthrough — provider credentials supplied via the operator's
  // shell env (e.g. `set -a; . client/.env; set +a`) must reach `hermes chat`
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
    const model = inputs.model ?? inputs.claudeModel ?? this.hermesModel;
    // Provider resolution: explicit `hermesProvider` wins. If unset, fall back
    // to inference from the model id format. See `inferProviderFromModelId`
    // above + gh #293 / #295.
    const provider = this.hermesProvider ?? inferProviderFromModelId(model);

    // Step 1: bootstrap — seed auth from the operator's home, write config.yaml + .env.
    //
    // The MCP server (`client/src/mcp/server.ts`) reads task identity from a
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

    const env = buildAgentEnv({
      HERMES_HOME: hermesHome,
    });

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
