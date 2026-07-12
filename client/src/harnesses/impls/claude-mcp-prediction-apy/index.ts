/**
 * claude-mcp-prediction-apy — Harness for prediction.apy.v0 that spawns a
 * single Claude Code session with read_aave_reserve + submit_apy_prediction.
 *
 * Selected through SolverNet `harness` config; baseline remains available as a deterministic override.
 * Isolation gate: test/harnesses/impls/claude-mcp-prediction-apy/isolation.test.ts
 */

import { writeFileSync, mkdirSync, readFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createPublicClient, http } from 'viem';
import { base, baseSepolia, mainnet } from 'viem/chains';
import type { PublicClient } from 'viem';

import type {
  Harness,
  HarnessContext,
  Solution,
  ReadyStatus,
  EnableResult,
  HarnessEnableMetadata,
} from '../../types.js';
import { REQUIRES_LIVE_DAEMON_READINESS } from '../../types.js';
import type { Task } from '../../../types/task.js';
import { buildClaudeIsReady } from '../../../preflight/claude-auth.js';
import { PredictionApyV0TaskSchema } from '../../../types/prediction-apy.js';

import { buildSessionPrompt } from './prompt.js';
import { spawnSession } from './session-orchestrator.js';
import { writeMcpServerScript } from '../claude-mcp-shared/mcp-server-script.js';
import type { ClaudeMcpPredictionApyConfig, SubmissionState, AaveV3Venue } from './types.js';

function chainForVenue(venue: AaveV3Venue) {
  if (venue === 'aave-v3-base-sepolia') return { chain: baseSepolia, chainId: 84532 };
  if (venue === 'aave-v3-mainnet') return { chain: mainnet, chainId: 1 };
  return { chain: base, chainId: 8453 };
}

export class ClaudeMcpPredictionApyImpl implements Harness {
  readonly name = 'claude-mcp-prediction-apy';
  readonly version = '1.0.0';

  constructor(private readonly config: ClaudeMcpPredictionApyConfig = {}) {}

  supports(ctx: { solverType: string; role?: 'restoration' | 'evaluation' }): boolean {
    return ctx.solverType === 'prediction.apy.v0' && ctx.role !== 'evaluation';
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

  enableMetadata(): HarnessEnableMetadata {
    return {
      description: 'prediction.apy.v0 — Claude + MCP reads Aave reserve APY and submits predicted bps.',
    };
  }

  async onEnable(_ctx: { args: Record<string, string | undefined> }): Promise<EnableResult> {
    return { status: 'ready' };
  }

  async canAttempt(task: Task): Promise<{ ok: true } | { ok: false; reason: string }> {
    const parsed = PredictionApyV0TaskSchema.safeParse(task);
    if (!parsed.success) return { ok: false, reason: `Invalid prediction.apy.v0 task: ${parsed.error.message}` };
    if (Date.now() > parsed.data.window.endTs) return { ok: false, reason: 'window already closed' };
    return { ok: true };
  }

  async run(ctx: HarnessContext): Promise<Solution> {
    if (this.config.stub) {
      throw new Error('claude-mcp-prediction-apy: stub registry cannot run (requires live daemon)');
    }
    const { task: task, workingDir, log } = ctx;
    const parsed = PredictionApyV0TaskSchema.parse(task);
    const testDeps = this.config._testDeps;

    const submissionState: SubmissionState = {
      predictedBps: null,
      rationale: null,
      submittedAt: null,
    };

    const signalSubmit = (predictedBps: string, rationale: string): void => {
      submissionState.predictedBps = predictedBps;
      submissionState.rationale = rationale;
      submissionState.submittedAt = Date.now();
    };

    const sessionId = `apy-pred-${Date.now()}`;
    const prompt = buildSessionPrompt(parsed, sessionId);
    const claudeModel = ctx.solverNet?.model ?? this.config.claudeModel;

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

    const { venue, pool, reserve, reserveSymbol } = parsed.spec.oracle;
    const { chain, chainId } = chainForVenue(venue);
    const rpcUrl = this.config.archiveRpcUrl ?? this.config.rpcUrl ?? this._defaultRpcUrl(venue);
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) }) as unknown as PublicClient;
    const actual = await publicClient.getChainId();
    if (actual !== chainId) {
      throw new Error(`oracle venue mismatch: ${venue} expects chain ${chainId}, got ${actual}`);
    }

    const mcpDir = join(workingDir, 'mcp');
    mkdirSync(mcpDir, { recursive: true });

    const submissionLogPath = join(mcpDir, 'submissions.jsonl');
    writeFileSync(submissionLogPath, '', { encoding: 'utf-8', mode: 0o600 });
    chmodSync(submissionLogPath, 0o600);

    const wrapperPath = join(mcpDir, 'apy-prediction-server.mjs');
    const wrapperConfigPath = join(mcpDir, 'apy-prediction-server-config.json');
    const wrapperConfig = {
      venue,
      pool,
      reserve,
      reserveSymbol,
      rpcUrl,
      submissionLogPath,
    };
    writeFileSync(wrapperConfigPath, JSON.stringify(wrapperConfig), { encoding: 'utf-8', mode: 0o600 });
    chmodSync(wrapperConfigPath, 0o600);
    _writeApyPredictionMcpServerScript(wrapperPath);

    const mcpConfigPath = join(mcpDir, 'mcp-config.json');
    writeFileSync(
      mcpConfigPath,
      JSON.stringify({
        mcpServers: {
          'jinn-apy-prediction': {
            command: process.execPath,
            args: [wrapperPath, wrapperConfigPath],
          },
        },
      }, null, 2),
    );

    const isSubmitted = (): boolean => {
      try {
        const contents = readFileSync(submissionLogPath, 'utf-8');
        const lastLine = contents.trim().split('\n').pop() ?? '';
        if (!lastLine) return false;
        const record = JSON.parse(lastLine);
        if (record && typeof record.predictedBps === 'string' && typeof record.rationale === 'string') {
          signalSubmit(record.predictedBps, record.rationale);
          return true;
        }
      } catch {
        return false;
      }
      return false;
    };

    log({ level: 'info', msg: 'claude-mcp-prediction-apy: spawning session', data: { sessionId } });

    const session = await spawnSession(sessionId, prompt, {
      claudePath: this.config.claudePath ?? 'claude',
      ...(claudeModel ? { claudeModel } : {}),
      mcpConfigPath,
      workingDir,
      abort: ctx.abort,
      log,
      isSubmitted,
      ...(this.config.sessionMaxMs !== undefined ? { sessionMaxMs: this.config.sessionMaxMs } : {}),
    });

    if (!submissionState.predictedBps) isSubmitted();

    return this._finalize(parsed, sessionId, session.transcriptPath, submissionState, session.startedAt, session.endedAt, claudeModel);
  }

  private _finalize(
    task: import('../../../types/prediction-apy.js').PredictionApyV0Task,
    sessionId: string,
    transcriptPath: string,
    submission: SubmissionState,
    startedAt: number,
    endedAt: number,
    claudeModel?: string,
  ): Solution {
    if (!submission.predictedBps || !submission.rationale) {
      throw new Error(
        `claude-mcp-prediction-apy: session ${sessionId} ended without a valid submit_apy_prediction call`,
      );
    }

    const submittedAt = submission.submittedAt ?? Date.now();
    const modelId = `claude-mcp-prediction-apy.${claudeModel ?? 'default'}.v1`;

    const predictionPath = join(dirname(transcriptPath), '..', '..', 'prediction-apy.json');
    writeFileSync(
      predictionPath,
      JSON.stringify({
        predictedBps: submission.predictedBps,
        submittedAt,
        modelId,
        rationale: submission.rationale,
      }, null, 2),
      { encoding: 'utf-8' },
    );

    const { venue, pool, reserve, reserveSymbol } = task.spec.oracle;

    return {
      venueRef: { name: 'aave-v3' },
      gating: {
        predictedBps: submission.predictedBps,
        submittedAt: String(submittedAt),
        modelId,
      },
      informational: {
        rationale: submission.rationale,
        sessionId,
        transcriptPath,
        venue,
        pool,
        reserve,
        reserveSymbol,
        sessionDurationMs: endedAt - startedAt,
      },
      solutionPayload: {
        prediction: {
          predictedBps: submission.predictedBps,
          submittedAt,
          modelId,
        },
      },
      artifacts: [
        { path: 'prediction-apy.json', artifactType: 'prediction_submission' },
        {
          path: transcriptPath,
          artifactType: 'session_transcript',
          metadata: { sessionId, startedAt, endedAt },
        },
      ],
    };
  }

  private _defaultRpcUrl(venue: AaveV3Venue): string {
    if (venue === 'aave-v3-base-sepolia') return 'https://sepolia.base.org';
    if (venue === 'aave-v3-base') return 'https://mainnet.base.org';
    return 'https://eth.llamarpc.com';
  }
}

export function _writeApyPredictionMcpServerScript(outPath: string): void {
  writeMcpServerScript(outPath, { callerFileUrl: import.meta.url, serverLabel: 'jinn-apy-prediction' });
}

export default ClaudeMcpPredictionApyImpl;
