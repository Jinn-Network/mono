/**
 * legacy-claude — Harness fallback for health-check Tasks with no solverType.
 *
 * Wraps the existing ClaudeRunner so that Tasks with no solverType continue to
 * work via the TaskEngine. Registered as the default fallback in the Harness
 * registry (supports solverType === '').
 *
 * The engine calls findFor({ solverType: '' }) for these Tasks because
 * PersistedTaskRun.solverType is null → coerced to '' in runImpl().
 */

import { type Runner, type RunnerContext } from '../../../runner/runner.js';
import type {
  Harness,
  HarnessContext,
  Solution,
  ReadyStatus,
  EnableResult,
  HarnessEnableMetadata,
} from '../../types.js';
import { REQUIRES_LIVE_DAEMON_READINESS, SkippableError } from '../../types.js';
import type { TaskResult } from '../../../types/index.js';
import { Store } from '../../../store/store.js';

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
   * Bearer token for daemon API cost-mutating routes. Forwarded to the MCP
   * subprocess via `DAEMON_API_TOKEN` env var.
   */
  daemonApiToken?: string;
  /**
   * Corpus credentials forwarded to {@link RunnerContext.corpusEnv} so MCP
   * `search_records` / `inspect_record` can hit the keyless subgraph + IPFS
   * gateway. The agent EOA private key never crosses into the subprocess —
   * `acquire_artifact` proxies through `daemonApiUrl` (with `daemonApiToken`).
   */
  corpusEnv?: RunnerContext['corpusEnv'];
  /**
   * When true (e.g. synthetic registry), `isReady` reports the daemon is required.
   * Production daemon should omit.
   */
  stub?: boolean;
}

// ── Impl ──────────────────────────────────────────────────────────────────────

export class LegacyClaudeImpl implements Harness {
  readonly name = 'legacy-claude';
  readonly version = '1.0.0';

  constructor(private readonly config: LegacyClaudeConfig) {}

  /**
   * Supports the empty-string solverType produced by the engine for Tasks with no solverType.
   * Legacy release-acceptance jobs use no SolverType for both restoration and evaluation,
   * so both phases route through the Claude runner.
   */
  supports(ctx: { solverType: string; role?: 'restoration' | 'evaluation' }): boolean {
    return ctx.solverType === '' || ctx.solverType === 'legacy';
  }

  async canAttempt(): Promise<{ ok: true }> {
    return { ok: true };
  }

  async isReady(): Promise<ReadyStatus> {
    if (this.config.stub) return { ...REQUIRES_LIVE_DAEMON_READINESS };
    return { ready: true };
  }

  enableMetadata(): HarnessEnableMetadata {
    return {
      description:
        'legacy-claude — handles health-check tasks (no solverType). Always enabled.',
    };
  }

  async onEnable(_ctx: { args: Record<string, string | undefined> }): Promise<EnableResult> {
    return { status: 'ready' };
  }

  async run(ctx: HarnessContext): Promise<Solution> {
    const { task: task, workingDir, log } = ctx;

    log({ level: 'info', msg: 'legacy-claude: starting', data: { requestId: task.id } });

    const runnerCtx: RunnerContext = {
      requestId: task.id,
      workingDirectory: workingDir ?? this.config.workingDirectory ?? '/tmp',
      timeoutMs: this.config.timeoutMs ?? 300_000,
      storePath: this.config.storePath,
      daemonApiUrl: this.config.daemonApiUrl,
      daemonApiToken: this.config.daemonApiToken,
      corpusEnv: this.config.corpusEnv,
    };

    let result: TaskResult;
    try {
      result = await this.config.runner.run(task, runnerCtx);
    } catch (err) {
      if (isClaudeUnavailableError(err)) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new SkippableError('claude_unavailable', detail);
      }
      throw err;
    }

    const resultTag = task.role === 'evaluation' ? 'evaluation-verdict' : 'restoration-result';
    const recoveredData = result.data || await this.recoverPublishedArtifact(task.id, resultTag);
    const artifactCount = result.artifacts?.length ?? (recoveredData ? 1 : 0);

    log({ level: 'info', msg: 'legacy-claude: runner completed', data: { hasData: !!recoveredData } });

	    const output: Solution = {
	      venueRef: { name: 'legacy' },
	      gating: {
	        result: recoveredData,
      },
      informational: {
        runnerResult: recoveredData,
        artifactCount,
      },
	      artifacts: [],
	    };

	    if (task.role === 'evaluation') {
	      output.verdictPayload = legacyVerdictPayload(task, recoveredData);
	    }

	    return output;
	  }

  private async recoverPublishedArtifact(
    taskId: string,
    tag: 'restoration-result' | 'evaluation-verdict',
  ): Promise<string> {
    if (!this.config.storePath) return '';

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const store = new Store(this.config.storePath);
      try {
        const [artifact] = store.searchArtifacts({
          taskId,
          tags: [tag],
          limit: 1,
        });
        if (artifact?.content) return artifact.content;
      } finally {
        store.close();
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return '';
  }
}

export default LegacyClaudeImpl;

function legacyVerdictPayload(task: { id: string; description: string }, recoveredData: string): Record<string, unknown> {
  if (recoveredData) {
    try {
      const parsed = JSON.parse(recoveredData) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Fall through to a legacy wrapper for non-JSON runner output.
    }
  }

  return {
    protocol: 'jinn-client/v1',
    type: 'evaluation-verdict',
    requestId: task.id,
    taskId: task.id,
    success: Boolean(recoveredData),
    reason: recoveredData || `Legacy evaluation completed for "${task.description}"`,
    data: recoveredData,
    evaluatedAt: new Date().toISOString(),
  };
}

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
