import { describe, it, expect, afterEach } from 'vitest';
import { spawnAnvilFork, type AnvilHarness } from '@test/chain/anvil.js';
import { fundAddressWithOLAS, OLAS_TOKEN_BASE } from '@test/chain/olas-funding.js';
import { createPublicClient, http, parseAbi } from 'viem';

const RUN_ANVIL = process.env['JINN_TEST_SKIP_ANVIL'] !== '1';
const describeMaybe = RUN_ANVIL ? describe : describe.skip;

describeMaybe('fundAddressWithOLAS', () => {
  let harness: AnvilHarness | undefined;
  afterEach(async () => { if (harness) { await harness.teardown(); harness = undefined; } });

  it('sets the ERC-20 balance to the requested amount', async () => {
    harness = await spawnAnvilFork({ silent: true });
    const holder = '0x000000000000000000000000000000000000C0eD' as const;
    const amount = 5000n * 10n ** 18n;
    await fundAddressWithOLAS(harness, holder, amount);
    const client = createPublicClient({ transport: http(harness.rpcUrl) });
    const balance = await client.readContract({
      address: OLAS_TOKEN_BASE,
      abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
      functionName: 'balanceOf',
      args: [holder],
    });
    expect(balance).toBe(amount);
  }, 30_000);
});
