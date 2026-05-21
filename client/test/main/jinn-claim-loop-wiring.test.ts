import { describe, expect, it } from 'vitest';
import {
  buildJinnClaimLoopConfig,
  shouldWireJinnClaimL1Signer,
} from '../../src/daemon/jinn-claim-loop-wiring.js';

const CLAIM_EMITTER = '0x1111111111111111111111111111111111111111' as const;
const DISTRIBUTOR = '0x2222222222222222222222222222222222222222' as const;
const MESSENGER = '0x3333333333333333333333333333333333333333' as const;

function baseArgs(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    intervalMs: 60_000,
    submissionMode: 'emit-only' as const,
    messengerMode: 'mock' as const,
    mvi: {
      claimEmitter: CLAIM_EMITTER,
      distributor: DISTRIBUTOR,
      messenger: MESSENGER,
    },
    l2Client: {} as any,
    l2Wallet: {} as any,
    store: {} as any,
    chain: 'base-sepolia' as const,
    ...overrides,
  };
}

describe('jinn claim loop wiring', () => {
  it('does not request L1 signer wiring for emit-only mode', () => {
    expect(shouldWireJinnClaimL1Signer({
      enabled: true,
      intervalMs: 60_000,
      submissionMode: 'emit-only',
      distributorAddress: DISTRIBUTOR,
      ethereumRpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
    })).toBe(false);
  });

  it('builds emit-only config without L1 clients, distributor, or messenger', () => {
    const cfg = buildJinnClaimLoopConfig(baseArgs({
      mvi: { claimEmitter: CLAIM_EMITTER },
    }));

    expect(cfg).toBeDefined();
    expect(cfg?.submissionMode).toBe('emit-only');
    expect(cfg?.claimEmitterAddress).toBe(CLAIM_EMITTER);
    expect(cfg?.l1Client).toBeUndefined();
    expect(cfg?.l1Wallet).toBeUndefined();
    expect(cfg?.distributorAddress).toBeUndefined();
    expect(cfg?.messengerAddress).toBeUndefined();
  });

  it('requires L1 signer wiring for submit mode', () => {
    expect(shouldWireJinnClaimL1Signer({
      enabled: true,
      intervalMs: 60_000,
      submissionMode: 'submit',
      distributorAddress: DISTRIBUTOR,
      ethereumRpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
    })).toBe(true);

    expect(buildJinnClaimLoopConfig(baseArgs({
      submissionMode: 'submit',
      l1Clients: undefined,
    }))).toBeUndefined();

    const l1Clients = { public: {} as any, wallet: {} as any };
    const cfg = buildJinnClaimLoopConfig(baseArgs({
      submissionMode: 'submit',
      l1Clients,
    }));

    expect(cfg).toBeDefined();
    expect(cfg?.l1Client).toBe(l1Clients.public);
    expect(cfg?.l1Wallet).toBe(l1Clients.wallet);
    expect(cfg?.distributorAddress).toBe(DISTRIBUTOR);
    expect(cfg?.messengerAddress).toBe(MESSENGER);
  });

  it('does not build config unless the explicit enable gate is true', () => {
    expect(buildJinnClaimLoopConfig(baseArgs({ enabled: false }))).toBeUndefined();
  });
});
