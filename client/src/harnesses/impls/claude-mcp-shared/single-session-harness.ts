/**
 * Shared LIVE-path scaffold for the claude-mcp-prediction* impls.
 *
 * Both `claude-mcp-prediction` and `claude-mcp-prediction-apy` run the same
 * venue-agnostic middle in their `run()` live path:
 *
 *   1. mkdir `mcp/`.
 *   2. Write an empty `submissions.jsonl` @ 0o600.
 *   3. Write the wrapper `.mjs` + its JSON config @ 0o600.
 *   4. Write `mcp-config.json` pointing Claude at the wrapper.
 *   5. Tail the JSONL log to detect the submit-tool call (`isSubmitted`).
 *   6. Spawn the single Claude session and return its result.
 *
 * The only per-venue pieces are threaded in as params: the wrapper basename,
 * the mcp-server key, the SingleSessionConfig, the wrapper config builder, the
 * script writer, and a `parseRecord` that turns a JSONL line into the venue's
 * submission shape. The test-mode short-circuit + `_finalize` stay per-venue.
 */

import { writeFileSync, mkdirSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

import {
  runSingleSession,
  type SingleSessionConfig,
  type SingleSessionResult,
} from './single-session-orchestrator.js';
import type { TrajectoryCollector } from '../../../trajectory/index.js';

export interface RunSingleSessionHarnessParams<TSubmission> {
  sessionId: string;
  prompt: string;
  workingDir: string;
  /** Basename (no extension) for the wrapper `.mjs` + its `-config.json`. */
  wrapperBasename: string;
  /** Key under `mcpServers` in the generated `mcp-config.json`. */
  mcpServerKey: string;
  /** Orchestrator config (allowedTools / logTag / submissionToolName). */
  sessionConfig: SingleSessionConfig;
  /** Build the venue wrapper config; receives the resolved submission log path. */
  buildWrapperConfig: (submissionLogPath: string) => Record<string, unknown>;
  /** Write the venue wrapper script to the given path. */
  writeScript: (outPath: string) => void;
  /** Parse a JSONL record into the venue submission shape, or null if invalid. */
  parseRecord: (record: unknown) => TSubmission | null;
  /** Called with the parsed submission when a valid record is first seen. */
  onParsed: (submission: TSubmission) => void;
}

export interface RunSingleSessionHarnessDeps {
  claudePath: string;
  claudeModel?: string;
  abort: AbortSignal;
  log: (event: { level: 'info' | 'warn' | 'error'; msg: string; data?: unknown }) => void;
  sessionMaxMs?: number;
  trajectory?: TrajectoryCollector;
}

/**
 * Run the venue-agnostic live-path middle and return the raw session result
 * (transcriptPath / startedAt / endedAt) for the venue's `_finalize` to consume.
 */
export async function runSingleSessionHarness<TSubmission>(
  params: RunSingleSessionHarnessParams<TSubmission>,
  deps: RunSingleSessionHarnessDeps,
): Promise<SingleSessionResult> {
  const mcpDir = join(params.workingDir, 'mcp');
  mkdirSync(mcpDir, { recursive: true });

  // Per-session submission log. The wrapper appends JSON lines here when the
  // submit tool is invoked. We tail it to detect the submission.
  const submissionLogPath = join(mcpDir, 'submissions.jsonl');
  writeFileSync(submissionLogPath, '', { encoding: 'utf-8', mode: 0o600 });
  chmodSync(submissionLogPath, 0o600);

  // Write the wrapper script + its config.
  const wrapperPath = join(mcpDir, `${params.wrapperBasename}.mjs`);
  const wrapperConfigPath = join(mcpDir, `${params.wrapperBasename}-config.json`);
  writeFileSync(wrapperConfigPath, JSON.stringify(params.buildWrapperConfig(submissionLogPath)), {
    encoding: 'utf-8',
    mode: 0o600,
  });
  chmodSync(wrapperConfigPath, 0o600);
  params.writeScript(wrapperPath);

  // MCP config file Claude reads via --mcp-config.
  const mcpConfigPath = join(mcpDir, 'mcp-config.json');
  writeFileSync(
    mcpConfigPath,
    JSON.stringify(
      {
        mcpServers: {
          [params.mcpServerKey]: {
            command: process.execPath,
            args: [wrapperPath, wrapperConfigPath],
          },
        },
      },
      null,
      2,
    ),
  );

  // isSubmitted reads the JSONL log; as soon as there's a valid line, we know
  // the tool fired and we surface the parsed submission via onParsed.
  const isSubmitted = (): boolean => {
    try {
      const contents = readFileSync(submissionLogPath, 'utf-8');
      const lastLine = contents.trim().split('\n').pop() ?? '';
      if (!lastLine) return false;
      const parsed = params.parseRecord(JSON.parse(lastLine));
      if (parsed !== null) {
        params.onParsed(parsed);
        return true;
      }
    } catch {
      return false;
    }
    return false;
  };

  return runSingleSession(params.sessionId, params.prompt, params.sessionConfig, {
    claudePath: deps.claudePath,
    ...(deps.claudeModel ? { claudeModel: deps.claudeModel } : {}),
    mcpConfigPath,
    workingDir: params.workingDir,
    abort: deps.abort,
    log: deps.log,
    isSubmitted,
    ...(deps.sessionMaxMs !== undefined ? { sessionMaxMs: deps.sessionMaxMs } : {}),
    ...(deps.trajectory ? { trajectory: deps.trajectory } : {}),
  });
}
