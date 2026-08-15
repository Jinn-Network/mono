/**
 * claude-mcp-prediction — Harness for prediction.v1 that spawns a single
 * Claude Code session with two MCP tools (read_chainlink_price +
 * submit_prediction) and harvests the model's probability + rationale.
 *
 * Selected through SolverNet `harness` config; baseline
 * (prediction-v0-baseline) remains available as a deterministic override. Flip once the
 * isolation test (test/harnesses/impls/claude-mcp-prediction/isolation.test.ts)
 * is green on ≥3 separate runs.
 *
 * Structure mirrors claude-mcp-hyperliquid, minus trading, API wallet, safety
 * rails, and the session cadence loop. Single-shot only.
 */

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

import type { Harness, HarnessContext, Solution, ReadyStatus } from '../../types.js';
import { REQUIRES_LIVE_DAEMON_READINESS } from '../../types.js';
import type { Task } from '../../../types/task.js';
import { buildClaudeIsReady } from '../../../preflight/claude-auth.js';
import { PredictionV1TaskSchema } from '../../../types/prediction.js';

import { buildSessionPrompt } from './prompt.js';
import { PREDICTION_CONFIG } from './session-orchestrator.js';
import { writeMcpServerScript } from '../claude-mcp-shared/mcp-server-script.js';
import { runSingleSessionHarness } from '../claude-mcp-shared/single-session-harness.js';
import type { ClaudeMcpPredictionConfig, SubmissionState } from './types.js';

// ── Impl ──────────────────────────────────────────────────────────────────────

export class ClaudeMcpPredictionImpl implements Harness {
  readonly name = 'claude-mcp-prediction';
  readonly version = '1.0.0';

  constructor(private readonly config: ClaudeMcpPredictionConfig = {}) {}

  supports(ctx: { solverType: string; role?: 'restoration' | 'evaluation' }): boolean {
    return ctx.solverType === 'prediction.v1' && ctx.role !== 'evaluation';
  }

  async isReady(
    ctx?: { solverType: string; role?: 'restoration' | 'evaluation' },
  ): Promise<ReadyStatus> {
    if (this.config.stub) return { ...REQUIRES_LIVE_DAEMON_READINESS };
    // TODO(vh74.2-followup): docker-compose context not threaded through HarnessEnv for prediction harnesses yet
    return buildClaudeIsReady({
      getClaudePath: () => this.config.claudePath ?? 'claude',
      getContext: () => 'bare',
    })(ctx);
  }

  async canAttempt(
    task: Task,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const parsed = PredictionV1TaskSchema.safeParse(task);
    if (!parsed.success) return { ok: false, reason: `Invalid prediction.v1 task: ${parsed.error.message}` };
    if (Date.now() > parsed.data.window.endTs) return { ok: false, reason: 'window already closed' };
    return { ok: true };
  }

  async run(ctx: HarnessContext): Promise<Solution> {
    if (this.config.stub) {
      throw new Error('claude-mcp-prediction: stub registry cannot run (requires live daemon)');
    }
    const { task: task, workingDir, log } = ctx;
    const parsed = PredictionV1TaskSchema.parse(task);
    const testDeps = this.config._testDeps;

    // Shared submission state. The wrapper-subprocess writes to a JSONL file
    // (submissionLogPath); the orchestrator's isSubmitted poll + our final
    // read pull the record off disk. In test mode, _testDeps.runSession
    // invokes signalSubmit directly to bypass the subprocess.
    const submissionState: SubmissionState = {
      probability: null,
      rationale: null,
      submittedAt: null,
    };

    const signalSubmit = (probability: string, rationale: string): void => {
      submissionState.probability = probability;
      submissionState.rationale = rationale;
      submissionState.submittedAt = Date.now();
    };

    const sessionId = `pred-${Date.now()}`;
    const prompt = buildSessionPrompt(parsed, sessionId);
    const claudeModel = ctx.solverNet?.model ?? this.config.claudeModel;

    // ── Test-mode short-circuit ────────────────────────────────────────────────
    if (testDeps?.runSession) {
      const session = await testDeps.runSession({
        sessionId,
        prompt,
        mcpConfigPath: '<test>',
        workingDir,
        implStateDir: ctx.implStateDir,
        timeoutMs: this.config.sessionMaxMs ?? 180_000,
        signalSubmit,
      });
      return this._finalize(parsed, sessionId, session.transcriptPath, submissionState, session.startedAt, session.endedAt, claudeModel);
    }

    // ── Live path ──────────────────────────────────────────────────────────────
    log({ level: 'info', msg: 'claude-mcp-prediction: spawning session', data: { sessionId } });

    const session = await runSingleSessionHarness(
      {
        sessionId,
        prompt,
        workingDir,
        wrapperBasename: 'prediction-server',
        mcpServerKey: 'jinn-prediction',
        sessionConfig: PREDICTION_CONFIG,
        buildWrapperConfig: (submissionLogPath) => ({
          feed: parsed.spec.oracle.feed,
          feedDescription: parsed.spec.oracle.feedDescription,
          venue: parsed.spec.oracle.venue,
          rpcUrl: this.config.rpcUrl ?? this._defaultRpcUrl(parsed.spec.oracle.venue),
          submissionLogPath,
        }),
        writeScript: _writePredictionMcpServerScript,
        onRecord: (record) => {
          const r = record as { probability?: unknown; rationale?: unknown };
          if (typeof r.probability === 'string' && typeof r.rationale === 'string') {
            signalSubmit(r.probability, r.rationale);
            return true;
          }
          return false;
        },
      },
      {
        claudePath: this.config.claudePath ?? 'claude',
        ...(claudeModel ? { claudeModel } : {}),
        abort: ctx.abort,
        log,
        ...(this.config.sessionMaxMs !== undefined ? { sessionMaxMs: this.config.sessionMaxMs } : {}),
      },
    );

    return this._finalize(parsed, sessionId, session.transcriptPath, submissionState, session.startedAt, session.endedAt, claudeModel);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private _finalize(
    task: import('../../../types/prediction.js').PredictionV1Task,
    sessionId: string,
    transcriptPath: string,
    submission: SubmissionState,
    startedAt: number,
    endedAt: number,
    claudeModel?: string,
  ): Solution {
    if (!submission.probability || !submission.rationale) {
      throw new Error(
        `claude-mcp-prediction: session ${sessionId} ended without a valid submit_prediction call`,
      );
    }

    const submittedAt = submission.submittedAt ?? Date.now();
    const modelId = `claude-mcp-prediction.${claudeModel ?? 'default'}.v1`;

    const predictionPath = join(dirname(transcriptPath), '..', '..', 'prediction.json');
    writeFileSync(
      predictionPath,
      JSON.stringify({
        probability: submission.probability,
        submittedAt,
        modelId,
        rationale: submission.rationale,
      }, null, 2),
      { encoding: 'utf-8' },
    );

    return {
      venueRef: { name: 'chainlink' },
      gating: {
        probability: submission.probability,
        submittedAt: String(submittedAt),
        modelId,
      },
      informational: {
        rationale: submission.rationale,
        sessionId,
        transcriptPath,
        feed: task.spec.oracle.feed,
        venue: task.spec.oracle.venue,
        sessionDurationMs: endedAt - startedAt,
      },
      solutionPayload: {
        prediction: {
          probability: submission.probability,
          submittedAt,
          modelId,
        },
        // rationale is a free-form string from the LLM; the schema expects
        // Array<{ ts: number; note: string }>, so we do not include it here
        // (it lives in informational only). A future task can parse / wrap it.
      },
      artifacts: [
        { path: 'prediction.json', artifactType: 'prediction_submission' },
        {
          path: transcriptPath,
          artifactType: 'session_transcript',
          metadata: { sessionId, startedAt, endedAt },
        },
      ],
    };
  }

  private _defaultRpcUrl(venue: 'chainlink-base' | 'chainlink-base-sepolia'): string {
    return venue === 'chainlink-base' ? 'https://mainnet.base.org' : 'https://sepolia.base.org';
  }
}

// ── Wrapper-script writer ─────────────────────────────────────────────────────

/**
 * Generate a wrapper script that spawns the jinn-prediction MCP server.
 * Delegates to the shared writer, resolving the sibling compiled mcp-tools.js
 * off this module's own import.meta.url.
 */
export function _writePredictionMcpServerScript(outPath: string): void {
  writeMcpServerScript(outPath, { callerFileUrl: import.meta.url, serverLabel: 'jinn-prediction' });
}

export default ClaudeMcpPredictionImpl;
