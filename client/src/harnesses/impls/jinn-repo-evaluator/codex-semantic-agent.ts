import { spawn } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  SemanticAgentRunner,
  SemanticAgentRunnerInput,
  SemanticRuntimeReadiness,
} from './autopilot-semantic.js';
import {
  parseCodexVersion,
  requireChatGptOAuth,
} from '../../codex-auth.js';
import { CODEX_REVIEW_OUTPUT_SCHEMA } from './codex-review-output-schema.js';
import {
  runSupervisedProcess,
  SupervisedProcessUnreapedError,
} from './supervised-process.js';

const CODEX_SEMANTIC_MODEL = 'gpt-5.4-mini';
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const READINESS_OUTPUT_BYTES = 64 * 1024;
const PASSTHROUGH = [
  'PATH',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
] as const;

const DISABLED_FEATURES = [
  'plugins',
  'shell_tool',
  'unified_exec',
  'apps',
  'browser_use',
  'computer_use',
  'image_generation',
  'in_app_browser',
  'browser_use_external',
  'multi_agent',
  'hooks',
  'fast_mode',
  'network_proxy',
  'standalone_web_search',
  'web_search_cached',
  'web_search_request',
  'memories',
  'goals',
  'tool_suggest',
  'tool_call_mcp_elicitation',
  'skill_mcp_dependency_install',
  'workspace_dependencies',
] as const;

const REQUIRED_EXEC_HELP_OPTIONS = [
  '--json',
  '--ephemeral',
  '--strict-config',
  '--ignore-user-config',
  '--ignore-rules',
  '--disable',
  '--sandbox',
  '--skip-git-repo-check',
  '--output-schema',
  '-C',
  '--model',
] as const;

export interface CodexSemanticAgentRunnerOptions {
  readonly codexPath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly inspectOAuth?: typeof requireChatGptOAuth;
  readonly spawn?: typeof spawn;
  readonly makeTempDir?: () => Promise<string>;
  readonly copyFile?: (source: string, target: string) => Promise<void>;
  readonly chmod?: (path: string, mode: number) => Promise<void>;
  readonly writeFile?: (
    path: string,
    data: string,
    options: { readonly mode: number },
  ) => Promise<void>;
  readonly remove?: (path: string) => Promise<void>;
  readonly killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
  readonly terminationGraceMs?: number;
  readonly reapTimeoutMs?: number;
  readonly readinessTimeoutMs?: number;
  readonly readinessCacheMs?: number;
}

function semanticEnvironment(
  isolatedHome: string,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const passthrough: NodeJS.ProcessEnv = {};
  for (const key of PASSTHROUGH) {
    if (environment[key]) passthrough[key] = environment[key];
  }
  return {
    ...passthrough,
    HOME: isolatedHome,
    CODEX_HOME: isolatedHome,
    XDG_CONFIG_HOME: join(isolatedHome, 'xdg-config'),
    XDG_DATA_HOME: join(isolatedHome, 'xdg-data'),
    XDG_CACHE_HOME: join(isolatedHome, 'xdg-cache'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    NO_COLOR: '1',
  };
}

function semanticArgs(
  isolatedHome: string,
  terminal: '-' | '--help',
): string[] {
  const args = [
    'exec',
    '--json',
    '--ephemeral',
    '--strict-config',
    '--ignore-user-config',
    '--ignore-rules',
  ];
  for (const feature of DISABLED_FEATURES) {
    args.push('--disable', feature);
  }
  args.push(
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '--output-schema',
    join(isolatedHome, 'review-output.schema.json'),
    '-C',
    join(isolatedHome, 'work'),
    '-m',
    CODEX_SEMANTIC_MODEL,
    terminal,
  );
  return args;
}

function safeExecutionError(error: unknown): Error {
  if (
    error instanceof SupervisedProcessUnreapedError
    || (
      typeof error === 'object'
      && error !== null
      && (error as { cleanupUnsafe?: unknown }).cleanupUnsafe === true
    )
  ) {
    return new SupervisedProcessUnreapedError('codex semantic evaluator');
  }
  if (error instanceof Error && error.name === 'AbortError') {
    const safe = new Error('Codex semantic evaluator aborted');
    safe.name = 'AbortError';
    return safe;
  }

  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('Process output exceeded')) {
    return new Error(
      `Codex semantic evaluator output exceeded ${MAX_OUTPUT_BYTES} bytes`,
    );
  }
  if (message.startsWith('Malformed Codex JSONL')) {
    return new Error('Malformed Codex JSONL from semantic evaluator');
  }
  if (message === 'Codex JSONL contained no final assistant message') {
    return new Error('Codex semantic evaluator returned no final assistant message');
  }
  if (message === 'Codex semantic evaluator reported turn.failed') {
    return new Error('Codex semantic evaluator reported turn.failed');
  }
  if (
    message
    === 'Codex semantic evaluator did not complete with a successful terminal turn'
  ) {
    return new Error(
      'Codex semantic evaluator did not complete with a successful terminal turn',
    );
  }
  return new Error('Codex semantic evaluator execution failed');
}

function parseFinalAgentMessage(stdout: string): string {
  let finalMessage: string | undefined;
  let completedAfterFinalMessage = false;
  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `Malformed Codex JSONL: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const event = parsed as Record<string, unknown>;
    if (event['type'] === 'turn.failed') {
      throw new Error('Codex semantic evaluator reported turn.failed');
    }
    if (event['type'] === 'turn.interrupted') {
      throw new Error(
        'Codex semantic evaluator did not complete with a successful terminal turn',
      );
    }
    if (event['type'] === 'turn.started') {
      finalMessage = undefined;
      completedAfterFinalMessage = false;
      continue;
    }
    if (event['type'] === 'turn.completed') {
      if (finalMessage !== undefined) completedAfterFinalMessage = true;
      continue;
    }
    if (event['type'] !== 'item.completed') continue;
    const item = event['item'];
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const itemRecord = item as Record<string, unknown>;
    if (
      itemRecord['type'] === 'agent_message'
      && typeof itemRecord['text'] === 'string'
    ) {
      finalMessage = itemRecord['text'];
      completedAfterFinalMessage = false;
    }
  }
  if (!completedAfterFinalMessage) {
    throw new Error(
      'Codex semantic evaluator did not complete with a successful terminal turn',
    );
  }
  if (finalMessage === undefined) {
    throw new Error('Codex JSONL contained no final assistant message');
  }
  return finalMessage;
}

export class CodexSemanticAgentRunner implements SemanticAgentRunner {
  private readonly codexPath: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly inspectOAuth: typeof requireChatGptOAuth;
  private readonly spawnFn: typeof spawn;
  private readonly makeTempDir: () => Promise<string>;
  private readonly copyFileFn: (source: string, target: string) => Promise<void>;
  private readonly chmodFn: (path: string, mode: number) => Promise<void>;
  private readonly writeFileFn: (
    path: string,
    data: string,
    options: { readonly mode: number },
  ) => Promise<void>;
  private readonly remove: (path: string) => Promise<void>;
  private readonly killProcessGroup: (
    pid: number,
    signal: NodeJS.Signals,
  ) => void;
  private readonly terminationGraceMs: number | undefined;
  private readonly reapTimeoutMs: number | undefined;
  private readonly readinessTimeoutMs: number;
  private readonly readinessCacheMs: number;
  private readiness:
    | { checkedAt: number; status: SemanticRuntimeReadiness }
    | undefined;
  private readinessInFlight: Promise<SemanticRuntimeReadiness> | undefined;

  constructor(options: CodexSemanticAgentRunnerOptions = {}) {
    this.codexPath = options.codexPath ?? 'codex';
    this.environment = options.environment ?? process.env;
    this.inspectOAuth = options.inspectOAuth ?? requireChatGptOAuth;
    this.spawnFn = options.spawn ?? spawn;
    this.makeTempDir =
      options.makeTempDir
      ?? (() => mkdtemp(join(tmpdir(), 'jinn-codex-semantic-home-')));
    this.copyFileFn = options.copyFile ?? copyFile;
    this.chmodFn = options.chmod ?? chmod;
    this.writeFileFn = options.writeFile ?? (
      (path, data, writeOptions) => writeFile(path, data, writeOptions)
    );
    this.remove =
      options.remove
      ?? ((path) => rm(path, { recursive: true, force: true }));
    this.killProcessGroup =
      options.killProcessGroup
      ?? ((pid, signal) => process.kill(-pid, signal));
    this.terminationGraceMs = options.terminationGraceMs;
    this.reapTimeoutMs = options.reapTimeoutMs;
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? 5_000;
    this.readinessCacheMs = options.readinessCacheMs ?? 30_000;
  }

  async isReady(): Promise<SemanticRuntimeReadiness> {
    if (
      this.readiness
      && Date.now() - this.readiness.checkedAt < this.readinessCacheMs
    ) {
      return this.readiness.status;
    }
    if (this.readinessInFlight) return await this.readinessInFlight;

    const probe = this.probeReadiness();
    this.readinessInFlight = probe;
    try {
      const status = await probe;
      this.readiness = { checkedAt: Date.now(), status };
      return status;
    } finally {
      if (this.readinessInFlight === probe) this.readinessInFlight = undefined;
    }
  }

  private async probeReadiness(): Promise<SemanticRuntimeReadiness> {
    let auth;
    try {
      auth = this.inspectOAuth({ environment: this.environment });
    } catch {
      return {
        ready: false,
        reason: 'Codex semantic evaluator OAuth check failed',
      };
    }
    if (!auth.ready) {
      return {
        ready: false,
        reason: 'Codex semantic evaluator requires ChatGPT OAuth',
      };
    }

    let isolatedHome: string;
    try {
      isolatedHome = await this.makeTempDir();
    } catch {
      return {
        ready: false,
        reason: 'Codex semantic evaluator unavailable',
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.readinessTimeoutMs,
    );
    timeout.unref?.();
    let cleanupSafe = true;
    let status: SemanticRuntimeReadiness;
    try {
      await this.prepareDirectories(isolatedHome);
      await this.writeTrustedSchema(isolatedHome);
      const processOptions = {
        cwd: join(isolatedHome, 'work'),
        env: semanticEnvironment(isolatedHome, this.environment),
        abort: controller.signal,
        maxOutputBytes: READINESS_OUTPUT_BYTES,
        spawn: this.spawnFn,
        killProcessGroup: this.killProcessGroup,
        ...(this.terminationGraceMs === undefined
          ? {}
          : { terminationGraceMs: this.terminationGraceMs }),
        ...(this.reapTimeoutMs === undefined
          ? {}
          : { reapTimeoutMs: this.reapTimeoutMs }),
      };
      const versionResult = await runSupervisedProcess(
        this.codexPath,
        ['--version'],
        processOptions,
      );
      const version = parseCodexVersion(versionResult.stdout);
      const canonicalVersionOutput =
        version !== null
        && versionResult.stdout.trim() === `codex-cli ${version}`;
      if (!canonicalVersionOutput) {
        status = {
          ready: false,
          reason:
            'Codex semantic evaluator requires canonical `codex-cli <version>` output',
        };
      } else if (!version.startsWith('0.136.')) {
        status = {
          ready: false,
          reason:
            `Codex semantic evaluator requires Codex CLI 0.136.x; installed version was ${version}`,
        };
      } else {
        const helpResult = await runSupervisedProcess(
          this.codexPath,
          ['exec', '--help'],
          processOptions,
        );
        const missingOption = REQUIRED_EXEC_HELP_OPTIONS.find(
          (option) => !helpResult.stdout.includes(option),
        );
        if (missingOption) {
          status = {
            ready: false,
            reason:
              `Codex semantic evaluator CLI does not advertise required ${missingOption}`,
          };
        } else {
          const featuresResult = await runSupervisedProcess(
            this.codexPath,
            ['features', 'list'],
            processOptions,
          );
          const advertisedFeatures = new Set(
            featuresResult.stdout
              .split(/\r?\n/u)
              .map((line) => line.trim().split(/\s+/u)[0])
              .filter((feature): feature is string => Boolean(feature)),
          );
          const missingFeature = DISABLED_FEATURES.find(
            (feature) => !advertisedFeatures.has(feature),
          );
          if (missingFeature) {
            status = {
              ready: false,
              reason:
                `Codex semantic evaluator CLI does not advertise disabled feature ${missingFeature}`,
            };
          } else {
            await runSupervisedProcess(
              this.codexPath,
              semanticArgs(isolatedHome, '--help'),
              processOptions,
            );
            status = { ready: true };
          }
        }
      }
    } catch (error) {
      if (error instanceof SupervisedProcessUnreapedError) cleanupSafe = false;
      status = {
        ready: false,
        reason: 'Codex semantic evaluator unavailable',
      };
    } finally {
      clearTimeout(timeout);
    }

    if (cleanupSafe) {
      try {
        await this.remove(isolatedHome);
      } catch {
        status = {
          ready: false,
          reason: 'Codex semantic evaluator readiness cleanup failed',
        };
      }
    }
    return status;
  }

  private async prepareDirectories(isolatedHome: string): Promise<void> {
    await Promise.all([
      mkdir(join(isolatedHome, 'work'), { recursive: true }),
      mkdir(join(isolatedHome, 'xdg-config'), { recursive: true }),
      mkdir(join(isolatedHome, 'xdg-data'), { recursive: true }),
      mkdir(join(isolatedHome, 'xdg-cache'), { recursive: true }),
    ]);
  }

  private async writeTrustedSchema(isolatedHome: string): Promise<void> {
    await this.writeFileFn(
      join(isolatedHome, 'review-output.schema.json'),
      JSON.stringify(CODEX_REVIEW_OUTPUT_SCHEMA),
      { mode: 0o600 },
    );
  }

  async run(input: SemanticAgentRunnerInput): Promise<string> {
    if (input.model !== undefined && input.model !== CODEX_SEMANTIC_MODEL) {
      throw new Error(
        `Codex semantic evaluator requires exact model ${CODEX_SEMANTIC_MODEL}`,
      );
    }
    let auth;
    try {
      auth = this.inspectOAuth({ environment: this.environment });
    } catch {
      throw new Error('Codex semantic evaluator OAuth check failed');
    }
    if (!auth.ready) {
      throw new Error('Codex semantic evaluator requires ChatGPT OAuth');
    }

    let isolatedHome: string;
    try {
      isolatedHome = await this.makeTempDir();
    } catch {
      throw new Error('Codex semantic evaluator setup failed');
    }
    let cleanupSafe = true;
    let output: string | undefined;
    let primaryError: unknown;
    try {
      await this.prepareDirectories(isolatedHome);
      const stagedAuthPath = join(isolatedHome, 'auth.json');
      await this.copyFileFn(auth.authFilePath, stagedAuthPath);
      await this.chmodFn(stagedAuthPath, 0o600);
      await this.writeTrustedSchema(isolatedHome);

      const result = await runSupervisedProcess(
        this.codexPath,
        semanticArgs(isolatedHome, '-'),
        {
          cwd: join(isolatedHome, 'work'),
          env: semanticEnvironment(isolatedHome, this.environment),
          input: input.prompt,
          abort: input.abort,
          maxOutputBytes: MAX_OUTPUT_BYTES,
          spawn: this.spawnFn,
          killProcessGroup: this.killProcessGroup,
          ...(this.terminationGraceMs === undefined
            ? {}
            : { terminationGraceMs: this.terminationGraceMs }),
          ...(this.reapTimeoutMs === undefined
            ? {}
            : { reapTimeoutMs: this.reapTimeoutMs }),
        },
      );
      output = parseFinalAgentMessage(result.stdout);
    } catch (error) {
      primaryError = safeExecutionError(error);
      if (
        error instanceof SupervisedProcessUnreapedError
        || (
          typeof error === 'object'
          && error !== null
          && (error as { cleanupUnsafe?: unknown }).cleanupUnsafe === true
        )
      ) {
        cleanupSafe = false;
      }
    }

    if (cleanupSafe) {
      try {
        await this.remove(isolatedHome);
      } catch {
        if (primaryError === undefined) {
          primaryError = new Error(
            'Codex semantic evaluator cleanup failed',
          );
        }
      }
    }
    if (primaryError !== undefined) throw primaryError;
    return output!;
  }
}
