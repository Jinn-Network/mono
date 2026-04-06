import MechMarketplaceAbi from './abis/MechMarketplace.json';
import AgentMechAbi from '@jinn-network/mech-client-ts/dist/abis/AgentMech.json';
import StakingTokenAbi from './abis/StakingToken.json';
import { createConfig, factory } from "ponder";
import { http } from "viem";
import fetch from 'cross-fetch';
// Force rebuild to include venture type fixes and staking schema

// Suppress config logs when running under non-default runtime environments
const runtimeMode = process.env.RUNTIME_ENVIRONMENT || 'default';
const suppressLogs = runtimeMode !== 'default';

// Contract deployment blocks (verified on-chain via eth_getCode binary search):
// - MechMarketplace: deployed between blocks 26,600,000-26,650,000
// - Jinn Staking V1: deployed between blocks 40,710,000-40,720,000
// - Jinn Staking V2: deployed between blocks 42,550,000-42,600,000
//
// Each contract scans from its actual deployment block to avoid wasting RPC calls
// on millions of empty blocks. The child start block (for high-volume Deliver events)
// uses a separate, more recent window.
//
// For test environments (Tenderly VNets), use block 0 to scan the entire fork history
// since VNets don't contain mainnet blocks before the fork point.

// Known deployment blocks for each contract (with small safety margin)
const CONTRACT_DEPLOY_BLOCKS = {
  MechMarketplace: 26_600_000,    // ~mid-2024, marketplace contract
  JinnStaking: 40_709_999,    // ~Jan 2026, 5000 OLAS min staking (v1)
  JinnStakingV2: 42_550_000,    // ~Feb 2026, 5000 OLAS min staking (v2)
} as const;

// Factory start block: use env var override (for tests) or earliest contract deployment
function getFactoryStartBlock(): number {
  if (process.env.PONDER_FACTORY_START_BLOCK) {
    return Number(process.env.PONDER_FACTORY_START_BLOCK);
  }
  return CONTRACT_DEPLOY_BLOCKS.MechMarketplace;
}

const FACTORY_START_BLOCK = getFactoryStartBlock();
const CHILD_START_BLOCK_DEFAULT = 38187727; // 2025-11-15T00:00:00Z

// Get child start block: use env var if set, otherwise use default recent window
function getChildStartBlock(): number {
  if (process.env.PONDER_START_BLOCK) {
    return Number(process.env.PONDER_START_BLOCK);
  }
  return CHILD_START_BLOCK_DEFAULT;
}

// Get per-contract start block, respecting test mode (FACTORY_START_BLOCK=0)
function getStakingStartBlock(contract: keyof typeof CONTRACT_DEPLOY_BLOCKS): number {
  // Allow explicit override (useful for local Anvil forks to skip full history scan)
  if (process.env.PONDER_STAKING_START_BLOCK) {
    return Number(process.env.PONDER_STAKING_START_BLOCK);
  }
  if (FACTORY_START_BLOCK === 0) return 0; // test mode: scan everything
  return CONTRACT_DEPLOY_BLOCKS[contract];
}

// Review mode configuration
const endBlock = process.env.PONDER_END_BLOCK ? Number(process.env.PONDER_END_BLOCK) : undefined;

if (runtimeMode === 'review') {
  console.log('[Ponder Config] 🔍 REVIEW MODE ACTIVE');
  console.log(`[Ponder Config]   Child Start Block: ${process.env.PONDER_START_BLOCK || CHILD_START_BLOCK_DEFAULT}`);
  console.log(`[Ponder Config]   Factory Start Block: ${FACTORY_START_BLOCK}`);
  console.log(`[Ponder Config]   End Block: ${endBlock || 'none (will sync to chain head)'}`);
}

// NOTE: Don't evaluate childStartBlock here at module-load time!
// getChildStartBlock() must be called lazily so test env vars are set first.
// See line 191 where it's called in the config object.

if (!suppressLogs) {
  console.log('[Ponder Config] Mech factory pattern enabled (Marketplace → OlasMech)');
  console.log('[Ponder Config] Factory start block:', FACTORY_START_BLOCK);
  console.log('[Ponder Config] Child start block (lazy eval):', process.env.PONDER_START_BLOCK || CHILD_START_BLOCK_DEFAULT);
}

// Read RPC_URL dynamically to support runtime overrides (important for tests!)
// Ponder's transport will be created lazily, so this function is called after env vars are set
function getRpcUrl(): string {
  const rpcUrl = process.env.BASE_RPC_URL || process.env.RPC_URL || "https://mainnet.base.org";
  return rpcUrl;
}

// Determine finality block count based on RPC URL
function getFinalityBlockCount(): number {
  // Allow explicit override for any environment (useful for local Anvil forks)
  if (process.env.PONDER_FINALITY_BLOCK_COUNT) {
    return Number(process.env.PONDER_FINALITY_BLOCK_COUNT);
  }
  const rpcUrl = getRpcUrl();
  // Tenderly virtual networks don't mine new blocks automatically, so finality checks fail
  // when Ponder tries to look ahead. Set finalityBlockCount to 0 for virtual networks.
  const isTenderlyVirtualNetwork = rpcUrl.includes('virtual') && rpcUrl.includes('tenderly.co');
  return isTenderlyVirtualNetwork ? 0 : 30;
}

// Support suite-specific database directory for parallel test execution (SQLite only)
const databaseDir = process.env.PONDER_DATABASE_DIR || '.ponder';

// Determine database config
const databaseConfig = process.env.PONDER_DATABASE_URL
  ? { kind: 'postgres' as const, connectionString: process.env.PONDER_DATABASE_URL }
  : { kind: 'sqlite' as const, directory: databaseDir };

// ============================================================================
// RUNTIME CONFIGURATION LOGGING (for debugging test environment issues)
// Write to both stderr and a debug file (Ponder UI may overwrite stderr)
// ============================================================================
const rpcUrl = getRpcUrl();
const isTenderly = rpcUrl.includes('virtual') && rpcUrl.includes('tenderly.co');

const configInfo = [
  '',
  '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  '🔍 PONDER RUNTIME CONFIG',
  '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  `VITEST: ${process.env.VITEST || 'not set'}`,
  `RPC_URL: ${process.env.RPC_URL || 'not set'}`,
  `BASE_RPC_URL: ${process.env.BASE_RPC_URL || 'not set'}`,
  `Resolved RPC URL: ${rpcUrl}`,
  `Is Tenderly VNet: ${isTenderly}`,
  `Finality Block Count: ${getFinalityBlockCount()}`,
  `Factory Start Block: ${FACTORY_START_BLOCK}`,
  `Child Start Block (env var): ${process.env.PONDER_START_BLOCK || 'not set'}`,
  `Child Start Block (default): ${CHILD_START_BLOCK_DEFAULT}`,
  `End Block: ${endBlock || 'none (realtime)'}`,
  `Database Mode: ${databaseConfig.kind}`,
];

if (databaseConfig.kind === 'postgres') {
  const connStr = databaseConfig.connectionString;
  const masked = connStr.replace(/:[^:@]+@/, ':****@'); // Mask password
  configInfo.push(`Database URL: ${masked}`);
} else {
  configInfo.push(`Database Dir: ${databaseConfig.directory}`);
}

configInfo.push(
  `Indexing Mode: Factory (MechMarketplace.CreateMech → OlasMech.Deliver)`,
  `Child Start Block (at config time): ${getChildStartBlock()}`,
  `OPERATE_PROFILE_DIR: ${process.env.OPERATE_PROFILE_DIR || 'not set'}`,
  `PORT: ${process.env.PORT || 'not set'}`,
  '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  ''
);

const configText = configInfo.join('\n');

// Write to stderr (may be overwritten by Ponder UI)
console.error(configText);

// Also write to a debug file in the current working directory
try {
  const { writeFileSync } = await import('fs');
  const debugFile = '.ponder-config-debug.txt';
  writeFileSync(debugFile, configText + `\nTimestamp: ${new Date().toISOString()}\nCWD: ${process.cwd()}\n`);
  console.error(`[Ponder Config] Debug info written to ${debugFile}`);
} catch (err) {
  console.error('[Ponder Config] Failed to write debug file:', err);
}


export default createConfig({
  // Production mode: Use PostgreSQL for all storage (not SQLite)
  // Test mode: Use suite-specific SQLite directory for parallel test isolation
  // This ensures artifacts table persists across restarts in production,
  // and enables parallel test execution without database conflicts
  database: databaseConfig,

  chains: {
    base: {
      id: 8453,
      rpc: getRpcUrl(), // Call function to get RPC URL at runtime
      pollingInterval: 6_000,
      maxRequestsPerSecond: 25,
      finalityBlockCount: getFinalityBlockCount(), // Call function to get finality count at runtime
    },
  },
  contracts: {
    MechMarketplace: {
      chain: "base",
      address: "0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020",
      // Reuse ABI from mech-client-ts to avoid duplication during dev
      abi: MechMarketplaceAbi,
      // CRITICAL TEST ENVIRONMENT FIX:
      // In test mode (FACTORY_START_BLOCK=0), we bypass the factory pattern on OlasMech
      // by setting address: undefined. But MechMarketplace must ALSO start from the recent
      // block, otherwise Ponder tries to scan from block 0 which doesn't exist in Tenderly VNets.
      //
      // Production: Scan from block 25M to discover all historical CreateMech events
      // Test: Scan from recent block (VNet fork point) to only index test dispatches
      startBlock: FACTORY_START_BLOCK === 0 ? getChildStartBlock() : FACTORY_START_BLOCK,
      endBlock,
    },
    OlasMech: {
      chain: "base",
      // AgentMech ABI may be packaged either under .abi or as raw JSON
      abi: (AgentMechAbi as any)?.abi || (AgentMechAbi as any),
      // CRITICAL TEST ENVIRONMENT FIX:
      // Tenderly VNets fork from recent mainnet (~40M) but DON'T contain historical
      // CreateMech events from earlier blocks. The factory pattern requires scanning
      // for CreateMech events to discover mech addresses before indexing Deliver events.
      //
      // Test environments set PONDER_FACTORY_START_BLOCK=0, but the VNet doesn't have
      // blocks 0 through ~40M, so the factory scan finds NO mechs and never indexes Deliver.
      //
      // SOLUTION: When FACTORY_START_BLOCK=0 (test mode), bypass factory pattern entirely
      // and index from all addresses. This works because:
      // 1. Test VNets are small (few hundred blocks) so scanning all addresses is fast
      // 2. Tests dispatch to known mech address, so events will be indexed
      // 3. Production (FACTORY_START_BLOCK=25M) still uses factory pattern for efficiency
      address: FACTORY_START_BLOCK === 0
        ? undefined // undefined = index from all addresses (test mode only!)
        : factory({
          address: "0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020",
          event: MechMarketplaceAbi.find((item: any) => item.type === 'event' && item.name === 'CreateMech'),
          parameter: "mech",
          // Scan factory events from early deployment to discover all historical mechs
          startBlock: FACTORY_START_BLOCK,
          endBlock,
        }),
      // Index Deliver events only from recent high-volume window (or env override)
      // CRITICAL: Call getChildStartBlock() here (not at module-load time) so test env vars are set first
      startBlock: getChildStartBlock(),
      endBlock,
    },
    // OLAS Staking Contracts - track which services are staked in which contracts
    // Split into separate entries so each scans from its actual deployment block,
    // avoiding millions of wasted RPC calls scanning empty blocks.
    JinnStaking: {
      chain: "base",
      abi: StakingTokenAbi,
      address: '0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139', // Jinn Staking V1 (5,000 OLAS min)
      startBlock: getStakingStartBlock('JinnStaking'),
      endBlock,
    },
    JinnStakingV2: {
      chain: "base",
      abi: StakingTokenAbi,
      address: '0x66A92CDa5B319DCCcAC6c1cECbb690CA3Fb59488', // Jinn Staking V2 (agent 103, DeliveryActivityChecker)
      startBlock: getStakingStartBlock('JinnStakingV2'),
      endBlock,
    },
  },
});

