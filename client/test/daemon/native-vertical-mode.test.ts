import { BASE_SEPOLIA_TODAY } from '@jinn-network/marketplace-binding';
import { describe, expect, it } from 'vitest';

import { JinnConfigSchema } from '../../src/config.js';
import {
  NativeVerticalReadinessError,
  resolveOperatorVerticalMode,
} from '../../src/daemon/native-vertical-mode.js';
import {
  buildPhaseBClosureManifest,
  parseValidatedPhaseBClosureManifest,
} from '../../src/daemon/phase-b-closure-manifest.js';
import { phaseBClosureFixture } from '../_support/phase-b-closure-fixture.js';

const VALIDATED = parseValidatedPhaseBClosureManifest(
  buildPhaseBClosureManifest(phaseBClosureFixture()),
);

describe('operator vertical mode', () => {
  it('keeps legacy as the effective default and reports missing closure readiness', () => {
    const config = JinnConfigSchema.parse({});
    expect(config.operator?.verticalMode).toBeUndefined();
    expect(resolveOperatorVerticalMode({
      requestedMode: config.operator?.verticalMode,
      network: config.network,
      chain: { ...BASE_SEPOLIA_TODAY, chainId: 8453 },
    })).toEqual({ requestedMode: undefined, effectiveMode: 'legacy', readiness: 'live-closure-missing' });
  });

  it('admits explicit native-v1 for a closure run without treating a local receipt as release authority', () => {
    expect(resolveOperatorVerticalMode({
      requestedMode: 'native-v1',
      network: 'testnet',
      chain: BASE_SEPOLIA_TODAY,
      liveClosure: VALIDATED,
    })).toEqual({ requestedMode: 'native-v1', effectiveMode: 'native-v1', readiness: 'explicit-native-unvalidated' });
  });

  it('allows an explicit native-v1 closure run without pretending closure is already validated', () => {
    expect(resolveOperatorVerticalMode({
      requestedMode: 'native-v1',
      network: 'testnet',
      chain: BASE_SEPOLIA_TODAY,
    })).toEqual({
      requestedMode: 'native-v1',
      effectiveMode: 'native-v1',
      readiness: 'explicit-native-unvalidated',
    });
  });

  it('does not let a self-declared local receipt flip the production default', () => {
    expect(resolveOperatorVerticalMode({
      network: 'testnet',
      chain: BASE_SEPOLIA_TODAY,
      liveClosure: VALIDATED,
    })).toEqual({ requestedMode: undefined, effectiveMode: 'legacy', readiness: 'live-closure-missing' });
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
          agent: 'urn:jinn:agent:solver',
          safeAddress: `0x${'12'.repeat(20)}`,
          marketplaceAgentAddress: `0x${'13'.repeat(20)}`,
          evmCustody: {
            keystorePath: '/var/lib/jinn/evm-keystore.json',
            expectedOwnerAddress: `0x${'14'.repeat(20)}`,
            accountIndex: 1,
          },
          publicBaseUrl: 'https://solver.example.test',
          publicListen: { host: '127.0.0.1', port: 18533 },
          sources: [{ role: 'requester', agent: 'did:web:requester.example.test', name: 'requester', baseUrl: 'https://requester.example.test' }],
          ipfs: { apiUrl: 'https://ipfs.example.test' },
          chainId: 84532,
          generation: 'today',
          contracts: {
            taskCoordinator: BASE_SEPOLIA_TODAY.taskCoordinator,
            jinnRouter: BASE_SEPOLIA_TODAY.jinnRouter,
            mechMarketplace: BASE_SEPOLIA_TODAY.mechMarketplace,
            activityChecker: BASE_SEPOLIA_TODAY.activityChecker,
          },
          transactionCaps: {
            createTaskMaxWei: '1', claimMaxWei: '2', solutionSettlementMaxWei: '3',
            evaluationClaimMaxWei: '4', verdictSettlementMaxWei: '5', escrowMaxWei: '6',
          },
          stateDir: '/var/lib/jinn/native',
          identityStores: { solver: '/var/lib/jinn/identities' },
          trustRootsPath: '/etc/jinn/trust-roots.json',
          trustPolicyGenesisDigest: `sha256:${'dd'.repeat(32)}`,
          runtime: { provider: 'first-party', nodeExecutableDigest: `sha256:${'ab'.repeat(32)}` },
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
