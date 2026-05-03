/**
 * SolverTypeDefinition manifest — one entry per in-repo SolverType (parse + optional auto-gen).
 * See jinn-mono-6q1.1.
 */

import type { TaskGenerator } from '../tasks/sources.js';

/** Overlay fields merged into Task when posting from --spec-file. */
export type ParsedSpecOverlay = {
  window: unknown;
  claimPolicy?: unknown;
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

/** Context for optional testnet auto-task registration (see {@link collectTestnetAutoTaskGenerators}). */
export interface TestnetAutoContext {
  network: 'mainnet' | 'testnet';
  rpcUrl: string;
  env: NodeJS.ProcessEnv;
  /** Agent EOA address — threaded into auto-gen configs so generators can populate creator. */
  agentEoa?: `0x${string}`;
  /** Safe address — threaded into auto-gen configs so generators can populate creator. */
  safeAddress?: `0x${string}`;
  /** Agent EOA private key — threaded into auto-gen configs so generators can sign SignedTaskV1. */
  agentPrivateKey?: `0x${string}`;
  /**
   * Explicit opt-in for the launcher-owned Polymarket prediction.v1 generator.
   * Ordinary operator daemons leave this unset/false and do not create rounds.
   */
  predictionV1LauncherEnabled?: boolean;
  /**
   * Override the prediction.v1 Polymarket submission window (ms).
   * The generator default applies when unset.
   */
  predictionV1WindowMs?: number;
  /** Launcher-owned Polymarket generator cadence (ms). */
  predictionV1CadenceMs?: number;
  /** Launcher-owned Polymarket generator safety caps. */
  predictionV1MaxNewRoundsPerPoll?: number;
  predictionV1MaxNewRoundsPerDay?: number;
  predictionV1MaxOpenRounds?: number;
  /** Launcher-owned Polymarket manual conditionId controls. */
  predictionV1AllowlistConditionIds?: string[];
  predictionV1BlocklistConditionIds?: string[];
  /**
   * Legacy Chainlink prediction.v1 gap from window end → resolveTs (ms).
   * Retained for direct legacy generator tests; unused by Polymarket prediction.v1.
   */
  predictionV1ResolveGapMs?: number;
}

export interface SolverTypeDefinition<GenConfig = unknown> {
  solverType: string;
  parseSpec: (raw: unknown, deps?: ParseDeps) => Promise<ParsedSpecOverlay>;
  buildGenerator?: (config: GenConfig) => TaskGenerator;
  /**
   * If this returns a config object, the daemon may register `buildGenerator(config)` on testnet.
   * Return `undefined` to skip (default for kinds without auto-gen or not enabled on testnet).
   */
  getTestnetAutoConfig?: (ctx: TestnetAutoContext) => GenConfig | undefined;
  ui?: { description: string; category: string };
}
