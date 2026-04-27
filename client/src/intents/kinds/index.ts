/**
 * Single dispatch table for in-repo intent kinds — jinn-mono-6q1.1.
 */

import type { IntentGenerator } from '../sources.js';
import { portfolioV0 } from './portfolio-v0.js';
import { predictionV0 } from './prediction-v0.js';
import { predictionApyV0 } from './prediction-apy-v0.js';
import type { SpecKind, TestnetAutoContext } from './spec-kind.js';

export type { ParsedSpecOverlay, ParseDeps, SpecKind, TestnetAutoContext } from './spec-kind.js';
export { PREDICTION_V0_KIND } from './constants.js';

/** Insertion order is stable for error messages and tests. */
export const SPEC_KINDS: Record<string, SpecKind<any>> = {
  'portfolio.v0': portfolioV0,
  'prediction.v0': predictionV0,
  'prediction.apy.v0': predictionApyV0,
};

export function knownKinds(): string[] {
  return Object.keys(SPEC_KINDS);
}

export function unknownKindMessage(kind: string | undefined): string {
  const k = kind === undefined || kind === '' ? 'missing' : kind;
  return `unknown intent kind: ${k}; known kinds: ${knownKinds().join(', ')}`;
}

/**
 * Testnet auto-intent generators: every registered kind with both
 * `getTestnetAutoConfig` and `buildGenerator` is included when config is non-undefined.
 * Add a new in-repo auto kind by implementing those on the kind module — no `main.ts` edit.
 */
export function collectTestnetAutoIntentGenerators(opts: {
  network: 'mainnet' | 'testnet';
  rpcUrl: string;
  autoIntentsDisabled: boolean;
  env: NodeJS.ProcessEnv;
  /** Agent EOA address — passed to generator configs that produce SignedIntentV1. */
  agentEoa?: `0x${string}`;
  /** Safe address — passed to generator configs that populate intent.creator. */
  safeAddress?: `0x${string}`;
  /** Agent EOA private key — passed to generator configs that sign intents. */
  agentPrivateKey?: `0x${string}`;
}): { generators: Array<{ kind: string; generator: IntentGenerator }>; logLines: string[] } {
  const generators: Array<{ kind: string; generator: IntentGenerator }> = [];
  const logLines: string[] = [];
  if (opts.autoIntentsDisabled || opts.network !== 'testnet') {
    return { generators, logLines };
  }
  const ctx: TestnetAutoContext = {
    network: opts.network,
    rpcUrl: opts.rpcUrl,
    env: opts.env,
    agentEoa: opts.agentEoa,
    safeAddress: opts.safeAddress,
    agentPrivateKey: opts.agentPrivateKey,
  };
  for (const kind of knownKinds()) {
    const entry = SPEC_KINDS[kind] as SpecKind;
    const genConfig = entry.getTestnetAutoConfig?.(ctx);
    if (genConfig === undefined) continue;
    const g = entry.buildGenerator?.(genConfig as never);
    if (g) {
      generators.push({ kind: entry.kind, generator: g });
      logLines.push(`[main] auto-intent generator enabled: ${entry.kind} (testnet)`);
    }
  }
  return { generators, logLines };
}
