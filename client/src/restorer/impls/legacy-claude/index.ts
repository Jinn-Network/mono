/**
 * legacy-claude — RestorerImpl fallback for spec=undefined (health-check) intents.
 *
 * Wraps the existing ClaudeRunner so that intents with no spec.kind continue to
 * work via the RestorationEngine. Registered as the default fallback in the impl
 * registry (supports spec.kind === '').
 *
 * The engine calls findFor({ kind: '' }) for legacy intents because
 * PersistedIntent.specKind is null → coerced to '' in runImpl().
 */

import { type Runner, type RunnerContext } from '../../../runner/runner.js';
import type {
  RestorerImpl,
  RestorationContext,
  RestorationOutput,
  ReadyStatus,
  EnableResult,
  IntentEnableMetadata,
} from '../../types.js';
import { REQUIRES_LIVE_DAEMON_READINESS, SkippableError } from '../../types.js';
import type { RestorationResult } from '../../../types/index.js';

// ── Config ────────────────────────────────────────────────────────────────────

export interface LegacyClaudeConfig {
  runner: Runner;
  /** Passed to RunnerContext. Defaults to /tmp */
  workingDirectory?: string;
  /** Timeout in ms passed to runner. Defaults to 300000 */
  timeoutMs?: number;
  /** Passed to runner for artifact storage */
  storePath?: string;
  /** Daemon API URL for MCP server */
  daemonApiUrl?: string;
  /**
   * When true (e.g. synthetic registry), `isReady` reports the daemon is required.
   * Production daemon should omit.
   */
  stub?: boolean;
}

// ── Impl ──────────────────────────────────────────────────────────────────────

export class LegacyClaudeImpl implements RestorerImpl {
  readonly name = 'legacy-claude';
  readonly version = '1.0.0';

  constructor(private readonly config: LegacyClaudeConfig) {}

  /**
   * Supports the empty-string kind produced by the engine for intents with no spec.
   * Also supports explicitly undefined-kind intents routed by registry default config.
   */
  supports(ctx: { kind: string; type?: 'restoration' | 'evaluation' }): boolean {
    // legacy-claude handles restoration-type health-check intents with no spec.kind.
    // It never runs as an evaluator.
    if (ctx.type === 'evaluation') return false;
    return ctx.kind === '' || ctx.kind === 'legacy';
  }

  async canAttempt(): Promise<{ ok: true }> {
    return { ok: true };
  }

  async isReady(): Promise<ReadyStatus> {
    if (this.config.stub) return { ...REQUIRES_LIVE_DAEMON_READINESS };
    return { ready: true };
  }

  enableMetadata(): IntentEnableMetadata {
    return {
      description:
        'legacy-claude — handles health-check intents (no spec.kind). Always enabled.',
    };
  }

  async onEnable(_args: Record<string, string | undefined>): Promise<EnableResult> {
    return { status: 'ready' };
  }

  async run(ctx: RestorationContext): Promise<RestorationOutput> {
    const { intent, workingDir, log } = ctx;

    log({ level: 'info', msg: 'legacy-claude: starting', data: { requestId: intent.id } });

    const runnerCtx: RunnerContext = {
      requestId: intent.id,
      workingDirectory: workingDir ?? this.config.workingDirectory ?? '/tmp',
      timeoutMs: this.config.timeoutMs ?? 300_000,
      storePath: this.config.storePath,
      daemonApiUrl: this.config.daemonApiUrl,
    };

    let result: RestorationResult;
    try {
      result = await this.config.runner.run(intent, runnerCtx);
    } catch (err) {
      if (isClaudeUnavailableError(err)) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new SkippableError('claude_unavailable', detail);
      }
      throw err;
    }

    log({ level: 'info', msg: 'legacy-claude: runner completed', data: { hasData: !!result.data } });

    const output: RestorationOutput = {
      venueRef: { name: 'legacy' },
      gating: {
        result: result.data,
      },
      informational: {
        runnerResult: result.data,
        artifactCount: result.artifacts?.length ?? 0,
      },
      artifacts: [],
    };

    return output;
  }
}

export default LegacyClaudeImpl;

/**
 * Narrow heuristic: only match phrases that unambiguously indicate the Claude
 * CLI is unavailable (not logged in, quota exhausted, API key rejected).
 * Mirrors the former engine-level check (jinn-mono-7ee.4).
 */
function isClaudeUnavailableError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const claudeSpecificPhrases = [
    'claude auth',
    'claude not authenticated',
    'claude cli not found',
    'claude: command not found',
    'claude quota',
    'claude rate limit',
    'claude credit',
    'anthropic api key',
  ];
  if (claudeSpecificPhrases.some((p) => msg.includes(p))) return true;
  if (msg.includes('claude')) {
    const availabilityPhrases = [
      'not logged in',
      'please login',
      'please log in',
      'quota exhausted',
      'quota exceeded',
      'credit limit',
      'invalid api key',
      'api key not found',
    ];
    return availabilityPhrases.some((p) => msg.includes(p));
  }
  return false;
}
