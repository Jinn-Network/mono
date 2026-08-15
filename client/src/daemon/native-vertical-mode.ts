import {
  BASE_SEPOLIA_TODAY,
  type MarketplaceChainConfig,
} from '@jinn-network/marketplace-binding';
import type { ValidatedPhaseBClosureManifest } from './phase-b-closure-manifest.js';
// Defined in the neutral types/ home (#2380) so src/api/ can reference it without crossing the
// api -> daemon architecture boundary (#1584). Re-exported below so existing daemon-layer imports
// of `OperatorVerticalMode` from this module keep working unchanged.
import type { OperatorVerticalMode } from '../types/operator-vertical-mode.js';

export type { OperatorVerticalMode };

export type NativeVerticalReadinessReason =
  | 'live-closure-missing'
  | 'live-closure-invalid'
  | 'mainnet-refused'
  | 'network-mismatch'
  | 'generation-mismatch'
  | 'contracts-mismatch';

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

/**
 * The native boot gate. Exported (one-swap M2) so the ONE fleet daemon runs the identical
 * refusal before it assembles any native runtime — DR-2026-08-05 decision 8: native + mainnet
 * is an explicit, loud boot refusal, never a silent fall back to the legacy composition.
 */
export function assertNativeDeployment(input: {
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

function assertValidatedLiveClosure(liveClosure: ValidatedPhaseBClosureManifest): void {
  const manifest = liveClosure.manifest;
  if (
    !/^sha256:[0-9a-f]{64}$/u.test(liveClosure.digest)
    || manifest.liveRun !== true
    || manifest.chain.chainId !== BASE_SEPOLIA_TODAY.chainId
    || manifest.chain.generation !== 'today'
    || !sameDeployment(manifest.chain as MarketplaceChainConfig, BASE_SEPOLIA_TODAY)
    || manifest.settlements.solution.finalized !== true
    || manifest.settlements.verdict.finalized !== true
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
  readonly liveClosure?: ValidatedPhaseBClosureManifest;
}): OperatorVerticalDecision {
  if (input.requestedMode === 'legacy') {
    return { requestedMode: 'legacy', effectiveMode: 'legacy', readiness: 'explicit-legacy' };
  }

  // An absent control is a default-selection request. The receipt may flip the
  // default only after closure; until then the compatibility product remains active.
  if (input.requestedMode === undefined) {
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
  // A parsed local file is evidence input, not release authority. Until the closure verifier
  // independently resolves its chain, source, package and consumer references, explicit mode is
  // permitted for closure runs but the product never treats the local manifest as cutover proof.
  assertValidatedLiveClosure(input.liveClosure);
  return { requestedMode: 'native-v1', effectiveMode: 'native-v1', readiness: 'explicit-native-unvalidated' };
}
