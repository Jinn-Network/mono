/**
 * SolverTypeDefinition manifest — one entry per in-repo SolverType (parse + optional auto-gen).
 * See jinn-mono-6q1.1.
 */

import type { Task } from '../types/task.js';
import type { LoadedHeldOutSlate } from './_swe-rebench-v2-held-out-slate.js';

/**
 * Returns freshly-built Tasks for this tick, or null to skip.
 *
 * Re-homed here from the deleted `tasks/sources.ts` by Wave-4 D3: it is the
 * return type of `SolverTypeDefinition.buildGenerator`, so the SolverType
 * contract is its natural owner now that the creator loop's task-source stack
 * is gone.
 */
export type TaskGenerator = () => Promise<Task | Task[] | null>;

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

/**
 * Context for optional testnet auto-task registration. Retained for SolverType
 * definitions that opt in via `getTestnetAutoConfig`; the daemon no longer
 * exposes a config-block-keyed `collectTestnetAutoTaskGenerators` entrypoint
 * — generator construction is launched-record-driven (Task 22 of
 * spec/2026-05-05-solvernet-creation-and-launch.md). Existing in-repo
 * SolverTypes (e.g. `prediction.apy.v0`) continue to consume this surface
 * directly through registry tests and bespoke wiring.
 */
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
  /** Resolved swe-rebench-v2 state dir from loadConfig (optional; unused call graph today). */
  sweRebenchV2StateDir?: string;
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
  /**
   * Load this SolverType's held-out eval slate at `version` (issue #817).
   * Optional so a future eval orchestrator can compose over SolverTypes that
   * define a slate; SolverTypes without one omit it. The slate is
   * content-addressed and throws on hash mismatch or unknown version.
   */
  loadHeldOutSlate?: (version: string) => LoadedHeldOutSlate;
  ui?: { description: string; category: string };
}
