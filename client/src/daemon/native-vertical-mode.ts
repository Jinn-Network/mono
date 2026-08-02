import {
  BASE_SEPOLIA_TODAY,
  type MarketplaceChainConfig,
} from '@jinn-network/marketplace-binding';

export type OperatorVerticalMode = 'legacy' | 'native-v1';

export type NativeVerticalReadinessReason =
  | 'live-closure-missing'
  | 'live-closure-invalid'
  | 'mainnet-refused'
  | 'network-mismatch'
  | 'generation-mismatch'
  | 'contracts-mismatch';

export interface ValidatedLiveClosure {
  readonly status: 'validated';
  readonly chain: MarketplaceChainConfig;
  readonly solutionSettlementFinalized: true;
  readonly verdictSettlementFinalized: true;
}

export class NativeVerticalReadinessError extends Error {
  override readonly name = 'NativeVerticalReadinessError';

  constructor(readonly reason: NativeVerticalReadinessReason, message: string) {
    super(message);
  }
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function sameDeployment(actual: MarketplaceChainConfig, expected: MarketplaceChainConfig): boolean {
  return sameAddress(actual.taskCoordinator, expected.taskCoordinator)
    && sameAddress(actual.jinnRouter, expected.jinnRouter)
    && sameAddress(actual.mechMarketplace, expected.mechMarketplace)
    && sameAddress(actual.activityChecker, expected.activityChecker);
}

export function resolveOperatorVerticalMode(input: {
  readonly requestedMode?: OperatorVerticalMode;
  readonly network: 'mainnet' | 'testnet';
  readonly chain: MarketplaceChainConfig;
  readonly liveClosure?: ValidatedLiveClosure;
}): {
  readonly requestedMode: OperatorVerticalMode;
  readonly effectiveMode: OperatorVerticalMode;
  readonly readiness: 'explicit-legacy' | 'live-closure-validated';
} {
  const requestedMode = input.requestedMode ?? 'legacy';
  if (requestedMode === 'legacy') {
    return { requestedMode, effectiveMode: 'legacy', readiness: 'explicit-legacy' };
  }

  if (input.chain.chainId === 8453) {
    throw new NativeVerticalReadinessError(
      'mainnet-refused',
      'native-v1 refuses Base mainnet chainId 8453 even when mainnet enablement flags are present',
    );
  }
  if (input.network !== 'testnet' || input.chain.chainId !== BASE_SEPOLIA_TODAY.chainId) {
    throw new NativeVerticalReadinessError(
      'network-mismatch',
      `native-v1 requires testnet chainId ${BASE_SEPOLIA_TODAY.chainId}`,
    );
  }
  if (input.chain.generation !== 'today') {
    throw new NativeVerticalReadinessError('generation-mismatch', 'native-v1 requires the today contract generation');
  }
  if (!sameDeployment(input.chain, BASE_SEPOLIA_TODAY)) {
    throw new NativeVerticalReadinessError(
      'contracts-mismatch',
      'native-v1 requires the exact BASE_SEPOLIA_TODAY contract addresses',
    );
  }
  if (input.liveClosure === undefined) {
    throw new NativeVerticalReadinessError(
      'live-closure-missing',
      'native-v1 is requested but no validated live Phase B closure receipt is configured',
    );
  }
  if (
    input.liveClosure.status !== 'validated'
    || input.liveClosure.chain.chainId !== BASE_SEPOLIA_TODAY.chainId
    || input.liveClosure.chain.generation !== 'today'
    || !sameDeployment(input.liveClosure.chain, BASE_SEPOLIA_TODAY)
    || input.liveClosure.solutionSettlementFinalized !== true
    || input.liveClosure.verdictSettlementFinalized !== true
  ) {
    throw new NativeVerticalReadinessError(
      'live-closure-invalid',
      'native-v1 live closure receipt does not prove both finalized Base Sepolia settlements',
    );
  }
  return { requestedMode, effectiveMode: 'native-v1', readiness: 'live-closure-validated' };
}
