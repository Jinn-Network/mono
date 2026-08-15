/**
 * MCP tool definitions for claude-mcp-prediction.
 *
 * Two tools, minimal by design:
 *   - read_chainlink_price: read-only oracle query. No auth, no side effects.
 *   - submit_prediction:    terminal tool. Records Claude's decision + ends session.
 *
 * No safety rails, no write-op tracking, no signing. Prediction has no capital
 * surface; the only "write" is `submit_prediction` which writes to the impl's
 * in-memory SubmissionState via onSubmit.
 *
 * Also exports startMcpServer(config): the wrapper-script entrypoint. Mirrors
 * the pattern in claude-mcp-hyperliquid/mcp-tools.ts:1030-1079, minus the HL
 * client + safety setup.
 */

import { z } from 'zod';
import { createPublicClient, http, type PublicClient } from 'viem';
import { base, baseSepolia } from 'viem/chains';

import { createStdioMcpServer, appendSubmissionRecord } from '../claude-mcp-shared/mcp-server.js';
import { readChainlinkLatest, scaleToDecimal } from '../../../venues/chainlink/client.js';
import type {
  McpToolResult,
  PredictionToolDefinition,
  PredictionToolDeps,
} from './types.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function ok(data: unknown): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

function toolErr(code: string, message: string): McpToolResult {
  return {
    content: [
      { type: 'text', text: JSON.stringify({ error: true, code, message }) },
    ],
  };
}

// ── Tool schemas ──────────────────────────────────────────────────────────────

const ReadChainlinkPriceSchema = z.object({});

const SubmitPredictionSchema = z.object({
  probability: z
    .number()
    .min(0, 'probability must be ≥ 0')
    .max(1, 'probability must be ≤ 1'),
  rationale: z
    .string()
    .min(1, 'rationale must not be empty')
    .max(2000, 'rationale must be ≤ 2000 characters'),
});

// ── Factory ───────────────────────────────────────────────────────────────────

export function buildPredictionTools(deps: PredictionToolDeps): PredictionToolDefinition[] {
  const { feed, feedDescription, venue, publicClient, onSubmit } = deps;

  const readChainlinkPrice: PredictionToolDefinition = {
    name: 'read_chainlink_price',
    description:
      'Read the current Chainlink price for the feed anchored in this prediction task. Returns the price as a decimal string plus round metadata.',
    schema: ReadChainlinkPriceSchema,
    handler: async () => {
      try {
        const reading = await readChainlinkLatest(feed, publicClient);
        const price = scaleToDecimal(reading.answer, reading.decimals);
        return ok({
          price,
          roundId: String(reading.roundId),
          updatedAt: reading.updatedAt,
          feed,
          feedDescription,
          venue,
        });
      } catch (err) {
        return toolErr('CHAINLINK_READ_FAILED', err instanceof Error ? err.message : String(err));
      }
    },
  };

  const submitPrediction: PredictionToolDefinition = {
    name: 'submit_prediction',
    description:
      'Submit your final prediction. `probability` is your probability (as a decimal number between 0 and 1) that the question resolves YES. `rationale` is a brief one-paragraph explanation of your reasoning. Calling this ends the session; do not call any other tool after it.',
    schema: SubmitPredictionSchema,
    handler: async (rawArgs: unknown) => {
      const parsed = SubmitPredictionSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return toolErr('INVALID_ARGS', parsed.error.issues.map(i => i.message).join('; '));
      }
      const { probability, rationale } = parsed.data;
      // Fixed-point string to avoid float drift between tool + manifest.
      const probabilityStr = probability.toFixed(4);
      onSubmit({ probability: probabilityStr, rationale });
      return ok({
        accepted: true,
        probability: probabilityStr,
        note: 'Prediction recorded. The session will terminate shortly after this response reaches Claude.',
      });
    },
  };

  return [readChainlinkPrice, submitPrediction];
}

// ── startMcpServer — wrapper-script entrypoint ────────────────────────────────

/**
 * Config passed into startMcpServer() — serialised as JSON by the impl, written
 * to disk with mode 0o600 alongside the generated wrapper script, and read back
 * by the wrapper when Claude's subprocess launches it via --mcp-config.
 *
 * This lives on-disk (not in memory) because the Claude subprocess spawns the
 * wrapper as a fresh Node process — closures from the daemon don't survive.
 *
 * The wrapper's live submit_prediction handler CANNOT call back into the
 * daemon's onSubmit closure across the process boundary. Instead the wrapper
 * records the submission to `submissionLogPath` (a JSONL file the daemon tails).
 */
export interface McpServerConfig {
  feed: `0x${string}`;
  feedDescription: string;
  venue: 'chainlink-base' | 'chainlink-base-sepolia';
  rpcUrl: string;
  /** The daemon tails this file to detect submissions. Created by the daemon. */
  submissionLogPath: string;
}

export async function startMcpServer(config: McpServerConfig): Promise<void> {
  // Build a publicClient from the chain implied by venue.
  const chain = config.venue === 'chainlink-base' ? base : baseSepolia;
  const publicClient = createPublicClient({
    chain,
    transport: http(config.rpcUrl),
  }) as unknown as PublicClient;

  // The wrapper's onSubmit appends a JSONL record to submissionLogPath.
  // The daemon's orchestrator tails the file and reads the submission from
  // disk. This is the only IPC mechanism that survives the process boundary.
  const onSubmit: PredictionToolDeps['onSubmit'] = (submission) => {
    appendSubmissionRecord(config.submissionLogPath, {
      probability: submission.probability,
      rationale: submission.rationale,
    });
  };

  const tools = buildPredictionTools({
    feed: config.feed,
    feedDescription: config.feedDescription,
    venue: config.venue,
    publicClient,
    onSubmit,
  });

  await createStdioMcpServer({ serverName: 'jinn-prediction', version: '1.0.0', tools });
}
