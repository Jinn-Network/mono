/**
 * Types for claude-mcp-prediction-apy — a Harness that spawns Claude with
 * two MCP tools to submit prediction.apy.v0 (integer APY bps).
 */

import type { PublicClient } from 'viem';

// ── MCP tool types (mirror claude-mcp-prediction/types.ts) ───────────────────

export interface McpToolContent {
  type: 'text';
  text: string;
}

export interface McpToolResult {
  content: McpToolContent[];
}

export interface ApyPredictionToolDefinition {
  name: string;
  description: string;
  schema: import('zod').ZodObject<import('zod').ZodRawShape>;
  handler: (args: unknown) => Promise<McpToolResult>;
}

// ── Shared state mutated by submit_apy_prediction ───────────────────────────

export interface SubmissionState {
  predictedBps: string | null;
  rationale: string | null;
  submittedAt: number | null;
}

// ── Factory deps ──────────────────────────────────────────────────────────────

export type AaveV3Venue = 'aave-v3-base-sepolia' | 'aave-v3-base' | 'aave-v3-mainnet';

export interface ApyPredictionToolDeps {
  pool: `0x${string}`;
  reserve: `0x${string}`;
  reserveSymbol: string;
  venue: AaveV3Venue;
  publicClient: PublicClient;
  onSubmit: (submission: { predictedBps: string; rationale: string }) => void;
}

// ── Impl config ───────────────────────────────────────────────────────────────

export interface ClaudeMcpPredictionApyConfig {
  rpcUrl?: string;
  archiveRpcUrl?: string;
  claudeModel?: string;
  claudePath?: string;
  sessionMaxMs?: number;
  _testDeps?: TestDeps;
  stub?: boolean;
}

export interface TestDeps {
  runSession?: (args: {
    sessionId: string;
    prompt: string;
    mcpConfigPath: string;
    workingDir: string;
    implStateDir: string;
    timeoutMs: number;
    signalSubmit: (predictedBps: string, rationale: string) => void;
  }) => Promise<SessionResult>;
}

export interface SessionResult {
  sessionId: string;
  startedAt: number;
  endedAt: number;
  transcriptPath: string;
  submitted: boolean;
  stdout: string;
  aborted: boolean;
}
