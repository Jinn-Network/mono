import { describe, it, expect, beforeEach } from 'vitest';
import {
  setActiveService,
  getActiveService,
  clearActiveService,
  getActiveMechAddress,
  getActiveSafeAddress,
  getActivePrivateKey,
  getActiveChainConfig,
  type ActiveServiceIdentity,
} from 'jinn-node/worker/rotation/ActiveServiceContext.js';

const identity: ActiveServiceIdentity = {
  mechAddress: '0xMECH',
  safeAddress: '0xSAFE',
  privateKey: '0xKEY',
  chainConfig: 'base',
  serviceId: 42,
  serviceConfigId: 'sc-042',
  stakingContract: '0xSTAKE',
};

describe('ActiveServiceContext', () => {
  beforeEach(() => {
    clearActiveService();
  });

  it('returns null when no active service set', () => {
    expect(getActiveService()).toBeNull();
  });

  it('set/get round-trip', () => {
    setActiveService(identity);
    expect(getActiveService()).toEqual(identity);
  });

  it('clear resets to null', () => {
    setActiveService(identity);
    clearActiveService();
    expect(getActiveService()).toBeNull();
  });

  it('getActiveMechAddress returns mechAddress when set', () => {
    setActiveService(identity);
    expect(getActiveMechAddress()).toBe('0xMECH');
  });

  it('getActiveSafeAddress returns safeAddress when set', () => {
    setActiveService(identity);
    expect(getActiveSafeAddress()).toBe('0xSAFE');
  });

  it('getActivePrivateKey returns privateKey when set', () => {
    setActiveService(identity);
    expect(getActivePrivateKey()).toBe('0xKEY');
  });

  it('getActiveChainConfig returns chainConfig when set', () => {
    setActiveService(identity);
    expect(getActiveChainConfig()).toBe('base');
  });

  it('typed getters return null when no active service', () => {
    expect(getActiveMechAddress()).toBeNull();
    expect(getActiveSafeAddress()).toBeNull();
    expect(getActivePrivateKey()).toBeNull();
    expect(getActiveChainConfig()).toBeNull();
  });
});
