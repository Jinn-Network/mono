import { existsSync, readFileSync } from 'node:fs';

import type { JinnConfig } from '../config.js';
import type { MarketplaceChainConfig } from '@jinn-network/marketplace-binding';
import {
  resolveOperatorVerticalMode,
  type OperatorVerticalDecision,
  type ValidatedLiveClosure,
} from './native-vertical-mode.js';

function parseLiveClosure(value: unknown): ValidatedLiveClosure {
  if (value === null || typeof value !== 'object') throw new Error('live closure receipt must be an object');
  const receipt = value as Record<string, unknown>;
  const chain = receipt['chain'] as Record<string, unknown> | undefined;
  if (
    receipt['status'] !== 'validated'
    || receipt['solutionSettlementFinalized'] !== true
    || receipt['verdictSettlementFinalized'] !== true
    || chain === undefined
    || typeof chain['chainId'] !== 'number'
    || typeof chain['generation'] !== 'string'
    || typeof chain['taskCoordinator'] !== 'string'
    || typeof chain['jinnRouter'] !== 'string'
    || typeof chain['mechMarketplace'] !== 'string'
    || typeof chain['activityChecker'] !== 'string'
  ) throw new Error('live closure receipt is not a finalized Phase B receipt');
  return receipt as unknown as ValidatedLiveClosure;
}

/** Resolves the product mode using structured config before any role key or wallet is loaded. */
export function resolveConfiguredOperatorVerticalMode(config: Pick<JinnConfig, 'network' | 'operator'>): OperatorVerticalDecision {
  const requestedMode = config.operator?.verticalMode;
  const native = config.operator?.native;
  if (requestedMode === 'legacy') {
    return resolveOperatorVerticalMode({
      requestedMode,
      network: config.network,
      chain: native === undefined
        ? ({ chainId: config.network === 'mainnet' ? 8453 : 84532 } as never)
        : { ...native.contracts, chainId: native.chainId, generation: native.generation } as MarketplaceChainConfig,
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
  let liveClosure: ValidatedLiveClosure | undefined;
  if (existsSync(native.liveClosureReceiptPath)) {
    liveClosure = parseLiveClosure(JSON.parse(readFileSync(native.liveClosureReceiptPath, 'utf8')));
  }
  return resolveOperatorVerticalMode({
    requestedMode,
    network: config.network,
    chain: { ...native.contracts, chainId: native.chainId, generation: native.generation } as MarketplaceChainConfig,
    ...(liveClosure === undefined ? {} : { liveClosure }),
  });
}
