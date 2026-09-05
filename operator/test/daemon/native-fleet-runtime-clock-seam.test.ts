/**
 * The effective-time (`now`) seam on `buildFleetNativeRuntime` (#2490, umbrella #2461).
 *
 * The native boot proves two time-windowed things before it can hand back a runtime: the trust
 * policy chain (`openNativeTrustCatalog`) and every role key's effective-time binding
 * (`openRoleIdentitySet`). Both already carried an injectable clock; `buildFleetNativeRuntime` was
 * the one layer that pinned them to wall-clock by omission, which is why the M7 fork rig had to
 * open the identity sets by hand and stop short of the real boot.
 *
 * What this file proves, deterministically and off-chain:
 *   1. an injected `now` genuinely DRIVES those window checks — a clock outside the binding window
 *      is refused while wall-clock is inside it, so the assertion cannot pass by accident;
 *   2. omitting `now` is exactly wall-clock (the production default, byte-identical to pre-seam).
 *
 * The chain reads the boot makes are the anchor lookup only, so the fork is stood in for by a
 * small `publicClient` stub answering for one finalized calldata anchor.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildFleetNativeRuntime } from '../../src/daemon/native-fleet-runtime.js';
import { Store } from '../../src/store/store.js';
import { buildTwoOperatorNativeSetup } from '../e2e/fixtures/native-fleet/config.js';

const PASSWORD = 'native-fleet-clock-seam-password';
const CEREMONY_ACCOUNT = privateKeyToAccount(`0x${'11'.repeat(32)}`);
/** A contract account, never the ceremony EOA — the §2.3b settlement authority. */
const SETTLEMENT_SAFE = `0x${'5a'.repeat(20)}` as const;

const ANCHOR_TX = `0x${'a1'.repeat(32)}` as const;
const ANCHOR_CONTRACT = `0x${'22'.repeat(20)}` as const;
const ANCHOR_BLOCK_HASH = `0x${'33'.repeat(32)}` as const;
const ANCHOR_BLOCK = 100n;
/**
 * The anchor's block time, and therefore the catalog's `validFrom`. Deliberately in the PAST of the
 * wall-clock this file pins below, so "injected clock" and "wall-clock" are distinguishable instants
 * rather than the same one wearing two hats.
 */
const ANCHOR_TIME = '2026-08-01T00:00:00.000Z';
/** Inside the binding window (after `validFrom`, before the catalog's `refreshBy`). */
const WALL_CLOCK = new Date('2026-08-20T00:00:00.000Z');
/** Outside it, on the wrong side of `validFrom`: no binding is effective yet. */
const BEFORE_VALID_FROM = new Date('2026-07-01T00:00:00.000Z');

/**
 * The only chain reads a native boot makes: `createBaseSepoliaFinalizedAnchorClient`'s lookup of
 * the one catalog anchor. `readContract` is reachable only from `verifyOnchainAuthority`, which the
 * boot never calls, so it throws rather than inventing an answer.
 */
function anchorOnlyPublicClient(anchorDigest: `sha256:${string}`) {
  const digestHex = anchorDigest.slice('sha256:'.length);
  const block = {
    number: ANCHOR_BLOCK,
    hash: ANCHOR_BLOCK_HASH,
    timestamp: BigInt(Date.parse(ANCHOR_TIME) / 1000),
  };
  return {
    async getTransaction() {
      return {
        hash: ANCHOR_TX,
        to: ANCHOR_CONTRACT,
        input: `0x${digestHex}`,
        blockHash: ANCHOR_BLOCK_HASH,
        blockNumber: ANCHOR_BLOCK,
      };
    },
    async getTransactionReceipt() {
      return { status: 'success', blockHash: ANCHOR_BLOCK_HASH, blockNumber: ANCHOR_BLOCK };
    },
    async getBlock(input: { readonly blockTag?: string } = {}) {
      // `finalized` is read for the burial check; the anchor's own block is read by number.
      return input.blockTag === 'finalized' ? { ...block, number: ANCHOR_BLOCK + 64n } : block;
    },
    async readContract() {
      throw new Error('native boot made an unexpected contract read');
    },
  } as unknown as Parameters<typeof buildFleetNativeRuntime>[0]['publicClient'];
}

/**
 * Builds the two-operator fixture and returns it alongside the anchor digest the fixture actually
 * asked to be anchored — captured from `submitAnchor` rather than recomputed here, so the stub
 * below cannot drift out of agreement with the catalog it is meant to answer for.
 */
async function twoOperatorSetup(root: string) {
  let anchorDigest: `sha256:${string}` | undefined;
  const setup = await buildTwoOperatorNativeSetup({
    rootDir: root,
    password: PASSWORD,
    rpcUrl: 'http://127.0.0.1:0',
    ipfsApiUrl: 'http://127.0.0.1:0',
    ceremonyAccount: CEREMONY_ACCOUNT,
    // Supplying `submitAnchor` takes the fixture's REAL-anchor path, so the catalog carries a
    // locator the production anchor client resolves — against the stub above rather than a fork.
    submitAnchor: async (digest) => {
      anchorDigest = digest;
      return {
        transactionHash: ANCHOR_TX,
        contractAddress: ANCHOR_CONTRACT,
        inputByteOffset: 0,
        anchorTime: ANCHOR_TIME,
      };
    },
    aPublicBaseUrl: 'http://127.0.0.1:7401/a',
    bPublicBaseUrl: 'http://127.0.0.1:7402/b',
    aSafeAddress: SETTLEMENT_SAFE,
  });
  if (anchorDigest === undefined) throw new Error('fixture anchored nothing');
  return { setup, anchorDigest };
}

describe('buildFleetNativeRuntime effective-time seam', () => {
  const stores: Store[] = [];
  afterEach(() => {
    vi.useRealTimers();
    for (const store of stores.splice(0)) store.close();
  });

  async function boot(now?: () => Date) {
    const root = await mkdtemp(join(tmpdir(), 'native-fleet-clock-'));
    const { setup, anchorDigest } = await twoOperatorSetup(root);
    const store = new Store(join(root, 'jinn.db'));
    stores.push(store);
    return buildFleetNativeRuntime({
      config: setup.operatorA.config,
      store,
      publicClient: anchorOnlyPublicClient(anchorDigest),
      safeAddress: SETTLEMENT_SAFE,
      stateRoot: join(root, 'state'),
      password: PASSWORD,
      workerOwnerId: 'native-fleet-clock-seam',
      ...(now === undefined ? {} : { now }),
    });
  }

  it('boots the full runtime at an injected effective time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(WALL_CLOCK);
    const runtime = await boot(() => new Date(ANCHOR_TIME));

    // The whole assembly, not just the identities: this is the leg the fork rig could not reach.
    expect(runtime.identities.get('solver-delivery').keyId).toMatch(/^did:key:/u);
    expect(runtime.identities.get('requester-submission').keyId).toMatch(/^did:key:/u);
    expect(runtime.claimRuntime.operatorAgent).toBe('urn:jinn:operator:fleet-e2e-a');
    expect(runtime.discovery).toBeDefined();
    // Operator A provisioned admission custody, so the requester WRITE authority opened too — the
    // second `openRoleIdentitySet` call site the seam has to reach.
    expect(runtime.requesterWrite?.admissionAgent).toBe('urn:jinn:admission:fleet-e2e-a');
  });

  it('refuses when the injected clock falls outside the binding window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // Wall-clock is INSIDE the window, so only the injected clock can produce this refusal.
    vi.setSystemTime(WALL_CLOCK);
    // The role-binding effective-time check itself, by name. (Which role is named first is not
    // fixed — the solver and requester stores open concurrently — so only the check is matched.)
    await expect(boot(() => BEFORE_VALID_FROM))
      .rejects.toThrow(/has no effective binding at boot/u);
  });

  it('defaults to wall-clock when no clock is injected', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(WALL_CLOCK);
    const runtime = await boot();
    expect(runtime.identities.get('solver-delivery').keyId).toMatch(/^did:key:/u);

    // And the default really is wall-clock, not a hidden constant: move the host clock before
    // `validFrom` and the identical call refuses.
    vi.setSystemTime(BEFORE_VALID_FROM);
    await expect(boot()).rejects.toThrow(/has no effective binding at boot/u);
  });
});
