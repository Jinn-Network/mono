/**
 * MCP tool definitions for claude-mcp-prediction-apy.
 *
 * Two tools:
 *   - read_aave_reserve: read-only Aave v3 Pool.getReserveData; APY bps from liquidity rate.
 *   - submit_apy_prediction: terminal tool; records predicted bps + rationale.
 */

import { z } from 'zod';
import { createPublicClient, http, type PublicClient } from 'viem';
import { base, baseSepolia, mainnet } from 'viem/chains';

import { createStdioMcpServer, appendSubmissionRecord } from '../claude-mcp-shared/mcp-server.js';
import {
  AAVE_POOL_ABI,
  liquidityRateRayToApyBps,
} from '../../../venues/aave-v3/client.js';
import type {
  ApyPredictionToolDefinition,
  ApyPredictionToolDeps,
  AaveV3Venue,
  McpToolResult,
} from './types.js';

function ok(data: unknown): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

function toolErr(code: string, message: string): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: true, code, message }) }],
  };
}

const ReadAaveReserveSchema = z.object({});

const SubmitApyPredictionSchema = z.object({
  predictedBps: z
    .number()
    .int('predictedBps must be an integer')
    .min(0, 'predictedBps must be ≥ 0')
    .max(1_000_000, 'predictedBps must be ≤ 1_000_000'),
  rationale: z
    .string()
    .min(1, 'rationale must not be empty')
    .max(2000, 'rationale must be ≤ 2000 characters'),
});

export function buildApyPredictionTools(deps: ApyPredictionToolDeps): ApyPredictionToolDefinition[] {
  const { pool, reserve, reserveSymbol, venue, publicClient, onSubmit } = deps;

  const readAaveReserve: ApyPredictionToolDefinition = {
    name: 'read_aave_reserve',
    description:
      'Read the current Aave v3 reserve supply APY (basis points) for the pool/reserve in this task. Returns the converted APY from currentLiquidityRate plus block metadata.',
    schema: ReadAaveReserveSchema,
    handler: async () => {
      try {
        const reserveData = await publicClient.readContract({
          address: pool,
          abi: AAVE_POOL_ABI,
          functionName: 'getReserveData',
          args: [reserve],
        });
        const currentLiquidityRateRay = reserveData[2];
        const lastUpdateTimestamp = reserveData[6];
        const apyBps = liquidityRateRayToApyBps(currentLiquidityRateRay);
        const block = await publicClient.getBlock({ blockTag: 'latest' });
        const chainId = await publicClient.getChainId();
        return ok({
          apyBps,
          liquidityRateRay: String(currentLiquidityRateRay),
          lastUpdateTimestamp: Number(lastUpdateTimestamp),
          pool,
          reserve,
          reserveSymbol,
          venue,
          chainId,
          blockNumber: String(block.number),
        });
      } catch (err) {
        return toolErr('AAVE_READ_FAILED', err instanceof Error ? err.message : String(err));
      }
    },
  };

  const submitApyPrediction: ApyPredictionToolDefinition = {
    name: 'submit_apy_prediction',
    description:
      'Submit your final APY prediction in basis points (integer). `predictedBps` is the supply APY you predict for the TWA window ending at resolveTs. `rationale` is a brief explanation. Calling this ends the session; do not call any other tool after it.',
    schema: SubmitApyPredictionSchema,
    handler: async (rawArgs: unknown) => {
      const parsed = SubmitApyPredictionSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return toolErr('INVALID_ARGS', parsed.error.issues.map((i) => i.message).join('; '));
      }
      const { predictedBps, rationale } = parsed.data;
      const predictedBpsStr = String(predictedBps);
      onSubmit({ predictedBps: predictedBpsStr, rationale });
      return ok({
        accepted: true,
        predictedBps: predictedBpsStr,
        note: 'Prediction recorded. The session will terminate shortly after this response reaches Claude.',
      });
    },
  };

  return [readAaveReserve, submitApyPrediction];
}

function chainForVenue(venue: AaveV3Venue) {
  if (venue === 'aave-v3-base-sepolia') return { chain: baseSepolia, chainId: 84532 };
  if (venue === 'aave-v3-mainnet') return { chain: mainnet, chainId: 1 };
  return { chain: base, chainId: 8453 };
}

export interface McpServerConfig {
  venue: AaveV3Venue;
  pool: `0x${string}`;
  reserve: `0x${string}`;
  reserveSymbol: string;
  rpcUrl: string;
  submissionLogPath: string;
}

export async function startMcpServer(config: McpServerConfig): Promise<void> {
  const { chain } = chainForVenue(config.venue);
  const publicClient = createPublicClient({
    chain,
    transport: http(config.rpcUrl),
  }) as unknown as PublicClient;

  const onSubmit: ApyPredictionToolDeps['onSubmit'] = (submission) => {
    appendSubmissionRecord(config.submissionLogPath, {
      predictedBps: submission.predictedBps,
      rationale: submission.rationale,
    });
  };

  const tools = buildApyPredictionTools({
    pool: config.pool,
    reserve: config.reserve,
    reserveSymbol: config.reserveSymbol,
    venue: config.venue,
    publicClient,
    onSubmit,
  });

  await createStdioMcpServer({ serverName: 'jinn-apy-prediction', version: '1.0.0', tools });
}
