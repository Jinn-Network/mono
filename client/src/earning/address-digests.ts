/**
 * Pinned broadcast-target address-set digest (issue #2407, spec §5).
 *
 * Integrity class, fail-closed: a resolved broadcast-target address set that
 * does not match the pinned per-network deployment digest means the
 * daemon's contract-call targets diverged from what shipped — most likely
 * an env-overridden deployment-artifact path (earning/contracts.ts's
 * `ChainConfigOverrides` / `JINN_TESTNET_*_DEPLOYMENT` env vars,
 * contracts.ts:314-326,410) pointing somewhere unexpected. Address fields
 * are otherwise only presence-checked, so a misconfigured broadcaster would
 * silently keep broadcasting under degrade-open without this check.
 *
 * The pinned sets below are the plaintext addresses (not secrets — every one
 * is a public contract address already listed in CLAUDE.md's on-chain
 * addresses table / contracts.ts's BASE_CONFIG / the bundled testnet
 * deployment artifacts). They double as the source the pinned hash is
 * derived from, so there is exactly one checked-in constant to keep in sync
 * after a redeploy, not a hash AND a plaintext copy that can drift apart.
 * Re-derive after any redeploy by running `getChainConfig(chain)` and
 * copying its five fields here — never hand-type an address.
 */
import { createHash } from 'node:crypto';
import type { ChainConfig } from './contracts.js';

export interface BroadcastTargetAddressSet {
  stakingProxy: string;
  distributor: string | undefined;
  marketplace: string;
  router: string | undefined;
  olasToken: string;
}

/** Build the broadcast-target address set from a resolved ChainConfig. */
export function addressSetFromChainConfig(config: ChainConfig): BroadcastTargetAddressSet {
  return {
    stakingProxy: config.stakingContract,
    distributor: config.distributorAddress,
    marketplace: config.mechMarketplace,
    router: config.jinnRouter,
    olasToken: config.olasToken,
  };
}

/** sha256 over the sorted-key, lower-cased JSON of the address set. */
export function hashBroadcastTargetAddressSet(set: BroadcastTargetAddressSet): string {
  const normalized: Record<string, string | null> = {};
  for (const key of (Object.keys(set) as (keyof BroadcastTargetAddressSet)[]).sort()) {
    const value = set[key];
    normalized[key] = value ? value.toLowerCase() : null;
  }
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

/**
 * Checked-in per-network broadcast-target address sets, derived from the
 * CURRENT resolved `getChainConfig` output (2026-08-04). Base mainnet
 * (8453) and Base Sepolia (84532) — the only two chains `getChainConfig`
 * supports.
 */
export const PINNED_ADDRESS_SETS: Record<number, BroadcastTargetAddressSet> = {
  8453: {
    stakingProxy: '0x51c5f4982b9b0b3c0482678f5847ea6228cc8e54',
    distributor: '0x40abf47B926181148000DbCC7c8DE76A3a61a66f',
    marketplace: '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020',
    router: '0xfFa7118A3D820cd4E820010837D65FAfF463181B',
    olasToken: '0x54330d28ca3357F294334BDC454a032e7f353416',
  },
  84532: {
    stakingProxy: '0x4DB0Fcb877CCd92B6AeEdAaD561DaccB0CCc7E39',
    distributor: '0x20951FBDb4F9cB1f051ef416BCB11A9Cfe3CEf81',
    marketplace: '0xD3233FdAaB51E9775f6bFCE8242B02C181D7c0e7',
    router: '0x6f47863Ac4120A5a97Af224a5e30C3Ec2c9eA247',
    olasToken: '0xAB9a01cd4A379e36006ec6df2960CF39EF79df63',
  },
};

/**
 * `JINN_ADDRESS_DIGEST_OVERRIDE` escape (documented, boot-warned per spec
 * §5): set for a local Anvil fork or any deployment whose resolved address
 * set is deliberately NOT the pinned production set (e.g. locally-deployed
 * contracts under `yarn e2e:daemon-harness`, `yarn staking`, or a custom
 * `testnetL2DeploymentPath`/`JINN_TESTNET_*_DEPLOYMENT` override). Any
 * non-empty value other than `0`/`false`/`no` skips the check.
 */
export function isAddressDigestCheckOverridden(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env['JINN_ADDRESS_DIGEST_OVERRIDE']?.trim().toLowerCase();
  if (!raw) return false;
  return raw !== '0' && raw !== 'false' && raw !== 'no';
}

export type AddressSetVerification =
  | { ok: true }
  | { ok: false; message: string; diverged: string[] };

/**
 * Compare a resolved address set's digest against the pinned per-chainId
 * constant. On mismatch, names every diverged field (comparing the
 * plaintext sets directly, case-insensitively) so the boot failure is
 * actionable rather than just "digest mismatch."
 */
export function verifyBroadcastTargetAddressSet(args: {
  chainId: number;
  set: BroadcastTargetAddressSet;
}): AddressSetVerification {
  const pinned = PINNED_ADDRESS_SETS[args.chainId];
  if (!pinned) {
    return {
      ok: false,
      message: `No pinned broadcast-target address-set digest is checked in for chainId ${args.chainId}.`,
      diverged: [],
    };
  }
  if (hashBroadcastTargetAddressSet(args.set) === hashBroadcastTargetAddressSet(pinned)) {
    return { ok: true };
  }
  const diverged: string[] = [];
  for (const key of Object.keys(pinned) as (keyof BroadcastTargetAddressSet)[]) {
    const expected = pinned[key]?.toLowerCase();
    const actual = args.set[key]?.toLowerCase();
    if (expected !== actual) diverged.push(key);
  }
  return {
    ok: false,
    message:
      `Resolved broadcast-target address set does not match the pinned digest for chainId ${args.chainId}: ` +
      `diverged field(s) ${diverged.join(', ')}.`,
    diverged,
  };
}
