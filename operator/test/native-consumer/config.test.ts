import { describe, expect, it } from 'vitest';
import { NativeConsumerConfigError, parseNativeConsumerConfig } from '../../src/native-consumer/config.js';

function validConfig(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runId: 'public-golden-run',
    stateDir: '/tmp/jinn-native-consumer/state',
    rpcUrl: 'https://sepolia.base.org',
    trustRootsPath: '/tmp/jinn-native-consumer/trust-catalog.json',
    policyGenesisDigest: `sha256:${'a'.repeat(64)}`,
    chain: {
      chainId: 84532,
      generation: 'today',
      contracts: {
        taskCoordinator: `0x${'1'.repeat(40)}`,
        jinnRouter: `0x${'2'.repeat(40)}`,
        mechMarketplace: `0x${'3'.repeat(40)}`,
        activityChecker: `0x${'4'.repeat(40)}`,
      },
    },
    sources: {
      requester: { agent: 'https://agents.example/requester', name: 'requester', publicBaseUrl: 'https://requester.example' },
      solver: { agent: 'https://agents.example/solver', name: 'solver-records', publicBaseUrl: 'https://solver.example' },
      evaluator: { agent: 'https://agents.example/evaluator', name: 'evaluator-records', publicBaseUrl: 'https://evaluator.example' },
    },
    actors: {
      solverAgent: 'https://agents.example/solver',
      evaluatorAgent: 'https://agents.example/evaluator',
      executorDeclarationKey: `did:key:z${'A'.repeat(43)}`,
      evaluatorDeclarationKey: `did:key:z${'B'.repeat(43)}`,
    },
    packages: [
      { package: '@jinn-network/record-discovery-client', version: '0.1.0', tarballDigest: `sha256:${'f'.repeat(64)}` },
    ],
  };
}

describe('native consumer config', () => {
  it('accepts a well-formed config', () => {
    expect(() => parseNativeConsumerConfig(validConfig())).not.toThrow();
  });

  it('refuses an unrecognized top-level field (e.g. a producer path)', () => {
    const config = { ...validConfig(), producerStateDir: '/tmp/some-producer/state' };
    expect(() => parseNativeConsumerConfig(config)).toThrow(NativeConsumerConfigError);
  });

  it('refuses an unrecognized field nested under sources', () => {
    const config = validConfig();
    (config.sources as Record<string, unknown>).requester = {
      ...(config.sources as Record<string, Record<string, unknown>>).requester,
      identityStorePath: '/tmp/some-producer/identity',
    };
    expect(() => parseNativeConsumerConfig(config)).toThrow(NativeConsumerConfigError);
  });

  it('refuses an unrecognized field nested under actors', () => {
    const config = validConfig();
    (config.actors as Record<string, unknown>).keystorePath = '/tmp/some-producer/keystore.json';
    expect(() => parseNativeConsumerConfig(config)).toThrow(NativeConsumerConfigError);
  });

  it('refuses a non-https publicBaseUrl', () => {
    const config = validConfig();
    (config.sources as Record<string, Record<string, unknown>>).requester.publicBaseUrl = 'http://requester.example';
    expect(() => parseNativeConsumerConfig(config)).toThrow(NativeConsumerConfigError);
  });

  it('refuses a relative stateDir', () => {
    const config = { ...validConfig(), stateDir: 'relative/state' };
    expect(() => parseNativeConsumerConfig(config)).toThrow(NativeConsumerConfigError);
  });

  it('refuses an empty packages list', () => {
    const config = { ...validConfig(), packages: [] };
    expect(() => parseNativeConsumerConfig(config)).toThrow(NativeConsumerConfigError);
  });

  it('has no field named or shaped like a producer path anywhere in the schema', () => {
    const config = parseNativeConsumerConfig(validConfig());
    const serialized = JSON.stringify(config);
    expect(serialized).not.toMatch(/producer/iu);
  });
});
