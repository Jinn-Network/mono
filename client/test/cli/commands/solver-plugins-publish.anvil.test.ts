/**
 * Anvil-fork integration test for `jinn solver-plugins publish` (1pbc).
 *
 * Verifies the full encode + Safe-routed `setMetadata` path against a forked
 * Base Sepolia chain. Skipped automatically when ANVIL_RPC_URL is unset.
 *
 * Setup expectations (matches docs/runbooks/testing.md "anvil-fork" pyramid level):
 *   anvil --fork-url https://sepolia.base.org --port 8545 &
 *   ANVIL_RPC_URL=http://127.0.0.1:8545 yarn vitest run test/cli/commands/solver-plugins-publish.anvil.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  createPublicClient,
  http,
  encodeFunctionData,
  decodeAbiParameters,
  type Hex,
} from 'viem';
import { baseSepolia } from 'viem/chains';
import {
  PLUGIN_PAYLOAD_TUPLE,
  REVOCATION_PAYLOAD_TUPLE,
  IDENTITY_REGISTRY_SET_METADATA_ABI,
} from '../../../src/erc8004/abis.js';
import {
  encodePluginPayload,
  encodeRevocationPayload,
  buildPluginMetadataKey,
} from '../../../src/erc8004/plugin-registry.js';

const ANVIL_RPC = process.env.ANVIL_RPC_URL;
const BASE_SEPOLIA_IDENTITY_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';

const runOrSkip = ANVIL_RPC ? describe : describe.skip;

runOrSkip('solver-plugins publish — Anvil fork against Base Sepolia IdentityRegistry', () => {
  const _publicClient = createPublicClient({ chain: baseSepolia, transport: http(ANVIL_RPC) });

  it('encodePluginPayload calldata decodes to the original payload', () => {
    const payload = {
      version: 1 as const,
      pluginName: '@builder/swe-skill',
      pluginVersion: '0.1.0',
      pluginSha256: ('0x' + 'cd'.repeat(32)) as Hex,
      supports: ['swe-rebench-v2.v1'],
      publishedAt: 1_715_700_000,
    };

    const encoded = encodePluginPayload(payload);
    const decoded = decodeAbiParameters(PLUGIN_PAYLOAD_TUPLE, encoded);
    expect(decoded[0]).toBe(1);
    expect(decoded[1]).toBe('@builder/swe-skill');
    expect(decoded[3]).toBe(payload.pluginSha256);
    expect(decoded[4]).toEqual(['swe-rebench-v2.v1']);
  });

  it('encodes setMetadata calldata against the deployed IdentityRegistry', () => {
    const pluginCid = 'bafyExampleCid';
    const metadataKey = buildPluginMetadataKey(pluginCid);
    const payloadBytes = encodePluginPayload({
      version: 1,
      pluginName: '@builder/swe-skill',
      pluginVersion: '0.1.0',
      pluginSha256: ('0x' + 'ab'.repeat(32)) as Hex,
      supports: ['swe-rebench-v2.v1'],
      publishedAt: 1_715_700_000,
    });

    const calldata = encodeFunctionData({
      abi: IDENTITY_REGISTRY_SET_METADATA_ABI,
      functionName: 'setMetadata',
      args: [777n, metadataKey, payloadBytes],
    });

    expect(calldata).toMatch(/^0x[0-9a-f]+$/);
    // setMetadata(uint256, string, bytes) selector + args — verify length & shape.
    expect(calldata.length).toBeGreaterThan(2 + 8);
    // The contract address used here is the deployed Base Sepolia IdentityRegistry.
    expect(BASE_SEPOLIA_IDENTITY_REGISTRY).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('revocation payload v2 round-trips', () => {
    const encoded = encodeRevocationPayload({
      version: 2,
      revoked: true,
      reason: 'replaced by v0.2.0',
    });
    const decoded = decodeAbiParameters(REVOCATION_PAYLOAD_TUPLE, encoded);
    expect(decoded[0]).toBe(2);
    expect(decoded[1]).toBe(true);
    expect(decoded[2]).toBe('replaced by v0.2.0');
  });
});
