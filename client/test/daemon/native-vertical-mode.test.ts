import { BASE_SEPOLIA_TODAY } from '@jinn-network/marketplace-binding';
import { describe, expect, it } from 'vitest';

import { JinnConfigSchema } from '../../src/config.js';
import {
  NativeVerticalReadinessError,
  resolveOperatorVerticalMode,
} from '../../src/daemon/native-vertical-mode.js';

const VALIDATED = {
  status: 'validated' as const,
  chain: BASE_SEPOLIA_TODAY,
  solutionSettlementFinalized: true,
  verdictSettlementFinalized: true,
};

describe('operator vertical mode', () => {
  it('keeps legacy as the effective default until a live closure receipt is explicitly configured', () => {
    const config = JinnConfigSchema.parse({});
    expect(config.operator?.verticalMode).toBeUndefined();
    expect(resolveOperatorVerticalMode({
      requestedMode: config.operator?.verticalMode,
      network: config.network,
      chain: { ...BASE_SEPOLIA_TODAY, chainId: 8453 },
    })).toEqual({ requestedMode: 'legacy', effectiveMode: 'legacy', readiness: 'explicit-legacy' });
  });

  it('admits native-v1 only for the exact Base Sepolia today deployment and a validated live receipt', () => {
    expect(resolveOperatorVerticalMode({
      requestedMode: 'native-v1',
      network: 'testnet',
      chain: BASE_SEPOLIA_TODAY,
      liveClosure: VALIDATED,
    })).toEqual({ requestedMode: 'native-v1', effectiveMode: 'native-v1', readiness: 'live-closure-validated' });
  });

  it('reports live-closure-missing without silently downgrading requested native-v1', () => {
    expect(() => resolveOperatorVerticalMode({
      requestedMode: 'native-v1',
      network: 'testnet',
      chain: BASE_SEPOLIA_TODAY,
    })).toThrowError(expect.objectContaining<Partial<NativeVerticalReadinessError>>({
      reason: 'live-closure-missing',
    }));
  });

  it('refuses mainnet and every contract/generation mismatch before considering closure readiness', () => {
    for (const [chain, reason] of [
      [{ ...BASE_SEPOLIA_TODAY, chainId: 8453 }, 'mainnet-refused'],
      [{ ...BASE_SEPOLIA_TODAY, generation: 'revised' as const }, 'generation-mismatch'],
      [{ ...BASE_SEPOLIA_TODAY, taskCoordinator: `0x${'11'.repeat(20)}` as const }, 'contracts-mismatch'],
    ] as const) {
      expect(() => resolveOperatorVerticalMode({
        requestedMode: 'native-v1', network: 'testnet', chain, liveClosure: VALIDATED,
      })).toThrowError(expect.objectContaining({ reason }));
    }
  });

  it('parses the stable native host configuration without putting secret material in config', () => {
    const config = JinnConfigSchema.parse({
      operator: {
        verticalMode: 'native-v1',
        native: {
          role: 'solver',
          publicBaseUrl: 'https://solver.example.test',
          sources: [{ agent: 'did:web:requester.example.test', name: 'requester', baseUrl: 'https://requester.example.test' }],
          ipfs: { apiUrl: 'https://ipfs.example.test' },
          chainId: 84532,
          generation: 'today',
          contracts: BASE_SEPOLIA_TODAY,
          transactionCaps: {
            createTaskMaxWei: '1', claimMaxWei: '2', solutionSettlementMaxWei: '3',
            evaluationClaimMaxWei: '4', verdictSettlementMaxWei: '5', escrowMaxWei: '6',
          },
          stateDir: '/var/lib/jinn/native',
          identityStorePath: '/var/lib/jinn/identities',
          trustRootsPath: '/etc/jinn/trust-roots.json',
          evaluator: {
            deploymentModule: '/opt/jinn/prediction-evaluator.mjs',
            moduleDigest: `sha256:${'aa'.repeat(32)}`,
            signerHandle: 'verdict-v1',
            evaluationMethodDigest: `sha256:${'bb'.repeat(32)}`,
          },
          finality: { confirmations: 12 },
          liveClosureReceiptPath: '/etc/jinn/phase-b-live-closure.json',
        },
      },
    });
    expect(config.operator?.verticalMode).toBe('native-v1');
    expect(config.operator?.native?.contracts.taskCoordinator).toBe(BASE_SEPOLIA_TODAY.taskCoordinator);
    expect(JSON.stringify(config.operator?.native)).not.toMatch(/privateKey|password|token/u);
  });
});
