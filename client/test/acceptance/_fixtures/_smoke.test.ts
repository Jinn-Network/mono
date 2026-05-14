/**
 * Acceptance fixture smoke tests (r83r Task 6).
 *
 * Validates that:
 *   1. Anvil starts and responds to eth_chainId.
 *   2. IdentityRegistryStub deploys successfully and its address is contract code.
 *
 * These run via `yarn e2e:cold-start-builder` (acceptance tier, ~90 s budget).
 * Requires `anvil` in PATH (Foundry).
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { startAnvil, type AnvilHandle } from './anvil.js';
import { deployIdentityRegistry } from './identity-registry-deploy.js';

describe('acceptance fixtures smoke (r83r)', () => {
  let anvil: AnvilHandle;

  beforeAll(async () => {
    anvil = await startAnvil();
  }, 30_000);

  afterAll(async () => {
    await anvil.stop();
  });

  it('anvil starts and responds to eth_chainId with 0x7a69 (31337)', async () => {
    const r = await fetch(anvil.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    }).then((res) => res.json() as Promise<{ result: string }>);
    expect(r.result).toBe('0x7a69');
  });

  it('deploys an IdentityRegistryStub and the address has bytecode', async () => {
    const { address } = await deployIdentityRegistry({ rpcUrl: anvil.rpcUrl });
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);

    // Verify the contract exists on chain by fetching its code.
    const codeResult = await fetch(anvil.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'eth_getCode',
        params: [address, 'latest'],
      }),
    }).then((res) => res.json() as Promise<{ result: string }>);
    expect(codeResult.result).not.toBe('0x');
    expect(codeResult.result.length).toBeGreaterThan(4);
  });
});
