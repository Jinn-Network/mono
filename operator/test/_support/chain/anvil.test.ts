import { describe, it, expect, afterEach } from 'vitest';
import { spawnAnvilFork } from '@test/chain/anvil.js';
import type { ChainTestHarness } from '@test/chain/interface.js';

// This test requires Foundry (anvil) on PATH and internet connectivity for the fork.
const RUN_ANVIL = process.env['JINN_TEST_SKIP_ANVIL'] !== '1';
const describeMaybe = RUN_ANVIL ? describe : describe.skip;

describeMaybe('spawnAnvilFork', () => {
  let harness: (ChainTestHarness & { port: number; pid: number }) | undefined;

  afterEach(async () => {
    if (harness) { await harness.teardown(); harness = undefined; }
  });

  it('spawns an anvil fork on a dynamically allocated port', async () => {
    harness = await spawnAnvilFork({ silent: true });
    expect(harness.port).toBeGreaterThan(1024);
    expect(harness.rpcUrl).toBe(`http://127.0.0.1:${harness.port}`);
    const block = await harness.now();
    expect(block).toBeGreaterThan(0);
  }, 30_000);

  it('can set balance and mine blocks', async () => {
    harness = await spawnAnvilFork({ silent: true });
    const addr = '0x000000000000000000000000000000000000dEaD' as const;
    await harness.setBalance(addr, 10n ** 18n);
    const before = await harness.now();
    await harness.mineBlocks(3);
    const after = await harness.now();
    expect(after).toBeGreaterThanOrEqual(before);
  }, 30_000);
});
