/**
 * Isolation test — spawns a REAL Claude binary with jinn-apy-prediction MCP.
 *
 * Opt-in via JINN_TEST_CLAUDE_PREDICTION_APY=1 (default OFF for CI).
 *
 * Run: JINN_TEST_CLAUDE_PREDICTION_APY=1 yarn test:claude-prediction-apy
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { ClaudeMcpPredictionApyImpl } from '../../../../src/harnesses/impls/claude-mcp-prediction-apy/index.js';
import type { HarnessContext } from '../../../../src/harnesses/types.js';
import type { Task } from '../../../../src/types/task.js';

const enabled = process.env['JINN_TEST_CLAUDE_PREDICTION_APY'] === '1';

function assertClaudeAvailable(): { ok: true } | { ok: false; reason: string } {
  try {
    execFileSync('claude', ['--version'], { stdio: 'pipe', timeout: 5000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

// Base Sepolia Aave v3 pool + USDC reserve (see fixtures/prediction-apy-v0-task.example.json)
const POOL = '0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951';
const RESERVE = '0x31d3A7711a10C45D72649D51E1c8D74282702572';

describe.skipIf(!enabled)('claude-mcp-prediction-apy (isolation)', () => {
  it('spawns Claude, reads Aave reserve, submits valid predicted bps', async () => {
    const claudeProbe = assertClaudeAvailable();
    if (!claudeProbe.ok) {
      throw new Error(
        `Claude binary not available: ${claudeProbe.reason}\n` +
          `Install Claude Code CLI and authenticate before running this test.`,
      );
    }

    const tmp = mkdtempSync(join(tmpdir(), 'apy-claude-iso-'));
    const workingDir = join(tmp, 'work');
    const implStateDir = join(tmp, 'state');
    mkdirSync(workingDir);
    mkdirSync(implStateDir);

    const now = Date.now();
    const windowStartTs = now;
    const windowEndTs = windowStartTs + 3_600_000;
    const resolveTs = windowEndTs + 900_000;

    const task: Task = {
      id: 'iso-apy-1',
      description: 'USDC supply APY (isolation test)',
      window: { startTs: windowStartTs, endTs: windowEndTs },
      spec: {
        kind: 'prediction.apy.v0',
        oracle: {
          venue: 'aave-v3-base-sepolia',
          pool: POOL,
          reserve: RESERVE,
          reserveSymbol: 'USDC',
        },
        metric: {
          type: 'supply-apy-twa-bps',
          twaWindowSeconds: 3600,
          sampleCount: 12,
          toleranceBps: 50,
        },
        question: { resolveTs },
      },
      eligibility: { maxSubmissionDelayMs: 60_000 },
    } as unknown as Task;

    const impl = new ClaudeMcpPredictionApyImpl({
      rpcUrl: process.env['BASE_SEPOLIA_RPC_URL'] ?? 'https://sepolia.base.org',
      claudeModel: process.env['JINN_CLAUDE_MODEL'] ?? 'claude-haiku-4-5-20251001',
      claudePath: process.env['JINN_CLAUDE_PATH'] ?? 'claude',
      sessionMaxMs: 180_000,
    });

    const ctx: HarnessContext = {
      task,
      workingDir,
      implStateDir,
      log: (event) =>
        console.log(`[iso-apy] [${event.level}] ${event.msg}${event.data ? ' ' + JSON.stringify(event.data) : ''}`),
      abort: new AbortController().signal,
      msUntilEndTs: () => 180_000,
    };

    const out = await impl.run(ctx);

    const bpsStr = out.gating.predictedBps as string;
    expect(bpsStr).toMatch(/^\d+$/);
    expect(Number(bpsStr)).toBeGreaterThanOrEqual(0);

    expect(out.gating.modelId).toContain('claude-mcp-prediction-apy');
    expect(out.informational?.rationale).toBeTruthy();
    expect((out.informational?.rationale as string).length).toBeGreaterThan(10);
    expect(out.informational?.sessionId).toMatch(/^apy-pred-\d+$/);

    const predictionPath = join(workingDir, 'prediction-apy.json');
    expect(existsSync(predictionPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(predictionPath, 'utf-8'));
    expect(parsed.predictedBps).toBe(bpsStr);
    expect(parsed.rationale).toBe(out.informational?.rationale);
    expect(parsed.modelId).toBe(out.gating.modelId);

    const transcriptPath = out.informational?.transcriptPath as string;
    expect(existsSync(transcriptPath)).toBe(true);
    const transcript = readFileSync(transcriptPath, 'utf-8');
    expect(transcript.length).toBeGreaterThan(50);
    expect(transcript).toContain('submitted=true');

    const rationale = out.informational?.rationale as string;
    expect(rationale).toMatch(/\d|\bbps\b|APY|apy|basis/i);

    console.log('\n=== APY isolation test result ===');
    console.log(`  predictedBps: ${bpsStr}`);
    console.log(`  rationale:    ${out.informational?.rationale}`);
    console.log(`  sessionMs:    ${out.informational?.sessionDurationMs}`);
    console.log(`  transcript:   ${transcriptPath}`);
    console.log(`  workingDir:   ${workingDir}`);
  }, 300_000);
});
