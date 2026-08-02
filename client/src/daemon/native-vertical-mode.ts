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

export interface OperatorVerticalDecision {
  readonly requestedMode: OperatorVerticalMode | undefined;
  readonly effectiveMode: OperatorVerticalMode;
  readonly readiness:
    | 'explicit-legacy'
    | 'explicit-native-unvalidated'
    | 'live-closure-missing'
    | 'live-closure-validated';
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

function assertNativeDeployment(input: {
  readonly network: 'mainnet' | 'testnet';
  readonly chain: MarketplaceChainConfig;
}): void {
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
}

function assertValidatedLiveClosure(liveClosure: ValidatedLiveClosure): void {
  if (
    liveClosure.status !== 'validated'
    || liveClosure.chain.chainId !== BASE_SEPOLIA_TODAY.chainId
    || liveClosure.chain.generation !== 'today'
    || !sameDeployment(liveClosure.chain, BASE_SEPOLIA_TODAY)
    || liveClosure.solutionSettlementFinalized !== true
    || liveClosure.verdictSettlementFinalized !== true
  ) {
    throw new NativeVerticalReadinessError(
      'live-closure-invalid',
      'native-v1 live closure receipt does not prove both finalized Base Sepolia settlements',
    );
  }
}

export function resolveOperatorVerticalMode(input: {
  readonly requestedMode?: OperatorVerticalMode;
  readonly network: 'mainnet' | 'testnet';
  readonly chain: MarketplaceChainConfig;
  readonly liveClosure?: ValidatedLiveClosure;
}): OperatorVerticalDecision {
  if (input.requestedMode === 'legacy') {
    return { requestedMode: 'legacy', effectiveMode: 'legacy', readiness: 'explicit-legacy' };
  }

  // An absent control is a default-selection request. The receipt may flip the
  // default only after closure; until then the compatibility product remains active.
  if (input.requestedMode === undefined && input.liveClosure === undefined) {
    return { requestedMode: undefined, effectiveMode: 'legacy', readiness: 'live-closure-missing' };
  }

  assertNativeDeployment(input);
  if (input.liveClosure === undefined) {
    return {
      requestedMode: 'native-v1',
      effectiveMode: 'native-v1',
      readiness: 'explicit-native-unvalidated',
    };
  }
  assertValidatedLiveClosure(input.liveClosure);
  return {
    requestedMode: input.requestedMode,
    effectiveMode: 'native-v1',
    readiness: 'live-closure-validated',
  };
}
