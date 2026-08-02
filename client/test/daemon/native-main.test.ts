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
        publicBaseUrl: 'https://solver.example.test',
        sources: [{ agent: 'did:web:requester', name: 'requester', baseUrl: 'https://requester.example.test' }],
        ipfs: { apiUrl: 'https://ipfs.example.test' },
        chainId: 84532,
        generation: 'today',
        contracts: BASE_SEPOLIA_TODAY,
        transactionCaps: {
          createTaskMaxWei: '1', claimMaxWei: '1', solutionSettlementMaxWei: '1',
          evaluationClaimMaxWei: '1', verdictSettlementMaxWei: '1', escrowMaxWei: '1',
        },
        stateDir: '/state', identityStorePath: '/identity', trustRootsPath: '/trust',
        runtime: { deploymentModule: '/runtime.mjs', moduleDigest: `sha256:${'aa'.repeat(32)}` },
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
    const host = { start: vi.fn(), health: vi.fn(async () => ({ nativeFallbackCount: 0 })), close: vi.fn() };
    const createNativeOperatorHost = vi.fn(async () => host);
    const result = await main({
      loadConfig: vi.fn(() => nativeConfig()) as never,
      loadDeployment: vi.fn(async () => ({ createNativeOperatorHost })),
      installSignalHandlers: false,
    });
    expect(createNativeOperatorHost).toHaveBeenCalledOnce();
    expect(host.start).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      kind: 'native_daemon_started', mode: 'native-v1', readiness: 'explicit-native-unvalidated',
      health: { nativeFallbackCount: 0 },
    });
  });
});
