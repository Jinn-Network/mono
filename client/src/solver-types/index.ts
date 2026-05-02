/**
 * Single dispatch table for in-repo SolverTypes — jinn-mono-6q1.1.
 */

import type { TaskGenerator } from '../tasks/sources.js';
import { portfolioV0 } from './portfolio-v0.js';
import { predictionV0 } from './prediction-v0.js';
import { predictionV1 } from './prediction-v1.js';
import { predictionApyV0 } from './prediction-apy-v0.js';
import { learnerLoopTest } from './learner-loop-test.js';
import type { SolverTypeDefinition, TestnetAutoContext } from './solver-type.js';

export type { ParsedSpecOverlay, ParseDeps, SolverTypeDefinition, TestnetAutoContext } from './solver-type.js';
export { PREDICTION_V0_KIND } from './constants.js';

/** Insertion order is stable for error messages and tests. */
export const SOLVER_TYPES: Record<string, SolverTypeDefinition<any>> = {
  'portfolio.v0': portfolioV0,
  'prediction.v0': predictionV0,
  'prediction.v1': predictionV1,
  'prediction.apy.v0': predictionApyV0,
  'learner-loop-test': learnerLoopTest,
};

export function knownSolverTypes(): string[] {
  return Object.keys(SOLVER_TYPES);
}

export function unknownSolverTypeMessage(kind: string | undefined): string {
  const k = kind === undefined || kind === '' ? 'missing' : kind;
  return `unknown SolverType: ${k}; known SolverTypes: ${knownSolverTypes().join(', ')}`;
}

/**
 * Testnet auto-task generators: every registered SolverType with both
 * `getTestnetAutoConfig` and `buildGenerator` is included when config is non-undefined.
 * Add a new in-repo auto SolverType by implementing those on the SolverType module — no `main.ts` edit.
 */
export function collectTestnetAutoTaskGenerators(opts: {
  network: 'mainnet' | 'testnet';
  rpcUrl: string;
  autoTasksDisabled: boolean;
  env: NodeJS.ProcessEnv;
  /** Agent EOA address — passed to generator configs that produce SignedTaskV1. */
  agentEoa?: `0x${string}`;
  /** Safe address — passed to generator configs that populate task.creator. */
  safeAddress?: `0x${string}`;
  /** Agent EOA private key — passed to generator configs that sign tasks. */
  agentPrivateKey?: `0x${string}`;
  /** Override prediction.v0 submission window (ms). */
  predictionV0WindowMs?: number;
  /** Override prediction.v0 window→resolveTs gap (ms). */
  predictionV0ResolveGapMs?: number;
}): { generators: Array<{ solverType: string; generator: TaskGenerator }>; logLines: string[] } {
  const generators: Array<{ solverType: string; generator: TaskGenerator }> = [];
  const logLines: string[] = [];
  if (opts.autoTasksDisabled || opts.network !== 'testnet') {
    return { generators, logLines };
  }
  const ctx: TestnetAutoContext = {
    network: opts.network,
    rpcUrl: opts.rpcUrl,
    env: opts.env,
    agentEoa: opts.agentEoa,
    safeAddress: opts.safeAddress,
    agentPrivateKey: opts.agentPrivateKey,
    predictionV0WindowMs: opts.predictionV0WindowMs,
    predictionV0ResolveGapMs: opts.predictionV0ResolveGapMs,
  };
  for (const kind of knownSolverTypes()) {
    const entry = SOLVER_TYPES[kind] as SolverTypeDefinition;
    const genConfig = entry.getTestnetAutoConfig?.(ctx);
    if (genConfig === undefined) continue;
    const g = entry.buildGenerator?.(genConfig as never);
    if (g) {
      generators.push({ solverType: entry.solverType, generator: g });
      logLines.push(`[main] auto-task generator enabled: ${entry.solverType} (testnet)`);
    }
  }
  return { generators, logLines };
}
