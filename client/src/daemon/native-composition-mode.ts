/**
 * Which composition the ONE fleet daemon assembles (one-swap M2, umbrella #2461, DR-2026-08-05).
 *
 * Its own module, deliberately kept tiny. `main.ts` resolves the mode at the very top of boot, so
 * whatever this file imports is loaded on EVERY boot including a legacy one. The native runtime
 * assembly (`native-fleet-runtime.ts`, which pulls the trust catalog, the record transport and the
 * Base Sepolia read clients) is therefore NOT reachable from here — `main.ts` reaches it through a
 * dynamic import inside the native branch only, so a legacy boot never loads any of it.
 */
import {
  BASE_SEPOLIA_TODAY,
  type MarketplaceChainConfig,
} from '@jinn-network/marketplace-binding';
import type { NativeCompositionMode } from '../config/native-sections.js';
import { assertNativeDeployment } from './native-vertical-mode.js';

/**
 * Absent is legacy. `'legacy'` is legacy. Only an explicit `'native'` selects native, and only
 * after `assertNativeDeployment` — DR-2026-08-05 decision 8 — so native + mainnet THROWS here
 * rather than quietly returning `'legacy'`.
 *
 * `configuredNetwork` must be the network AS WRITTEN in the config file, before `main.ts`'s
 * pre-launch mainnet clamp rewrites it to testnet. An operator who wrote `network: "mainnet"` with
 * `compositionMode: "native"` has to see the refusal; letting the clamp turn that into a quiet
 * native-on-testnet boot would be precisely the silent fallback decision 8 forbids.
 *
 * `chain` exists so a test (or a future pinned redeployment) can drive the gate against a chain
 * other than the default. Production passes nothing: native-v1 runs on the pinned
 * `BASE_SEPOLIA_TODAY` deployment and on no other, and the gate re-checks that too.
 */
export function resolveFleetCompositionMode(input: {
  readonly compositionMode: NativeCompositionMode | undefined;
  readonly configuredNetwork: 'mainnet' | 'testnet';
  readonly chain?: MarketplaceChainConfig;
}): 'legacy' | 'native' {
  if (input.compositionMode !== 'native') return 'legacy';
  assertNativeDeployment({
    network: input.configuredNetwork,
    chain: input.chain ?? BASE_SEPOLIA_TODAY,
  });
  return 'native';
}
