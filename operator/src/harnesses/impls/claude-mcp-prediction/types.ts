/**
 * Types for claude-mcp-prediction — a Harness that spawns Claude with
 * two MCP tools to decide a prediction.v1 probability.
 */

import type { PublicClient } from 'viem';

// ── MCP tool types (mirror claude-mcp-hyperliquid/mcp-tools.ts shape) ─────────

export interface McpToolContent {
  type: 'text';
  text: string;
}

export interface McpToolResult {
  content: McpToolContent[];
}

/** Discriminated union for the tool registry. Kept open to add future tools. */
export interface PredictionToolDefinition {
  name: string;
  description: string;
  /** Zod object schema — registered as the MCP input-schema shape. */
  schema: import('zod').ZodObject<import('zod').ZodRawShape>;
  handler: (args: unknown) => Promise<McpToolResult>;
}

// ── Shared state mutated by submit_prediction ─────────────────────────────────

export interface SubmissionState {
  probability: string | null;
  rationale: string | null;
  submittedAt: number | null;
}

// ── Factory deps ──────────────────────────────────────────────────────────────

export interface PredictionToolDeps {
  /** Chainlink AggregatorV3 proxy address the task is anchored to. */
  feed: `0x${string}`;
  /** Human-readable feed description, echoed in tool responses. */
  feedDescription: string;
  /** Venue label — used to sanity-check in the tool response. */
  venue: 'chainlink-base' | 'chainlink-base-sepolia';
  /** viem public client for reading the feed. */
  publicClient: PublicClient;
  /**
   * Called when Claude invokes `submit_prediction`. The impl mutates its own
   * SubmissionState via this callback and signals the orchestrator to terminate.
   */
  onSubmit: (submission: {
    probability: string;
    rationale: string;
  }) => void;
}

// ── Impl config ───────────────────────────────────────────────────────────────

export interface ClaudeMcpPredictionConfig {
  rpcUrl?: string;
  claudeModel?: string;
  claudePath?: string;
  /** Max wall time for the Claude session (ms). Default 3 min. */
  sessionMaxMs?: number;
  /** Injected deps for test mode — bypasses the real Claude spawn. */
  _testDeps?: TestDeps;
  /** CLI Harness registry without a live daemon */
  stub?: boolean;
}

export interface TestDeps {
  /**
   * Replacement for the real session spawn. Given the MCP config path + prompt,
   * must eventually call the `onSubmit` callback registered on the tools
   * (via in-process MCP, or by writing to the submission state directly).
   *
   * Minimum-viable mock: immediately invoke the submit callback passed in ctx,
   * then return a stub SessionResult.
   */
  runSession?: (args: {
    sessionId: string;
    prompt: string;
    mcpConfigPath: string;
    workingDir: string;
    implStateDir: string;
    timeoutMs: number;
    signalSubmit: (probability: string, rationale: string) => void;
  }) => Promise<SessionResult>;
}

// ── Session result ────────────────────────────────────────────────────────────

export interface SessionResult {
  sessionId: string;
  startedAt: number;
  endedAt: number;
  transcriptPath: string;
  /** True iff `submit_prediction` was called before timeout/abort. */
  submitted: boolean;
  /** Accumulated stdout for post-mortem. */
  stdout: string;
  aborted: boolean;
}
