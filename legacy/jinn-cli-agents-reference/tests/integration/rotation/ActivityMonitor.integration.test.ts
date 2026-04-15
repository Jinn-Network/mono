/**
 * Integration test: validates that the ActivityMonitor ABI and eligibility
 * formula work against real Base mainnet staking contracts.
 *
 * All calls are read-only (gas-free view calls). No write transactions.
 * Requires BASE_RPC_URL environment variable.
 *
 * Uses a single beforeAll to fetch all data (minimizes RPC calls for
 * rate-limited public endpoints).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { ethers } from 'ethers';

const BASE_RPC_URL = process.env.BASE_RPC_URL;
const JINN_STAKING = '0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139';

const STAKING_ABI = [
  'function livenessPeriod() view returns (uint256)',
  'function tsCheckpoint() view returns (uint256)',
  'function activityChecker() view returns (address)',
  'function getServiceIds() view returns (uint256[])',
  'function getServiceInfo(uint256) view returns (tuple(address multisig, address owner, uint256[] nonces, uint256 tsStart, uint256 reward, uint256 inactivity))',
];

const ACTIVITY_CHECKER_ABI = [
  'function livenessRatio() view returns (uint256)',
  'function getMultisigNonces(address) view returns (uint256[])',
];

describe.skipIf(!BASE_RPC_URL)('ActivityMonitor ABI against Base mainnet (read-only)', () => {
  // Fetch all data once in beforeAll to minimize RPC calls
  let data: {
    livenessPeriod: number;
    checkerAddr: string;
    livenessRatio: bigint;
    tsCheckpoint: number;
    serviceId: bigint;
    multisig: string;
    baselineNonces: bigint[];
    currentNonces: bigint[];
  };

  beforeAll(async () => {
    const provider = new ethers.JsonRpcProvider(BASE_RPC_URL!);
    const staking = new ethers.Contract(JINN_STAKING, STAKING_ABI, provider);

    // Public RPCs like mainnet.base.org have aggressive rate limits (~5 req/s).
    // Use a private RPC (Alchemy, Infura) for reliable results.
    const delay = () => new Promise(r => setTimeout(r, 500));

    // Sequential calls with delays to avoid public RPC rate limits
    const livenessPeriod = Number(await staking.livenessPeriod());
    await delay();
    const checkerAddr: string = await staking.activityChecker();
    await delay();
    const tsCheckpoint = Number(await staking.tsCheckpoint());
    await delay();
    const serviceIds: bigint[] = await staking.getServiceIds();
    await delay();

    if (serviceIds.length === 0) throw new Error('No staked services found');

    const serviceId = serviceIds[0];
    const info = await staking.getServiceInfo(serviceId);
    await delay();

    const checker = new ethers.Contract(checkerAddr, ACTIVITY_CHECKER_ABI, provider);
    const livenessRatio: bigint = await checker.livenessRatio();
    await delay();
    const currentNonces: bigint[] = await checker.getMultisigNonces(info.multisig);

    data = {
      livenessPeriod,
      checkerAddr,
      livenessRatio,
      tsCheckpoint,
      serviceId,
      multisig: info.multisig,
      baselineNonces: info.nonces.map((n: bigint) => BigInt(n)),
      currentNonces: currentNonces.map((n: bigint) => BigInt(n)),
    };
  }, 60_000);

  it('staking contract returns valid immutable data', () => {
    expect(data.livenessPeriod).toBeGreaterThan(0);
    expect(data.checkerAddr).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(data.livenessRatio).toBeGreaterThan(0n);
  });

  it('staked service has valid on-chain data', () => {
    expect(data.multisig).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(data.baselineNonces.length).toBeGreaterThanOrEqual(2);
    expect(data.currentNonces.length).toBe(2);
    expect(data.tsCheckpoint).toBeGreaterThan(0);
  });

  it('eligibility formula produces sensible results with real data', () => {
    const now = Math.floor(Date.now() / 1000);
    const SAFETY_MARGIN = 1;

    const effectivePeriod = Math.max(data.livenessPeriod, now - data.tsCheckpoint);
    const requiredActivities = Math.ceil(
      effectivePeriod * Number(data.livenessRatio) / 1e18
    ) + SAFETY_MARGIN;
    const baselineActivityCount = data.baselineNonces[1] ?? 0n;
    const currentActivityCount = data.currentNonces[1] ?? 0n;
    const eligibleActivities = Number(currentActivityCount - baselineActivityCount);
    const activitiesNeeded = Math.max(0, requiredActivities - eligibleActivities);
    const isEligible = eligibleActivities >= requiredActivities;

    expect(requiredActivities).toBeGreaterThan(0);
    expect(eligibleActivities).toBeGreaterThanOrEqual(0);
    expect(activitiesNeeded).toBeGreaterThanOrEqual(0);
    expect(typeof isEligible).toBe('boolean');

    // Log for visibility when debugging
    console.log(`Service #${data.serviceId}: eligible=${isEligible}, ` +
      `requests=${eligibleActivities}/${requiredActivities}, needed=${activitiesNeeded}`);
  });
});
