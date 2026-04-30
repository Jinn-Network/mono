/**
 * SpecKind manifest — one entry per in-repo intent kind (parse + optional auto-gen).
 * See jinn-mono-6q1.1.
 */

import type { IntentGenerator } from '../sources.js';

/** Overlay fields merged into RestorationJob when posting from --spec-file. */
export type ParsedSpecOverlay = {
  window: unknown;
  spec: unknown;
  eligibility: unknown;
};

/** Optional deps for kinds that resolve sentinels at parse time (e.g. Chainlink). */
export interface ParseDeps {
  readCurrent?: (args: {
    feed: `0x${string}`;
    venue: 'chainlink-base' | 'chainlink-base-sepolia';
  }) => Promise<string>;
}

/** Context for optional testnet auto-intent registration (see {@link collectTestnetAutoIntentGenerators}). */
export interface TestnetAutoContext {
  network: 'mainnet' | 'testnet';
  rpcUrl: string;
  env: NodeJS.ProcessEnv;
  /** Agent EOA address — threaded into auto-gen configs so generators can populate creator. */
  agentEoa?: `0x${string}`;
  /** Safe address — threaded into auto-gen configs so generators can populate creator. */
  safeAddress?: `0x${string}`;
  /** Agent EOA private key — threaded into auto-gen configs so generators can sign SignedIntentV1. */
  agentPrivateKey?: `0x${string}`;
  /**
   * Override the prediction.v0 auto-generator submission window (ms). Used by the
   * docker acceptance gate to keep the protocol loop tight (gate sets 120000).
   * Default 600000 (10 min) when unset.
   */
  predictionV0WindowMs?: number;
  /**
   * Override the prediction.v0 auto-generator gap from window end → resolveTs (ms).
   * Default 300000 (5 min) when unset; gate sets 60000.
   */
  predictionV0ResolveGapMs?: number;
}

export interface SpecKind<GenConfig = unknown> {
  kind: string;
  parseSpec: (raw: unknown, deps?: ParseDeps) => Promise<ParsedSpecOverlay>;
  buildGenerator?: (config: GenConfig) => IntentGenerator;
  /**
   * If this returns a config object, the daemon may register `buildGenerator(config)` on testnet.
   * Return `undefined` to skip (default for kinds without auto-gen or not enabled on testnet).
   */
  getTestnetAutoConfig?: (ctx: TestnetAutoContext) => GenConfig | undefined;
  ui?: { description: string; category: string };
}
