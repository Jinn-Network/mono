/**
 * claude-mcp-prediction-apy — RestorerImpl for prediction.apy.v0 that spawns a
 * single Claude Code session with read_aave_reserve + submit_apy_prediction.
 *
 * Opt-in via config.restorers.byKind['prediction.apy.v0']; baseline remains default.
 * Isolation gate: test/restorer/impls/claude-mcp-prediction-apy/isolation.test.ts
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http } from 'viem';
import { base, baseSepolia, mainnet } from 'viem/chains';
import type { PublicClient } from 'viem';

import type {
  RestorerImpl,
  RestorationContext,
  RestorationOutput,
  ReadyStatus,
  EnableResult,
  IntentEnableMetadata,
} from '../../types.js';
import { REQUIRES_LIVE_DAEMON_READINESS } from '../../types.js';
import type { DesiredState } from '../../../types/desired-state.js';
import { PredictionApyV0IntentSchema } from '../../../types/prediction-apy.js';

import { buildSessionPrompt } from './prompt.js';
import { spawnSession } from './session-orchestrator.js';
import type { ClaudeMcpPredictionApyConfig, SubmissionState, AaveV3Venue } from './types.js';

function chainForVenue(venue: AaveV3Venue) {
  if (venue === 'aave-v3-base-sepolia') return { chain: baseSepolia, chainId: 84532 };
  if (venue === 'aave-v3-mainnet') return { chain: mainnet, chainId: 1 };
  return { chain: base, chainId: 8453 };
}

export class ClaudeMcpPredictionApyImpl implements RestorerImpl {
  readonly name = 'claude-mcp-prediction-apy';
  readonly version = '1.0.0';

  constructor(private readonly config: ClaudeMcpPredictionApyConfig = {}) {}

  supports(ctx: { kind: string; type?: 'restoration' | 'evaluation' }): boolean {
    return ctx.kind === 'prediction.apy.v0' && ctx.type !== 'evaluation';
  }

  async isReady(): Promise<ReadyStatus> {
    if (this.config.stub) return { ...REQUIRES_LIVE_DAEMON_READINESS };
    return { ready: true };
  }

  enableMetadata(): IntentEnableMetadata {
    return {
      description: 'prediction.apy.v0 — Claude + MCP reads Aave reserve APY and submits predicted bps.',
    };
  }

  async onEnable(_args: Record<string, string | undefined>): Promise<EnableResult> {
    return { status: 'ready' };
  }

  async canAttempt(intent: DesiredState): Promise<{ ok: true } | { ok: false; reason: string }> {
    const parsed = PredictionApyV0IntentSchema.safeParse(intent);
    if (!parsed.success) return { ok: false, reason: `Invalid prediction.apy.v0 intent: ${parsed.error.message}` };
    if (Date.now() > parsed.data.window.endTs) return { ok: false, reason: 'window already closed' };
    return { ok: true };
  }

  async run(ctx: RestorationContext): Promise<RestorationOutput> {
    if (this.config.stub) {
      throw new Error('claude-mcp-prediction-apy: stub registry cannot run (requires live daemon)');
    }
    const { intent, workingDir, log } = ctx;
    const parsed = PredictionApyV0IntentSchema.parse(intent);
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
      return this._finalize(parsed, sessionId, session.transcriptPath, submissionState, session.startedAt, session.endedAt);
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
      ...(this.config.claudeModel ? { claudeModel: this.config.claudeModel } : {}),
      mcpConfigPath,
      workingDir,
      abort: ctx.abort,
      log,
      isSubmitted,
      ...(this.config.sessionMaxMs !== undefined ? { sessionMaxMs: this.config.sessionMaxMs } : {}),
    });

    if (!submissionState.predictedBps) isSubmitted();

    return this._finalize(parsed, sessionId, session.transcriptPath, submissionState, session.startedAt, session.endedAt);
  }

  private _finalize(
    intent: import('../../../types/prediction-apy.js').PredictionApyV0Intent,
    sessionId: string,
    transcriptPath: string,
    submission: SubmissionState,
    startedAt: number,
    endedAt: number,
  ): RestorationOutput {
    if (!submission.predictedBps || !submission.rationale) {
      throw new Error(
        `claude-mcp-prediction-apy: session ${sessionId} ended without a valid submit_apy_prediction call`,
      );
    }

    const submittedAt = submission.submittedAt ?? Date.now();
    const modelId = `claude-mcp-prediction-apy.${this.config.claudeModel ?? 'default'}.v1`;

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

    const { venue, pool, reserve, reserveSymbol } = intent.spec.oracle;

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
      artifacts: [
        { path: 'prediction-apy.json', role: 'prediction_submission' },
        {
          path: transcriptPath,
          role: 'session_transcript',
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
  const __filename = fileURLToPath(import.meta.url);

  let mcpToolsPath = join(dirname(__filename), 'mcp-tools.js');
  if (!existsSync(mcpToolsPath) && __filename.includes(`${'/'}src${'/'}`)) {
    mcpToolsPath = __filename
      .replace(`${'/'}src${'/'}`, `${'/'}dist${'/'}`)
      .replace(/index\.(ts|js)$/, 'mcp-tools.js');
  }

  if (!existsSync(mcpToolsPath)) {
    throw new Error(
      `E_DAEMON_MUST_RUN_FROM_DIST: ${mcpToolsPath} does not exist. ` +
        `The claude-mcp-prediction-apy wrapper subprocess loads this compiled artifact. ` +
        `Run \`yarn build\` before starting the daemon or isolation test.`,
    );
  }

  const script = `#!/usr/bin/env node
// Auto-generated jinn-apy-prediction MCP wrapper — do not edit.
import { readFileSync } from 'node:fs';
import { startMcpServer } from ${JSON.stringify(mcpToolsPath)};

const configPath = process.argv[2];
if (!configPath) {
  process.stderr.write('Usage: apy-prediction-server.mjs <config-file-path>\\n');
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, 'utf-8'));
await startMcpServer(config);
`.trim();

  writeFileSync(outPath, script, { encoding: 'utf-8', mode: 0o600 });
  chmodSync(outPath, 0o600);
}

export default ClaudeMcpPredictionApyImpl;
