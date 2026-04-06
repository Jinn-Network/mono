import type { ServiceInfo } from 'jinn-node/worker/ServiceConfigReader.js';
import type { ServiceActivityStatus, ServiceCheckInput } from 'jinn-node/worker/rotation/ActivityMonitor.js';

export function makeServiceInfo(overrides: Partial<ServiceInfo> = {}): ServiceInfo {
  return {
    serviceConfigId: 'sc-001',
    serviceName: 'test-service',
    serviceSafeAddress: '0x' + 'aa'.repeat(20),
    agentEoaAddress: '0x' + 'bb'.repeat(20),
    mechContractAddress: '0x' + 'cc'.repeat(20),
    chain: 'base',
    serviceId: 100,
    stakingContractAddress: '0x' + 'dd'.repeat(20),
    agentPrivateKey: '0x' + 'ee'.repeat(32),
    ...overrides,
  };
}

export function makeActivityStatus(overrides: Partial<ServiceActivityStatus> = {}): ServiceActivityStatus {
  return {
    serviceConfigId: 'sc-001',
    serviceId: 100,
    multisig: '0x' + 'aa'.repeat(20),
    stakingContract: '0x' + 'dd'.repeat(20),
    livenessPeriod: 86400,
    tsCheckpoint: Math.floor(Date.now() / 1000) - 3600,
    livenessRatio: 10_000_000_000_000_000n,
    currentActivityCount: 100n,
    baselineActivityCount: 90n,
    requiredActivities: 2,
    eligibleActivities: 10,
    isEligibleForRewards: true,
    activitiesNeeded: 0,
    fetchedAt: Date.now(),
    ...overrides,
  };
}

export function makeCheckInput(overrides: Partial<ServiceCheckInput> = {}): ServiceCheckInput {
  return {
    serviceConfigId: 'sc-001',
    serviceId: 100,
    multisig: '0x' + 'aa'.repeat(20),
    stakingContract: '0x' + 'dd'.repeat(20),
    ...overrides,
  };
}
