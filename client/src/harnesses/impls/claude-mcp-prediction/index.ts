/**
 * claude-mcp-prediction — Harness for prediction.v0 that spawns a single
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

import { writeFileSync, mkdirSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Harness, HarnessContext, Solution, ReadyStatus } from '../../types.js';
import { REQUIRES_LIVE_DAEMON_READINESS } from '../../types.js';
import type { Task } from '../../../types/task.js';
import { PredictionV0TaskSchema } from '../../../types/prediction.js';

import { buildSessionPrompt } from './prompt.js';
import { spawnSession } from './session-orchestrator.js';
import type { ClaudeMcpPredictionConfig, SubmissionState } from './types.js';

// ── Impl ──────────────────────────────────────────────────────────────────────

export class ClaudeMcpPredictionImpl implements Harness {
  readonly name = 'claude-mcp-prediction';
  readonly version = '1.0.0';

  constructor(private readonly config: ClaudeMcpPredictionConfig = {}) {}

  supports(ctx: { solverType: string; role?: 'restoration' | 'evaluation' }): boolean {
    return ctx.solverType === 'prediction.v0' && ctx.role !== 'evaluation';
  }

  async isReady(): Promise<ReadyStatus> {
    if (this.config.stub) return { ...REQUIRES_LIVE_DAEMON_READINESS };
    return { ready: true };
  }

  async canAttempt(
    task: Task,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const parsed = PredictionV0TaskSchema.safeParse(task);
    if (!parsed.success) return { ok: false, reason: `Invalid prediction.v0 task: ${parsed.error.message}` };
    if (Date.now() > parsed.data.window.endTs) return { ok: false, reason: 'window already closed' };
    return { ok: true };
  }

  async run(ctx: HarnessContext): Promise<Solution> {
    if (this.config.stub) {
      throw new Error('claude-mcp-prediction: stub registry cannot run (requires live daemon)');
    }
    const { task: task, workingDir, log } = ctx;
    const parsed = PredictionV0TaskSchema.parse(task);
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
      return this._finalize(parsed, sessionId, session.transcriptPath, submissionState, session.startedAt, session.endedAt);
    }

    // ── Live path ──────────────────────────────────────────────────────────────
    const mcpDir = join(workingDir, 'mcp');
    mkdirSync(mcpDir, { recursive: true });

    // Per-session submission log. The wrapper appends JSON lines here when
    // submit_prediction is invoked. We tail it to detect the submission.
    const submissionLogPath = join(mcpDir, 'submissions.jsonl');
    writeFileSync(submissionLogPath, '', { encoding: 'utf-8', mode: 0o600 });
    chmodSync(submissionLogPath, 0o600);

    // Write the wrapper script + its config.
    const wrapperPath = join(mcpDir, 'prediction-server.mjs');
    const wrapperConfigPath = join(mcpDir, 'prediction-server-config.json');
    const wrapperConfig = {
      feed: parsed.spec.oracle.feed,
      feedDescription: parsed.spec.oracle.feedDescription,
      venue: parsed.spec.oracle.venue,
      rpcUrl: this.config.rpcUrl ?? this._defaultRpcUrl(parsed.spec.oracle.venue),
      submissionLogPath,
    };
    writeFileSync(wrapperConfigPath, JSON.stringify(wrapperConfig), { encoding: 'utf-8', mode: 0o600 });
    chmodSync(wrapperConfigPath, 0o600);
    _writePredictionMcpServerScript(wrapperPath);

    // MCP config file Claude reads via --mcp-config.
    const mcpConfigPath = join(mcpDir, 'mcp-config.json');
    writeFileSync(mcpConfigPath, JSON.stringify({
      mcpServers: {
        'jinn-prediction': {
          command: process.execPath,
          args: [wrapperPath, wrapperConfigPath],
        },
      },
    }, null, 2));

    // isSubmitted reads the JSONL log; as soon as there's a line, we know
    // the tool fired. We also pull the probability + rationale from it so
    // the cross-process boundary is clean.
    const isSubmitted = (): boolean => {
      try {
        const contents = readFileSync(submissionLogPath, 'utf-8');
        const lastLine = contents.trim().split('\n').pop() ?? '';
        if (!lastLine) return false;
        const record = JSON.parse(lastLine);
        if (record && typeof record.probability === 'string' && typeof record.rationale === 'string') {
          signalSubmit(record.probability, record.rationale);
          return true;
        }
      } catch {
        return false;
      }
      return false;
    };

    log({ level: 'info', msg: 'claude-mcp-prediction: spawning session', data: { sessionId } });

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

    // One final read in case isSubmitted's poll raced with session exit.
    if (!submissionState.probability) isSubmitted();

    return this._finalize(parsed, sessionId, session.transcriptPath, submissionState, session.startedAt, session.endedAt);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private _finalize(
    task: import('../../../types/prediction.js').PredictionV0Task,
    sessionId: string,
    transcriptPath: string,
    submission: SubmissionState,
    startedAt: number,
    endedAt: number,
  ): Solution {
    if (!submission.probability || !submission.rationale) {
      throw new Error(
        `claude-mcp-prediction: session ${sessionId} ended without a valid submit_prediction call`,
      );
    }

    const submittedAt = submission.submittedAt ?? Date.now();
    const modelId = `claude-mcp-prediction.${this.config.claudeModel ?? 'default'}.v1`;

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
 * Follows the same "delegate to compiled mcp-tools.js" pattern as
 * _writeHlMcpServerScript — plain Node loads the wrapper, which imports
 * startMcpServer from the compiled file.
 */
export function _writePredictionMcpServerScript(outPath: string): void {
  const __filename = fileURLToPath(import.meta.url);

  // Resolve the COMPILED mcp-tools.js path. The wrapper is spawned by plain
  // Node (not tsx) via --mcp-config, so it must import a .js file. After
  // `yarn build` the compiled artifact lives at dist/.../mcp-tools.js.
  //
  // - Production (running from dist/): __filename is in /.../dist/... → sibling
  //   mcp-tools.js exists.
  // - Dev/test (running source via tsx/vitest): __filename is in /.../src/...
  //   → rewrite path into /.../dist/... .
  let mcpToolsPath = join(dirname(__filename), 'mcp-tools.js');
  if (!existsSync(mcpToolsPath) && __filename.includes(`${'/'}src${'/'}`)) {
    mcpToolsPath = __filename
      .replace(`${'/'}src${'/'}`, `${'/'}dist${'/'}`)
      .replace(/index\.(ts|js)$/, 'mcp-tools.js');
  }

  if (!existsSync(mcpToolsPath)) {
    throw new Error(
      `E_DAEMON_MUST_RUN_FROM_DIST: ${mcpToolsPath} does not exist. ` +
      `The claude-mcp-prediction wrapper subprocess loads this compiled artifact. ` +
      `Run \`yarn build\` before starting the daemon or isolation test.`,
    );
  }

  const script = `#!/usr/bin/env node
// Auto-generated jinn-prediction MCP wrapper — do not edit.
// Delegates to the compiled mcp-tools module; no business logic in the wrapper.
// Config (feed address, RPC url, submissionLogPath) is read from argv[2].
import { readFileSync } from 'node:fs';
import { startMcpServer } from ${JSON.stringify(mcpToolsPath)};

const configPath = process.argv[2];
if (!configPath) {
  process.stderr.write('Usage: prediction-server.mjs <config-file-path>\\n');
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, 'utf-8'));
await startMcpServer(config);
`.trim();

  writeFileSync(outPath, script, { encoding: 'utf-8', mode: 0o600 });
  chmodSync(outPath, 0o600);
}

export default ClaudeMcpPredictionImpl;
