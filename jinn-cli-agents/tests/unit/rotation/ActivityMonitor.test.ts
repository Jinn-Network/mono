import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeCheckInput } from './fixtures.js';

// Use vi.hoisted so the map is available inside the vi.mock factory
const { mockContractInstances } = vi.hoisted(() => {
  return {
    mockContractInstances: new Map<string, Record<string, any>>(),
  };
});

function setMockContract(address: string, methods: Record<string, any>) {
  mockContractInstances.set(address.toLowerCase(), methods);
}

vi.mock('ethers', () => {
  return {
    ethers: {
      Contract: vi.fn().mockImplementation((address: string) => {
        const methods = mockContractInstances.get(address.toLowerCase());
        if (!methods) {
          return {}; // Return empty object for unregistered addresses
        }
        return methods;
      }),
      JsonRpcProvider: vi.fn().mockImplementation(() => ({})),
    },
  };
});

// Mock logger to suppress output
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
const { ActivityMonitor } = await import('jinn-node/worker/rotation/ActivityMonitor.js');

const STAKING_ADDR = '0x' + '11'.repeat(20);
const ACTIVITY_CHECKER_ADDR = '0x' + '22'.repeat(20);

// Defaults matching Jinn staking contract
const DEFAULT_LIVENESS_PERIOD = 86400; // 24h
const DEFAULT_LIVENESS_RATIO = 10_000_000_000_000_000n; // 1e16
const DEFAULT_REWARDS_PER_SECOND = 1_000_000_000_000_000n; // 1e15

function setupContracts(opts: {
  livenessPeriod?: number;
  livenessRatio?: bigint;
  tsCheckpoint?: number;
  baselineActivityCount?: bigint;
  currentActivityCount?: bigint;
  rewardsPerSecond?: bigint;
} = {}) {
  const tsCheckpoint = opts.tsCheckpoint ?? Math.floor(Date.now() / 1000) - 3600;
  const baselineActivityCount = opts.baselineActivityCount ?? 0n;
  const currentActivityCount = opts.currentActivityCount ?? 0n;

  // Staking contract
  setMockContract(STAKING_ADDR, {
    livenessPeriod: vi.fn().mockResolvedValue(BigInt(opts.livenessPeriod ?? DEFAULT_LIVENESS_PERIOD)),
    activityChecker: vi.fn().mockResolvedValue(ACTIVITY_CHECKER_ADDR),
    rewardsPerSecond: vi.fn().mockResolvedValue(opts.rewardsPerSecond ?? DEFAULT_REWARDS_PER_SECOND),
    tsCheckpoint: vi.fn().mockResolvedValue(BigInt(tsCheckpoint)),
    getServiceInfo: vi.fn().mockResolvedValue({
      nonces: [0n, baselineActivityCount],
    }),
  });

  // Activity checker
  setMockContract(ACTIVITY_CHECKER_ADDR, {
    livenessRatio: vi.fn().mockResolvedValue(opts.livenessRatio ?? DEFAULT_LIVENESS_RATIO),
    getMultisigNonces: vi.fn().mockResolvedValue([0n, currentActivityCount]),
  });
}

describe('ActivityMonitor', () => {
  let monitor: InstanceType<typeof ActivityMonitor>;

  beforeEach(() => {
    mockContractInstances.clear();
    monitor = new ActivityMonitor('http://fake-rpc', 60_000);
  });

  describe('eligibility formula', () => {
    it('eligible when requests meet threshold', async () => {
      // With livenessPeriod=86400 and ratio=1e16:
      // requiredActivities = ceil(86400 * 1e16 / 1e18) + 1 = ceil(864) + 1 = 865
      setupContracts({
        baselineActivityCount: 0n,
        currentActivityCount: 865n,
      });

      const input = makeCheckInput({ stakingContract: STAKING_ADDR });
      const status = await monitor.checkService(input);

      expect(status.requiredActivities).toBe(865);
      expect(status.eligibleActivities).toBe(865);
      expect(status.isEligibleForRewards).toBe(true);
      expect(status.activitiesNeeded).toBe(0);
    });

    it('not eligible when one below threshold', async () => {
      setupContracts({
        baselineActivityCount: 0n,
        currentActivityCount: 864n,
      });

      const input = makeCheckInput({ stakingContract: STAKING_ADDR });
      const status = await monitor.checkService(input);

      expect(status.requiredActivities).toBe(865);
      expect(status.eligibleActivities).toBe(864);
      expect(status.isEligibleForRewards).toBe(false);
      expect(status.activitiesNeeded).toBe(1);
    });

    it('includes SAFETY_MARGIN of 1', async () => {
      // Without safety margin: ceil(86400 * 1e16 / 1e18) = 864
      // With safety margin: 864 + 1 = 865
      setupContracts({
        baselineActivityCount: 0n,
        currentActivityCount: 864n,
      });

      const input = makeCheckInput({ stakingContract: STAKING_ADDR });
      const status = await monitor.checkService(input);

      expect(status.isEligibleForRewards).toBe(false);
      expect(status.activitiesNeeded).toBe(1);
    });

    it('effectivePeriod uses livenessPeriod when > elapsed time', async () => {
      const now = Math.floor(Date.now() / 1000);
      setupContracts({
        livenessPeriod: 86400,
        tsCheckpoint: now - 100, // only 100s elapsed
        baselineActivityCount: 0n,
        currentActivityCount: 865n,
      });

      const input = makeCheckInput({ stakingContract: STAKING_ADDR });
      const status = await monitor.checkService(input);

      // effectivePeriod = max(86400, ~100) = 86400, so required = 865
      expect(status.requiredActivities).toBe(865);
    });

    it('effectivePeriod uses elapsed time when > livenessPeriod', async () => {
      const now = Math.floor(Date.now() / 1000);
      setupContracts({
        livenessPeriod: 86400,
        tsCheckpoint: now - 172800, // 2 days elapsed
        baselineActivityCount: 0n,
        currentActivityCount: 1729n,
      });

      const input = makeCheckInput({ stakingContract: STAKING_ADDR });
      const status = await monitor.checkService(input);

      // effectivePeriod = max(86400, ~172800) = 172800
      // requiredActivities = ceil(172800 * 1e16 / 1e18) + 1 = ceil(1728) + 1 = 1729
      expect(status.requiredActivities).toBe(1729);
      expect(status.isEligibleForRewards).toBe(true);
    });

    it('baseline offset is subtracted correctly', async () => {
      // baseline=50, current=915 → eligible = 915-50 = 865
      setupContracts({
        baselineActivityCount: 50n,
        currentActivityCount: 915n,
      });

      const input = makeCheckInput({ stakingContract: STAKING_ADDR });
      const status = await monitor.checkService(input);

      expect(status.eligibleActivities).toBe(865);
      expect(status.isEligibleForRewards).toBe(true);
    });
  });

  describe('error handling', () => {
    it('returns zeroed status with error on contract failure', async () => {
      setMockContract(STAKING_ADDR, {
        livenessPeriod: vi.fn().mockRejectedValue(new Error('RPC timeout')),
        activityChecker: vi.fn().mockRejectedValue(new Error('RPC timeout')),
        rewardsPerSecond: vi.fn().mockRejectedValue(new Error('RPC timeout')),
      });

      const input = makeCheckInput({ stakingContract: STAKING_ADDR });
      const status = await monitor.checkService(input);

      expect(status.error).toContain('RPC timeout');
      expect(status.activitiesNeeded).toBe(-1);
      expect(status.isEligibleForRewards).toBe(false);
    });
  });

  describe('caching', () => {
    it('caches contract-level data permanently', async () => {
      setupContracts({ currentActivityCount: 865n });

      const input = makeCheckInput({ stakingContract: STAKING_ADDR });
      await monitor.checkService(input);
      await monitor.checkService(input);

      // livenessPeriod is immutable — should only be called once
      const stakingMock = mockContractInstances.get(STAKING_ADDR.toLowerCase())!;
      expect(stakingMock.livenessPeriod).toHaveBeenCalledTimes(1);
    });

    it('caches checkpoint within TTL', async () => {
      setupContracts({ currentActivityCount: 865n });

      const input = makeCheckInput({ stakingContract: STAKING_ADDR });
      await monitor.checkService(input);
      await monitor.checkService(input);

      const stakingMock = mockContractInstances.get(STAKING_ADDR.toLowerCase())!;
      expect(stakingMock.tsCheckpoint).toHaveBeenCalledTimes(1);
    });

    it('clearCache resets all caches', async () => {
      setupContracts({ currentActivityCount: 865n });

      const input = makeCheckInput({ stakingContract: STAKING_ADDR });
      await monitor.checkService(input);

      monitor.clearCache();
      await monitor.checkService(input);

      const stakingMock = mockContractInstances.get(STAKING_ADDR.toLowerCase())!;
      expect(stakingMock.livenessPeriod).toHaveBeenCalledTimes(2);
    });
  });

  describe('checkAllServices', () => {
    it('returns empty array for empty input', async () => {
      const result = await monitor.checkAllServices([]);
      expect(result).toEqual([]);
    });

    it('checks multiple services sharing a staking contract', async () => {
      setupContracts({
        baselineActivityCount: 0n,
        currentActivityCount: 865n,
      });

      const inputs = [
        makeCheckInput({ serviceConfigId: 'sc-001', serviceId: 100, stakingContract: STAKING_ADDR }),
        makeCheckInput({ serviceConfigId: 'sc-002', serviceId: 200, stakingContract: STAKING_ADDR }),
      ];

      const results = await monitor.checkAllServices(inputs);

      expect(results).toHaveLength(2);
      // Contract-level data fetched only once (shared staking contract)
      const stakingMock = mockContractInstances.get(STAKING_ADDR.toLowerCase())!;
      expect(stakingMock.livenessPeriod).toHaveBeenCalledTimes(1);
    });
  });
});
