// client/src/harnesses/impls/hermes-agent/adapter.ts
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import type { TaskSessionInputs } from '../learner/types.js';
import { writePerTaskHermesConfig } from './bootstrap.js';
import { buildInitialPrompt } from './prompt.js';
import type { ConfigBuilderEnv } from './config-builder.js';

const ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TERM', 'TMPDIR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'NODE_PATH', 'NODE_OPTIONS', 'NPM_CONFIG_PREFIX',
];

export interface HermesHarnessAdapterConfig {
  hermesPath?: string;
  hermesModel?: string;
  hermesProvider?: string;
  daemonApiUrl: string;
  daemonApiToken: string;
  corpusEnv: ConfigBuilderEnv['corpusEnv'];
  storePath?: string;
  _spawnFn?: typeof spawn;
}

function buildAgentEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return { ...env, ...extra };
}

export class HermesHarnessAdapter {
  readonly name = 'hermes-agent';

  private readonly hermesPath: string;
  private readonly hermesModel: string | undefined;
  private readonly hermesProvider: string | undefined;
  private readonly daemonApiUrl: string;
  private readonly daemonApiToken: string;
  private readonly corpusEnv: ConfigBuilderEnv['corpusEnv'];
  private readonly storePath: string | undefined;
  private readonly spawnFn: typeof spawn;

  constructor(config: HermesHarnessAdapterConfig) {
    this.hermesPath = config.hermesPath ?? 'hermes';
    this.hermesModel = config.hermesModel;
    this.hermesProvider = config.hermesProvider;
    this.daemonApiUrl = config.daemonApiUrl;
    this.daemonApiToken = config.daemonApiToken;
    this.corpusEnv = config.corpusEnv;
    this.storePath = config.storePath;
    this.spawnFn = config._spawnFn ?? spawn;
  }

  async runTask(inputs: TaskSessionInputs): Promise<void> {
    const hermesHome = inputs.implStateDir;
    const model = inputs.model ?? this.hermesModel;

    // Step 1: bootstrap — write config.yaml + .env
    writePerTaskHermesConfig({
      hermesHome,
      workingDir: inputs.workingDir,
      model,
      provider: this.hermesProvider,
      solverPluginRoots: inputs.pluginRoots ?? [],
      env: {
        storePath: this.storePath,
        daemonApiUrl: this.daemonApiUrl,
        daemonApiToken: this.daemonApiToken,
        corpusEnv: this.corpusEnv,
      },
    });

    // Step 2: build prompt + args
    const prompt = buildInitialPrompt(inputs);
    const args: string[] = ['chat', '-q', prompt];
    if (model) {
      args.push('--model', model);
    }
    if (this.hermesProvider) {
      args.push('--provider', this.hermesProvider);
    }
    args.push('-w', inputs.workingDir);

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
