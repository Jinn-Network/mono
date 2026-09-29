/**
 * jinn-mono#963 regression: `initPredictedSafe` MUST pin the Safe contract
 * version to 1.3.0.
 *
 * @safe-global/protocol-kit v7 changed the DEFAULT Safe version 1.3.0 -> 1.4.1.
 * The operator Safe is registered as the OLAS service multisig, and OLAS
 * `GnosisSafeSameAddressMultisig` enforces `keccak256(proxy.code) ==` an
 * immutable proxyHash set for the 1.3.0 `GnosisSafeProxy`. A 1.4.1 SafeProxy has
 * different runtime bytecode, so an unpinned v7 default would deploy 1.4.1 and
 * revert `service_deployed` with `UnauthorizedMultisig`, breaking the earning
 * bootstrap. CI on `next` does NOT exercise the real deploy path (the Anvil e2e
 * is excluded from `yarn test`), so this unit guard locks the pin: dropping
 * `safeDeploymentConfig.safeVersion` makes this test fail loudly.
 *
 * The pin is transport-independent: `initPredictedSafe` hands `Safe.init` an
 * EIP-1193 provider over the whole #592 fallback chain rather than a URL string
 * (#4869), which changes which RPC answers, never which contracts deploy.
 * Confirmed on a Base-mainnet Anvil fork with a dead slot 0 and the fork as
 * slot 1: the Safe deployed through the healthy tail, and
 * `keccak256(getCode(safe))` came back
 * `0xb89c1b3bdf2cf8827818646bce9a8f6e372885f8c55e5c07acbd307cb133b000` — byte
 * for byte the immutable `proxyHash()` that OLAS
 * `GnosisSafeSameAddressMultisig` (`0xFbBEc0C8b13B38a9aC0499694A69a10204c5E2aB`
 * on Base) enforces. That hash is the number to re-measure against if this pin
 * is ever questioned; a 1.4.1 proxy does not produce it.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { Hex } from 'viem';

const { init } = vi.hoisted(() => ({ init: vi.fn() }));

// resolveSafeInit() unwraps `mod.default?.default ?? mod.default ?? mod` and
// then reads `.init`, so a `{ default: { init } }` shape resolves SafeClass to
// `{ init }`.
vi.mock('@safe-global/protocol-kit', () => ({ default: { init } }));

describe('initPredictedSafe Safe-version pin (#963)', () => {
  beforeEach(() => {
    init.mockReset();
    init.mockResolvedValue({
      getAddress: async () => '0x000000000000000000000000000000000000dEaD',
    });
  });

  it('pins safeVersion 1.3.0 in the predictedSafe deployment config', async () => {
    const { initPredictedSafe } = await import('../../src/earning/safe-adapter.js');

    await initPredictedSafe({
      rpcUrl: 'http://127.0.0.1:8545',
      signerKey: `0x${'11'.repeat(32)}` as Hex,
      owners: ['0x0000000000000000000000000000000000000001'],
      threshold: 1,
    });

    expect(init).toHaveBeenCalledTimes(1);
    const config = init.mock.calls[0][0] as {
      predictedSafe: { safeDeploymentConfig?: { safeVersion?: string } };
    };
    expect(config.predictedSafe.safeDeploymentConfig?.safeVersion).toBe('1.3.0');
  });
});
