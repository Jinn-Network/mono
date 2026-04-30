import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPublicClient, getAddress, http, parseAbi, zeroAddress } from 'viem';
import { baseSepolia } from 'viem/chains';
import { redactRpcUrls } from '../../src/util/redact-rpc-urls.js';

const describeLive = process.env['JINN_LIVE_RPC_TESTS'] === '1'
  ? describe
  : describe.skip;

const routerAbi = parseAbi([
  'function evaluationDeliveryCount(address multisig) view returns (uint256)',
]);

const JINN_ROUTER_PROXY_SLOT =
  '0x7ff8b2d5fad2fe8fb4c75b11d9b640a3b52819959b6fe5f04434cf6cdafd7222';

function decodeAddressFromStorage(value: `0x${string}` | undefined): `0x${string}` {
  if (!value || value === '0x') return zeroAddress;
  return getAddress(`0x${value.slice(-40)}`);
}

describeLive('live R-3 router surface', () => {
  it('Base Sepolia router proxy and implementation expose evaluationDeliveryCount(address)', async () => {
    try {
      const artifact = JSON.parse(readFileSync(
        resolve(process.cwd(), '../contracts/deployment-phase1b-router-checker-baseSepolia-fast.json'),
        'utf8',
      )) as {
        contracts: {
          jinnRouterV2Impl: string;
          jinnRouterProxy: string;
        };
      };
      const rpcUrl = process.env['BASE_SEPOLIA_RPC_URL'] ?? 'https://sepolia.base.org';
      const routerImpl = getAddress(
        process.env['JINN_R3_ROUTER_IMPL'] ?? artifact.contracts.jinnRouterV2Impl,
      );
      const routerProxy = getAddress(
        process.env['JINN_R3_ROUTER_PROXY'] ?? artifact.contracts.jinnRouterProxy,
      );
      const sampleMultisig = process.env['JINN_R3_MULTISIG']
        ? getAddress(process.env['JINN_R3_MULTISIG'])
        : zeroAddress;

      const client = createPublicClient({
        chain: baseSepolia,
        transport: http(rpcUrl),
      });

      const [implCode, proxyCode, proxyImplSlot, implCounter, proxyCounter] =
        await Promise.all([
          client.getBytecode({ address: routerImpl }),
          client.getBytecode({ address: routerProxy }),
          client.getStorageAt({ address: routerProxy, slot: JINN_ROUTER_PROXY_SLOT }),
          client.readContract({
            address: routerImpl,
            abi: routerAbi,
            functionName: 'evaluationDeliveryCount',
            args: [sampleMultisig],
          }),
          client.readContract({
            address: routerProxy,
            abi: routerAbi,
            functionName: 'evaluationDeliveryCount',
            args: [sampleMultisig],
          }),
        ]);

      expect(implCode).toBeDefined();
      expect(implCode).not.toBe('0x');
      expect(proxyCode).toBeDefined();
      expect(proxyCode).not.toBe('0x');
      expect(decodeAddressFromStorage(proxyImplSlot).toLowerCase()).toBe(
        routerImpl.toLowerCase(),
      );
      expect(typeof implCounter).toBe('bigint');
      expect(typeof proxyCounter).toBe('bigint');
    } catch (error) {
      throw new Error(redactRpcUrls(error));
    }
  }, 30_000);
});
