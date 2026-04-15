import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeServiceInfo, makeActivityStatus } from './fixtures.js';
import type { ServiceActivityStatus } from 'jinn-node/worker/rotation/ActivityMonitor.js';

// Mock ActivityMonitor
const mockCheckAllServices = vi.fn<() => Promise<ServiceActivityStatus[]>>();

vi.mock('jinn-node/worker/rotation/ActivityMonitor.js', () => ({
  ActivityMonitor: vi.fn().mockImplementation(() => ({
    checkAllServices: mockCheckAllServices,
    clearCache: vi.fn(),
  })),
}));

// Mock ServiceConfigReader
const mockListServiceConfigs = vi.fn();

vi.mock('jinn-node/worker/ServiceConfigReader.js', () => ({
  listServiceConfigs: (...args: any[]) => mockListServiceConfigs(...args),
}));

// Mock operate-profile
vi.mock('jinn-node/env/operate-profile.js', () => ({
  getServicePrivateKey: vi.fn().mockReturnValue('0x' + 'ab'.repeat(32)),
}));

// Mock logger
vi.mock('jinn-node/logging/index.js', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

// Import AFTER mocks
const { ServiceRotator } = await import('jinn-node/worker/rotation/ServiceRotator.js');

const serviceA = makeServiceInfo({ serviceConfigId: 'sc-001', serviceId: 100 });
const serviceB = makeServiceInfo({
  serviceConfigId: 'sc-002',
  serviceId: 200,
  serviceSafeAddress: '0x' + 'ff'.repeat(20),
  mechContractAddress: '0x' + '33'.repeat(20),
});

function makeRotator(pollMs = 0) {
  return new ServiceRotator({
    rpcUrl: 'http://fake-rpc',
    middlewarePath: '/fake/middleware',
    activityPollMs: pollMs,
    activityCacheTtlMs: 0,
  });
}

describe('ServiceRotator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListServiceConfigs.mockResolvedValue([serviceA, serviceB]);
  });

  describe('initialize', () => {
    it('filters out incomplete services', async () => {
      const incomplete = makeServiceInfo({
        serviceConfigId: 'sc-bad',
        serviceSafeAddress: undefined,
      });
      mockListServiceConfigs.mockResolvedValue([serviceA, incomplete, serviceB]);
      mockCheckAllServices.mockResolvedValue([
        makeActivityStatus({ serviceConfigId: 'sc-001', activitiesNeeded: 5, isEligibleForRewards: false }),
        makeActivityStatus({ serviceConfigId: 'sc-002', activitiesNeeded: 3, isEligibleForRewards: false }),
      ]);

      const rotator = makeRotator();
      const decision = await rotator.initialize();

      // Should pick from valid services only (sc-001 and sc-002)
      expect(rotator.getState().totalServices).toBe(2);
      expect(decision.service.serviceConfigId).toBe('sc-001'); // most activitiesNeeded
    });

    it('throws when no services found', async () => {
      mockListServiceConfigs.mockResolvedValue([]);

      const rotator = makeRotator();
      await expect(rotator.initialize()).rejects.toThrow('No services found');
    });

    it('falls back to first service when none are staked', async () => {
      const unstaked = makeServiceInfo({
        serviceConfigId: 'sc-unstaked',
        stakingContractAddress: undefined,
      });
      mockListServiceConfigs.mockResolvedValue([unstaked]);

      const rotator = makeRotator();
      const decision = await rotator.initialize();

      expect(decision.service.serviceConfigId).toBe('sc-unstaked');
      expect(decision.switched).toBe(false);
      expect(decision.reason).toContain('no staked services');
    });
  });

  describe('reevaluate', () => {
    it('picks service needing the most work', async () => {
      mockCheckAllServices.mockResolvedValue([
        makeActivityStatus({ serviceConfigId: 'sc-001', serviceId: 100, activitiesNeeded: 3, isEligibleForRewards: false }),
        makeActivityStatus({ serviceConfigId: 'sc-002', serviceId: 200, activitiesNeeded: 10, isEligibleForRewards: false }),
      ]);

      const rotator = makeRotator();
      const decision = await rotator.initialize();

      expect(decision.service.serviceConfigId).toBe('sc-002');
      expect(decision.switched).toBe(true);
      expect(decision.reason).toContain('needs 10');
    });

    it('stays on current when all services are eligible', async () => {
      // First call: sc-002 needs work → switch to it
      mockCheckAllServices.mockResolvedValueOnce([
        makeActivityStatus({ serviceConfigId: 'sc-001', activitiesNeeded: 0, isEligibleForRewards: true }),
        makeActivityStatus({ serviceConfigId: 'sc-002', serviceId: 200, activitiesNeeded: 5, isEligibleForRewards: false }),
      ]);

      const rotator = makeRotator();
      await rotator.initialize();

      // Now all eligible → should stay on sc-002
      mockCheckAllServices.mockResolvedValueOnce([
        makeActivityStatus({ serviceConfigId: 'sc-001', activitiesNeeded: 0, isEligibleForRewards: true }),
        makeActivityStatus({ serviceConfigId: 'sc-002', activitiesNeeded: 0, isEligibleForRewards: true }),
      ]);

      const decision = await rotator.reevaluate();

      expect(decision.switched).toBe(false);
      expect(decision.service.serviceConfigId).toBe('sc-002');
      expect(decision.reason).toContain('all services eligible');
    });

    it('filters out errored services', async () => {
      mockCheckAllServices.mockResolvedValue([
        makeActivityStatus({ serviceConfigId: 'sc-001', serviceId: 100, activitiesNeeded: 10, isEligibleForRewards: false, error: 'RPC timeout' }),
        makeActivityStatus({ serviceConfigId: 'sc-002', serviceId: 200, activitiesNeeded: 5, isEligibleForRewards: false }),
      ]);

      const rotator = makeRotator();
      const decision = await rotator.initialize();

      // sc-001 has error, so picks sc-002
      expect(decision.service.serviceConfigId).toBe('sc-002');
    });

    it('stays on current when only errors and eligible remain', async () => {
      // First call: sc-002 needs work
      mockCheckAllServices.mockResolvedValueOnce([
        makeActivityStatus({ serviceConfigId: 'sc-001', activitiesNeeded: 0, isEligibleForRewards: true }),
        makeActivityStatus({ serviceConfigId: 'sc-002', serviceId: 200, activitiesNeeded: 5, isEligibleForRewards: false }),
      ]);

      const rotator = makeRotator();
      await rotator.initialize();

      // Now: sc-001 has error, sc-002 is eligible → needsWork is empty → stay on current
      mockCheckAllServices.mockResolvedValueOnce([
        makeActivityStatus({ serviceConfigId: 'sc-001', activitiesNeeded: 0, isEligibleForRewards: false, error: 'timeout' }),
        makeActivityStatus({ serviceConfigId: 'sc-002', activitiesNeeded: 0, isEligibleForRewards: true }),
      ]);

      const decision = await rotator.reevaluate();
      expect(decision.switched).toBe(false);
      expect(decision.service.serviceConfigId).toBe('sc-002');
    });

    it('initial selection counts as switched', async () => {
      mockCheckAllServices.mockResolvedValue([
        makeActivityStatus({ serviceConfigId: 'sc-001', serviceId: 100, activitiesNeeded: 5, isEligibleForRewards: false }),
      ]);

      const rotator = makeRotator();
      const decision = await rotator.initialize();

      // currentServiceConfigId was null → any selection is a switch
      expect(decision.switched).toBe(true);
    });

    it('increments rotation counter only on switch', async () => {
      mockCheckAllServices.mockResolvedValueOnce([
        makeActivityStatus({ serviceConfigId: 'sc-001', serviceId: 100, activitiesNeeded: 5, isEligibleForRewards: false }),
        makeActivityStatus({ serviceConfigId: 'sc-002', serviceId: 200, activitiesNeeded: 3, isEligibleForRewards: false }),
      ]);

      const rotator = makeRotator();
      await rotator.initialize(); // switch to sc-001 (most needed)
      expect(rotator.getState().rotationCount).toBe(1);

      // Stay on same → no increment
      mockCheckAllServices.mockResolvedValueOnce([
        makeActivityStatus({ serviceConfigId: 'sc-001', serviceId: 100, activitiesNeeded: 5, isEligibleForRewards: false }),
        makeActivityStatus({ serviceConfigId: 'sc-002', serviceId: 200, activitiesNeeded: 3, isEligibleForRewards: false }),
      ]);
      await rotator.reevaluate();
      expect(rotator.getState().rotationCount).toBe(1);

      // Switch to sc-002 → increment
      mockCheckAllServices.mockResolvedValueOnce([
        makeActivityStatus({ serviceConfigId: 'sc-001', serviceId: 100, activitiesNeeded: 0, isEligibleForRewards: true }),
        makeActivityStatus({ serviceConfigId: 'sc-002', serviceId: 200, activitiesNeeded: 5, isEligibleForRewards: false }),
      ]);
      await rotator.reevaluate();
      expect(rotator.getState().rotationCount).toBe(2);
      expect(rotator.getState().currentServiceConfigId).toBe('sc-002');
    });
  });

  describe('rate limiting', () => {
    it('skips activity check within poll interval', async () => {
      mockCheckAllServices.mockResolvedValue([
        makeActivityStatus({ serviceConfigId: 'sc-001', serviceId: 100, activitiesNeeded: 5, isEligibleForRewards: false }),
      ]);

      const rotator = makeRotator(60_000); // 60s interval
      await rotator.initialize();

      // Second call immediately — should be rate-limited
      const decision = await rotator.reevaluate();
      expect(decision.switched).toBe(false);
      expect(decision.reason).toBe('poll interval not reached');

      // checkAllServices called only once (during initialize)
      expect(mockCheckAllServices).toHaveBeenCalledTimes(1);
    });
  });

  describe('buildIdentity', () => {
    it('maps ServiceInfo fields correctly', () => {
      const rotator = makeRotator();
      const identity = rotator.buildIdentity(serviceA);

      expect(identity.mechAddress).toBe(serviceA.mechContractAddress);
      expect(identity.safeAddress).toBe(serviceA.serviceSafeAddress);
      expect(identity.privateKey).toBe(serviceA.agentPrivateKey);
      expect(identity.chainConfig).toBe(serviceA.chain);
      expect(identity.serviceId).toBe(serviceA.serviceId);
      expect(identity.serviceConfigId).toBe(serviceA.serviceConfigId);
      expect(identity.stakingContract).toBe(serviceA.stakingContractAddress);
    });

    it('throws on missing required fields', () => {
      const rotator = makeRotator();
      const noMech = makeServiceInfo({ mechContractAddress: undefined });

      expect(() => rotator.buildIdentity(noMech)).toThrow('missing required identity fields');
    });
  });

  describe('getAllMechAddresses', () => {
    it('returns lowercased mech addresses', async () => {
      const svcUpper = makeServiceInfo({
        serviceConfigId: 'sc-upper',
        mechContractAddress: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
        stakingContractAddress: undefined,
      });
      mockListServiceConfigs.mockResolvedValue([svcUpper, serviceB]);
      mockCheckAllServices.mockResolvedValue([]);

      const rotator = makeRotator();
      // Need to initialize to populate services list
      // serviceB is staked but svcUpper is not — falls back if no staked
      // Actually both have staking, let's just call initialize
      // We need to set the services. initialize() calls listServiceConfigs.
      // svcUpper has no staking but does have a mech address.
      // serviceB has staking.
      mockCheckAllServices.mockResolvedValue([
        makeActivityStatus({ serviceConfigId: 'sc-002', serviceId: 200, activitiesNeeded: 5, isEligibleForRewards: false }),
      ]);
      await rotator.initialize();

      const addresses = rotator.getAllMechAddresses();
      expect(addresses).toContain('0xabcdef1234567890abcdef1234567890abcdef12');
      expect(addresses).toContain(serviceB.mechContractAddress!.toLowerCase());
    });

    it('filters services without mech addresses', async () => {
      const noMech = makeServiceInfo({
        serviceConfigId: 'sc-nomech',
        mechContractAddress: undefined,
      });
      mockListServiceConfigs.mockResolvedValue([serviceA, noMech]);
      mockCheckAllServices.mockResolvedValue([
        makeActivityStatus({ serviceConfigId: 'sc-001', serviceId: 100, activitiesNeeded: 5, isEligibleForRewards: false }),
      ]);

      const rotator = makeRotator();
      await rotator.initialize();

      const addresses = rotator.getAllMechAddresses();
      // noMech is filtered out (no safe address either, but getAllMechAddresses only checks mech)
      // Actually noMech has a safe address from makeServiceInfo defaults. But it has no mech.
      expect(addresses).toHaveLength(1);
      expect(addresses[0]).toBe(serviceA.mechContractAddress!.toLowerCase());
    });
  });

  describe('getState', () => {
    it('returns observability state', async () => {
      mockCheckAllServices.mockResolvedValue([
        makeActivityStatus({ serviceConfigId: 'sc-001', serviceId: 100, activitiesNeeded: 5, isEligibleForRewards: false }),
        makeActivityStatus({ serviceConfigId: 'sc-002', serviceId: 200, activitiesNeeded: 3, isEligibleForRewards: false }),
      ]);

      const rotator = makeRotator();
      await rotator.initialize();

      const state = rotator.getState();
      expect(state.totalServices).toBe(2);
      expect(state.stakedServices).toBe(2);
      expect(state.rotationCount).toBe(1); // initial selection
      expect(state.currentServiceConfigId).toBe('sc-001');
      expect(state.lastPollAt).toBeGreaterThan(0);
    });
  });
});
