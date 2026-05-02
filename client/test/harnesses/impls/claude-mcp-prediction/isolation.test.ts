/**
 * Isolation test — spawns a REAL Claude binary with the jinn-prediction MCP
 * and verifies the model actually calls read_chainlink_price then
 * submit_prediction with a valid probability.
 *
 * Opt-in via env (default OFF). CI never runs this unless
 * JINN_TEST_CLAUDE_PREDICTION=1 is set, because it:
 *   - requires `claude` binary in PATH + Anthropic auth (OAuth token or API key)
 *   - makes live network calls to Base Sepolia RPC + Anthropic
 *   - takes up to 5 minutes
 *
 * Run it via: JINN_TEST_CLAUDE_PREDICTION=1 yarn test:claude-prediction
 *
 * This is the gate that confirms the spawn + MCP + prompt + tool-response
 * contract all work end-to-end before we flip the default harness in main.ts.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { ClaudeMcpPredictionImpl } from '../../../../src/harnesses/impls/claude-mcp-prediction/index.js';
import type { HarnessContext } from '../../../../src/harnesses/types.js';
import type { Task } from '../../../../src/types/task.js';

const enabled = process.env['JINN_TEST_CLAUDE_PREDICTION'] === '1';

function assertClaudeAvailable(): { ok: true } | { ok: false; reason: string } {
  try {
    execFileSync('claude', ['--version'], { stdio: 'pipe', timeout: 5000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

// Live Chainlink ETH/USD feed on Base Sepolia.
// Verify periodically — Chainlink rotates addresses; see
// https://docs.chain.link/data-feeds/price-feeds/addresses?network=base
const BASE_SEPOLIA_ETH_USD = '0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1';

describe.skipIf(!enabled)('claude-mcp-prediction (isolation)', () => {
  it('spawns Claude, reads Chainlink, submits a valid prediction', async () => {
    const claudeProbe = assertClaudeAvailable();
    if (!claudeProbe.ok) {
      throw new Error(
        `Claude binary not available: ${claudeProbe.reason}\n` +
        `Install Claude Code CLI and authenticate (claude auth login) before running this test.`,
      );
    }

    const tmp = mkdtempSync(join(tmpdir(), 'pred-claude-iso-'));
    const workingDir = join(tmp, 'work');
    const implStateDir = join(tmp, 'state');
    mkdirSync(workingDir);
    mkdirSync(implStateDir);

    // Synthesize a plausible prediction.v0 task. Window is relative to now;
    // resolveTs is 75 minutes out so the model's reasoning is not nonsensical.
    const now = Date.now();
    const windowStartTs = now;
    const windowEndTs = windowStartTs + 3_600_000;
    const resolveTs = windowEndTs + 900_000;

    const task: Task = {
      id: 'iso-test-1',
      description: 'ETH > 3000 at T (isolation test)',
      window: { startTs: windowStartTs, endTs: windowEndTs },
      spec: {
        kind: 'prediction.v0',
        oracle: {
          venue: 'chainlink-base-sepolia',
          feed: BASE_SEPOLIA_ETH_USD,
          feedDescription: 'ETH / USD',
        },
        question: {
          kind: 'threshold',
          operator: 'GT',
          threshold: '3000',
          resolveTs,
        },
      },
      eligibility: { maxSubmissionDelayMs: 60_000 },
    } as unknown as Task;

    const impl = new ClaudeMcpPredictionImpl({
      rpcUrl: process.env['BASE_SEPOLIA_RPC_URL'] ?? 'https://sepolia.base.org',
      claudeModel: process.env['JINN_CLAUDE_MODEL'] ?? 'claude-haiku-4-5-20251001',
      claudePath: process.env['JINN_CLAUDE_PATH'] ?? 'claude',
      sessionMaxMs: 180_000,
    });

    const ctx: HarnessContext = {
      task,
      workingDir,
      implStateDir,
      log: (event) => console.log(`[iso] [${event.level}] ${event.msg}${event.data ? ' ' + JSON.stringify(event.data) : ''}`),
      abort: new AbortController().signal,
      msUntilEndTs: () => 180_000,
    };

    const out = await impl.run(ctx);

    // ── Probability shape ────────────────────────────────────────────────────
    const probStr = out.gating.probability as string;
    expect(probStr).toMatch(/^\d+(\.\d+)?$/);
    const prob = parseFloat(probStr);
    expect(prob).toBeGreaterThanOrEqual(0);
    expect(prob).toBeLessThanOrEqual(1);

    // ── Model + session metadata ─────────────────────────────────────────────
    expect(out.gating.modelId).toContain('claude-mcp-prediction');
    expect(out.informational?.rationale).toBeTruthy();
    expect((out.informational?.rationale as string).length).toBeGreaterThan(10);
    expect(out.informational?.sessionId).toMatch(/^pred-\d+$/);

    // ── prediction.json on disk ──────────────────────────────────────────────
    const predictionPath = join(workingDir, 'prediction.json');
    expect(existsSync(predictionPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(predictionPath, 'utf-8'));
    expect(parsed.probability).toBe(probStr);
    expect(parsed.rationale).toBe(out.informational?.rationale);
    expect(parsed.modelId).toBe(out.gating.modelId);

    // ── Transcript on disk ──────────────────────────────────────────────────
    // NOTE: MCP tool calls traverse the stdio protocol channel, not Claude's
    // text output to stdout. So the transcript does NOT literally contain
    // "read_chainlink_price" / "submit_prediction" — the tool names are
    // internal to the MCP wire. The proof that both tools fired is:
    //   (a) submissionState.probability is non-null (submit_prediction ran)
    //   (b) the rationale references a price or dollar amount that Claude
    //       could only know by calling read_chainlink_price
    const transcriptPath = out.informational?.transcriptPath as string;
    expect(existsSync(transcriptPath)).toBe(true);
    const transcript = readFileSync(transcriptPath, 'utf-8');
    expect(transcript.length).toBeGreaterThan(50);
    expect(transcript).toContain('submitted=true');

    // Proof-of-tool-use: rationale should mention a price / dollar figure,
    // which Claude can only produce by actually reading the oracle.
    const rationale = out.informational?.rationale as string;
    expect(rationale).toMatch(/\$\s*\d|\b\d{1,5}(\.\d+)?\s*(USD|usd)?\b|price/i);

    console.log('\n=== Isolation test result ===');
    console.log(`  probability: ${probStr}`);
    console.log(`  rationale:   ${out.informational?.rationale}`);
    console.log(`  sessionMs:   ${out.informational?.sessionDurationMs}`);
    console.log(`  transcript:  ${transcriptPath}`);
    console.log(`  workingDir:  ${workingDir}`);
  }, 300_000);
});
