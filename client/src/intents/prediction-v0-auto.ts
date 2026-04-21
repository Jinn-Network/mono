/**
 * Auto-generator for prediction.v0 intents.
 *
 * Produces a fresh DesiredState per hour bucket: reads current Chainlink
 * price, builds a template with the configured threshold sentinel
 * (default "current+0.5%" — coin-flip-ish, slightly biased NO), and resolves
 * it via the shared template helper. Stable ID per hour prevents duplicate
 * posts within a window; the CreatorLoop's SQLite cache guards against
 * restart-replay.
 *
 * Wired in main.ts for testnet-only (jinn-mono-9ew). Operators can opt out
 * with JINN_DISABLE_AUTO_INTENTS=1.
 */

import { createPublicClient, http, type PublicClient } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { readChainlinkLatest, scaleToDecimal } from '../venues/chainlink/client.js';
import type { DesiredState } from '../types/desired-state.js';
import { resolvePredictionV0Template } from './prediction-v0-template.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface PredictionV0AutoConfig {
  /** Chainlink AggregatorV3 proxy address. Defaults to Base Sepolia ETH/USD. */
  feed: `0x${string}`;
  /** Human-readable feed description embedded in the generated intent. */
  feedDescription: string;
  /** Which chain the feed lives on. */
  venue: 'chainlink-base' | 'chainlink-base-sepolia';
  /**
   * Threshold sentinel to resolve each cycle. Defaults to "current+0.5%" —
   * biases slightly NO, Brier scores land meaningfully around 0.75. Use
   * "current" for a strict coin-flip direction question.
   */
  thresholdSentinel?: string;
  /** Comparator operator. Default 'GT'. */
  operator?: 'GT' | 'GTE' | 'LT' | 'LTE';
  /** RPC URL for the publicClient used to read Chainlink. */
  rpcUrl?: string;
  /** Injected publicClient — tests pass a mock; production leaves unset. */
  _publicClient?: PublicClient;
}

export type PredictionV0Generator = () => Promise<DesiredState | null>;

// ── Generator factory ──────────────────────────────────────────────────────────

/**
 * Build a generator closure. Calling the closure returns a freshly-resolved
 * DesiredState for the current hour bucket, or null if Chainlink is
 * unreachable (caller skips this tick).
 */
export function makePredictionV0Generator(config: PredictionV0AutoConfig): PredictionV0Generator {
  const threshold = config.thresholdSentinel ?? 'current+0.5%';
  const operator = config.operator ?? 'GT';

  // Lazy publicClient construction — reused across calls.
  let publicClient: PublicClient | null = config._publicClient ?? null;
  const getPublicClient = (): PublicClient => {
    if (publicClient) return publicClient;
    const chain = config.venue === 'chainlink-base' ? base : baseSepolia;
    const rpcUrl = config.rpcUrl ?? (config.venue === 'chainlink-base'
      ? 'https://mainnet.base.org'
      : 'https://sepolia.base.org');
    publicClient = createPublicClient({ chain, transport: http(rpcUrl) }) as unknown as PublicClient;
    return publicClient;
  };

  return async (): Promise<DesiredState | null> => {
    // Bucket start = hour boundary ≤ now.
    const now = Date.now();
    const hourMs = 3_600_000;
    const startTs = Math.floor(now / hourMs) * hourMs;
    const endTs = startTs + hourMs;
    const resolveTs = endTs + 900_000;

    const template = {
      id: `pred-v0-auto-${startTs}`,
      description: `Auto-generated prediction.v0 intent — ${config.feedDescription} ${operator} ${threshold} at ${new Date(resolveTs).toISOString()}`,
      window: { startTs, endTs },
      spec: {
        kind: 'prediction.v0',
        oracle: {
          venue: config.venue,
          feed: config.feed,
          feedDescription: config.feedDescription,
        },
        question: {
          kind: 'threshold',
          operator,
          threshold,
          resolveTs,
        },
      },
      eligibility: { maxSubmissionDelayMs: 60_000 },
    };

    try {
      const intent = await resolvePredictionV0Template(template, {
        readCurrent: async ({ feed }) => {
          const reading = await readChainlinkLatest(feed, getPublicClient());
          return scaleToDecimal(reading.answer, reading.decimals);
        },
      });
      // Return the resolved DesiredState shape (intent is already valid).
      return intent as unknown as DesiredState;
    } catch {
      // Chainlink read failure or schema mismatch — skip this tick, try next.
      return null;
    }
  };
}
