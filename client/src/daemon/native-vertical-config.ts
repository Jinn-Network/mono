import { existsSync, readFileSync } from 'node:fs';

import {
  resolveOperatorVerticalMode,
  type OperatorVerticalDecision,
} from './native-vertical-mode.js';
import {
  parseValidatedPhaseBClosureManifest,
  type ValidatedPhaseBClosureManifest,
} from './phase-b-closure-manifest.js';

/** Resolves the product mode using structured config before any role key or wallet is loaded. */
interface VerticalModeConfig {
  readonly network: 'mainnet' | 'testnet';
  readonly operator?: {
    readonly verticalMode?: 'legacy' | 'native-v1';
    readonly native?: {
      readonly chainId: number;
      readonly generation: 'today' | 'revised';
      readonly contracts: {
        readonly taskCoordinator: string;
        readonly jinnRouter: string;
        readonly mechMarketplace: string;
        readonly activityChecker: string;
      };
      readonly liveClosureReceiptPath: string;
    };
  };
}

function configuredChain(native: NonNullable<NonNullable<VerticalModeConfig['operator']>['native']>) {
  return {
    chainId: native.chainId,
    generation: native.generation,
    taskCoordinator: native.contracts.taskCoordinator as `0x${string}`,
    jinnRouter: native.contracts.jinnRouter as `0x${string}`,
    mechMarketplace: native.contracts.mechMarketplace as `0x${string}`,
    activityChecker: native.contracts.activityChecker as `0x${string}`,
  };
}

export function resolveConfiguredOperatorVerticalMode(config: VerticalModeConfig): OperatorVerticalDecision {
  const requestedMode = config.operator?.verticalMode;
  const native = config.operator?.native;
  if (requestedMode === 'legacy') {
    return resolveOperatorVerticalMode({
      requestedMode,
      network: config.network,
      chain: native === undefined
        ? ({ chainId: config.network === 'mainnet' ? 8453 : 84532 } as never)
        : configuredChain(native),
    });
  }
  if (native === undefined) {
    if (requestedMode === 'native-v1') throw new Error('native-v1 requires operator.native configuration');
    return {
      requestedMode: undefined,
      effectiveMode: 'legacy',
      readiness: 'live-closure-missing',
    };
  }
  let liveClosure: ValidatedPhaseBClosureManifest | undefined;
  if (existsSync(native.liveClosureReceiptPath)) {
    liveClosure = parseValidatedPhaseBClosureManifest(readFileSync(native.liveClosureReceiptPath));
  }
  return resolveOperatorVerticalMode({
    requestedMode,
    network: config.network,
    chain: configuredChain(native),
    ...(liveClosure === undefined ? {} : { liveClosure }),
  });
}
