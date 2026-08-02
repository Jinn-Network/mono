import { BASE_SEPOLIA_TODAY } from '@jinn-network/marketplace-binding';
import { describe, expect, it, vi } from 'vitest';

import { main } from '../../src/native-main.js';

function nativeConfig() {
  return {
    network: 'testnet',
    operator: {
      verticalMode: 'native-v1',
      native: {
        role: 'solver',
        agent: 'urn:jinn:agent:solver',
        safeAddress: `0x${'12'.repeat(20)}`,
        marketplaceAgentAddress: `0x${'13'.repeat(20)}`,
        evmCustody: { keystorePath: '/evm.json', expectedOwnerAddress: `0x${'14'.repeat(20)}`, accountIndex: 1 },
        publicBaseUrl: 'https://solver.example.test',
        publicListen: { host: '127.0.0.1', port: 18533 },
        sources: [{ role: 'requester', agent: 'did:web:requester', name: 'requester', baseUrl: 'https://requester.example.test' }],
        ipfs: { apiUrl: 'https://ipfs.example.test' },
        chainId: 84532,
        generation: 'today',
        contracts: BASE_SEPOLIA_TODAY,
        transactionCaps: {
          createTaskMaxWei: '1', claimMaxWei: '1', solutionSettlementMaxWei: '1',
          evaluationClaimMaxWei: '1', verdictSettlementMaxWei: '1', escrowMaxWei: '1',
        },
        stateDir: '/state', identityStores: { solver: '/identity' }, trustRootsPath: '/trust',
        trustPolicyGenesisDigest: `sha256:${'dd'.repeat(32)}`,
        runtime: { provider: 'first-party' },
        evaluator: {
          deploymentModule: '/evaluator.mjs', moduleDigest: `sha256:${'bb'.repeat(32)}`,
          signerHandle: 'verdict', evaluationMethodDigest: `sha256:${'cc'.repeat(32)}`,
        },
        finality: { confirmations: 12 }, liveClosureReceiptPath: '/missing-receipt.json',
      },
    },
  };
}

describe('native-only product entry', () => {
  it('starts only the injected native host for an explicit closure run', async () => {
    const host = {
      start: vi.fn(),
      health: vi.fn(async () => ({
        mode: 'native-v1' as const, role: 'solver' as const, roleKeyIds: { 'solver-delivery': 'did:key:zSolver' }, sourceLag: 0, sourceLagBySource: {},
        leaseOwned: true, venue: { canonicalBlock: '2', finalizedBlock: '1', caughtUp: true },
        backendReady: true, backendRequired: true, evidenceReady: true, evidenceRequired: true, publicSourceReady: true,
        uncertainOperations: 0, nativeFallbackCount: 0 as const,
      })),
      close: vi.fn(),
    };
    const buildHost = vi.fn(async () => host);
    const result = await main({
      loadConfig: vi.fn(() => nativeConfig()) as never,
      buildHost,
      installSignalHandlers: false,
    });
    expect(buildHost).toHaveBeenCalledOnce();
    expect(host.start).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      kind: 'native_daemon_started', mode: 'native-v1', readiness: 'explicit-native-unvalidated',
      health: { nativeFallbackCount: 0 },
    });
  });

  it('closes the host when post-start health is not decision-ready', async () => {
    const host = {
      start: vi.fn(),
      health: vi.fn(async () => ({
        mode: 'native-v1' as const, role: 'solver' as const, roleKeyIds: {}, sourceLag: 1, sourceLagBySource: {}, leaseOwned: true,
        venue: { canonicalBlock: '1', finalizedBlock: '1', caughtUp: true },
        backendReady: true, backendRequired: true, evidenceReady: true, evidenceRequired: true, publicSourceReady: true,
        uncertainOperations: 0, nativeFallbackCount: 0 as const,
      })),
      close: vi.fn(),
    };
    await expect(main({
      loadConfig: () => nativeConfig() as never,
      buildHost: async () => host,
      installSignalHandlers: false,
    })).rejects.toThrow(/health is not decision-ready/u);
    expect(host.close).toHaveBeenCalledOnce();
  });
});
