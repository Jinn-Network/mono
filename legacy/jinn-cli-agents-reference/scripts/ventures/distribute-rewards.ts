#!/usr/bin/env tsx
/**
 * Distribute venture token rewards to workers
 *
 * Queries Ponder for completed deliveries in a venture's workstream,
 * calculates proportional token rewards, and outputs a Safe Transaction
 * Builder JSON batch for the Safe to execute.
 *
 * The treasury (80% of total supply) is held by the governance contract,
 * which is controlled by the venture's Gnosis Safe. The Safe imports the
 * batch JSON and executes the ERC20 transfers.
 *
 * Usage:
 *   yarn tsx scripts/ventures/distribute-rewards.ts \
 *     --venture-id "<uuid>" \
 *     --amount "10000" \
 *     --dry-run
 */

import { createPublicClient, http, parseEther, formatEther, encodeFunctionData, erc20Abi } from 'viem';
import { base } from 'viem/chains';
import { getVenture } from './mint.js';
import { writeFileSync } from 'fs';
import { resolve } from 'path';
import dotenv from 'dotenv';

dotenv.config();

const PONDER_URL = 'https://indexer.jinn.network/graphql';

// Default staking contract (shared Jinn staking)
const DEFAULT_STAKING_CONTRACT = '0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139' as const;

// MechActivityChecker ABI (minimal — only the functions we need)
const mechActivityCheckerAbi = [
  {
    inputs: [{ name: 'multisig', type: 'address' }],
    name: 'getMultisigNonces',
    outputs: [{ name: 'nonces', type: 'uint256[]' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'curNonces', type: 'uint256[]' },
      { name: 'lastNonces', type: 'uint256[]' },
      { name: 'ts', type: 'uint256' },
    ],
    name: 'isRatioPass',
    outputs: [{ name: 'ratioPass', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'livenessRatio',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

interface DistributeArgs {
  ventureId: string;
  amount: string; // Total tokens to distribute this round
  dryRun: boolean;
  output: string; // Path for Safe TX batch JSON
  rpcUrl?: string;
  skipActivityCheck: boolean;
}

interface DeliveryCount {
  workerAddress: string;
  count: number;
}

interface SafeTxBatch {
  version: '1.0';
  chainId: string;
  createdAt: number;
  meta: {
    name: string;
    description: string;
    txBuilderVersion: string;
  };
  transactions: Array<{
    to: string;
    value: string;
    data: string;
    contractMethod: {
      inputs: Array<{ name: string; type: string }>;
      name: string;
      payable: boolean;
    };
    contractInputsValues: Record<string, string>;
  }>;
}

/**
 * Query Ponder for completed deliveries in a workstream
 */
async function getDeliveriesByWorker(workstreamId: string): Promise<DeliveryCount[]> {
  const query = `
    query GetDeliveries($workstreamId: String!) {
      delivers(
        where: { workstreamId: $workstreamId }
        orderBy: "blockTimestamp"
        orderDirection: "desc"
        limit: 1000
      ) {
        items {
          sender
          requestId
        }
      }
    }
  `;

  const response = await fetch(PONDER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { workstreamId } }),
  });

  const result = await response.json();
  const items = result?.data?.delivers?.items || [];

  // Group by sender (worker address)
  const counts = new Map<string, number>();
  for (const item of items) {
    const addr = item.sender.toLowerCase();
    counts.set(addr, (counts.get(addr) || 0) + 1);
  }

  return Array.from(counts.entries()).map(([workerAddress, count]) => ({
    workerAddress,
    count,
  }));
}

/**
 * Check if a service met its activity target via MechActivityChecker
 */
async function checkServiceActivity(
  publicClient: ReturnType<typeof createPublicClient>,
  stakingContract: string,
  multisigAddress: string,
): Promise<{ passed: boolean; nonces: readonly bigint[] }> {
  try {
    const nonces = await publicClient.readContract({
      address: stakingContract as `0x${string}`,
      abi: mechActivityCheckerAbi,
      functionName: 'getMultisigNonces',
      args: [multisigAddress as `0x${string}`],
    });

    return { passed: true, nonces };
  } catch (err: any) {
    console.warn(`  Activity check failed for ${multisigAddress}: ${err.message}`);
    return { passed: false, nonces: [] };
  }
}

/**
 * Build a Safe Transaction Builder JSON batch of ERC20 transfers
 */
function buildSafeTxBatch(
  tokenAddress: string,
  governanceAddress: string,
  allocations: Array<{ workerAddress: string; amount: bigint; amountFormatted: string }>,
  ventureName: string,
  distributionAmount: string,
): SafeTxBatch {
  const transactions = allocations
    .filter((a) => a.amount > 0n)
    .map((alloc) => {
      const data = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [alloc.workerAddress as `0x${string}`, alloc.amount],
      });

      return {
        to: tokenAddress,
        value: '0',
        data,
        contractMethod: {
          inputs: [
            { name: 'to', type: 'address' },
            { name: 'amount', type: 'uint256' },
          ],
          name: 'transfer',
          payable: false,
        },
        contractInputsValues: {
          to: alloc.workerAddress,
          amount: alloc.amount.toString(),
        },
      };
    });

  return {
    version: '1.0',
    chainId: '8453', // Base mainnet
    createdAt: Date.now(),
    meta: {
      name: `${ventureName} — Token Distribution`,
      description: `Distribute ${distributionAmount} tokens to ${transactions.length} workers based on delivery count. Calls transfer() on the venture token from the governance contract treasury.`,
      txBuilderVersion: '1.16.5',
    },
    transactions,
  };
}

async function distributeRewards(args: DistributeArgs) {
  const { ventureId, amount, dryRun, output, skipActivityCheck } = args;
  const rpcUrl = args.rpcUrl || process.env.BASE_RPC_URL || 'https://mainnet.base.org';

  // Fetch venture details
  const venture = await getVenture(ventureId);
  if (!venture) {
    throw new Error(`Venture not found: ${ventureId}`);
  }

  if (!venture.token_address) {
    throw new Error(`Venture ${venture.name} has no token address`);
  }

  if (!venture.root_workstream_id) {
    throw new Error(`Venture ${venture.name} has no root workstream ID`);
  }

  const governanceAddress = venture.governance_address;
  if (!governanceAddress) {
    throw new Error(`Venture ${venture.name} has no governance address. The governance contract holds the treasury.`);
  }

  const stakingContract = venture.staking_contract_address || DEFAULT_STAKING_CONTRACT;

  console.log(`Distributing ${amount} ${venture.token_symbol || 'tokens'} for venture: ${venture.name}`);
  console.log(`  Token: ${venture.token_address}`);
  console.log(`  Governance (treasury): ${governanceAddress}`);
  console.log(`  Workstream: ${venture.root_workstream_id}`);
  console.log(`  Staking contract: ${stakingContract}`);
  console.log(`  Dry run: ${dryRun}`);

  // Get delivery counts by worker
  const deliveries = await getDeliveriesByWorker(venture.root_workstream_id);

  if (deliveries.length === 0) {
    console.log('No deliveries found. Nothing to distribute.');
    return;
  }

  const totalDeliveries = deliveries.reduce((sum, d) => sum + d.count, 0);
  const totalAmount = parseEther(amount);

  console.log(`\nFound ${totalDeliveries} deliveries across ${deliveries.length} workers:`);

  // Activity check (optional)
  const publicClient = createPublicClient({
    chain: base,
    transport: http(rpcUrl),
  });

  let eligibleDeliveries = deliveries;

  if (!skipActivityCheck) {
    console.log('\nChecking service activity targets...');
    const activityResults = await Promise.all(
      deliveries.map(async (d) => {
        const activity = await checkServiceActivity(publicClient, stakingContract, d.workerAddress);
        console.log(`  ${d.workerAddress}: ${activity.passed ? 'PASSED' : 'FAILED'} activity check`);
        return { ...d, activityPassed: activity.passed };
      }),
    );

    eligibleDeliveries = activityResults.filter((d) => d.activityPassed);

    if (eligibleDeliveries.length < deliveries.length) {
      const excluded = deliveries.length - eligibleDeliveries.length;
      console.log(`\n${excluded} worker(s) excluded due to failed activity check.`);
    }

    if (eligibleDeliveries.length === 0) {
      console.log('No eligible workers after activity check. Nothing to distribute.');
      return;
    }
  }

  const eligibleTotal = eligibleDeliveries.reduce((sum, d) => sum + d.count, 0);

  // Calculate proportional allocation
  const allocations = eligibleDeliveries.map(({ workerAddress, count }) => {
    const share = (BigInt(count) * totalAmount) / BigInt(eligibleTotal);
    return {
      workerAddress,
      deliveries: count,
      percentage: ((count / eligibleTotal) * 100).toFixed(1),
      amount: share,
      amountFormatted: formatEther(share),
    };
  });

  // Print allocation table
  console.log('\nAllocation:');
  for (const alloc of allocations) {
    console.log(`  ${alloc.workerAddress}: ${alloc.deliveries} deliveries (${alloc.percentage}%) -> ${alloc.amountFormatted} tokens`);
  }

  if (dryRun) {
    console.log('\n[DRY RUN] No Safe TX batch generated.');
    return { allocations, totalDeliveries: eligibleTotal, dryRun: true };
  }

  // Build Safe TX batch JSON
  const batch = buildSafeTxBatch(
    venture.token_address,
    governanceAddress,
    allocations,
    venture.name,
    amount,
  );

  const outputPath = resolve(output);
  writeFileSync(outputPath, JSON.stringify(batch, null, 2));

  console.log(`\nSafe Transaction Builder batch written to: ${outputPath}`);
  console.log(`  ${batch.transactions.length} transfer(s) in batch`);
  console.log(`\nNext steps:`);
  console.log(`  1. Open the Safe app for the venture's Safe`);
  console.log(`  2. Go to Transaction Builder`);
  console.log(`  3. Import ${outputPath}`);
  console.log(`  4. Review and execute the batch transaction`);

  return { allocations, totalDeliveries: eligibleTotal, dryRun: false, outputPath };
}

// ============================================================================
// CLI Interface
// ============================================================================

function parseArgs(): DistributeArgs {
  const args = process.argv.slice(2);
  const result: Partial<DistributeArgs> = {
    dryRun: false,
    output: './safe-tx-distribute.json',
    skipActivityCheck: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--venture-id':
        result.ventureId = next;
        i++;
        break;
      case '--amount':
        result.amount = next;
        i++;
        break;
      case '--dry-run':
        result.dryRun = true;
        break;
      case '--output':
        result.output = next;
        i++;
        break;
      case '--rpc-url':
        result.rpcUrl = next;
        i++;
        break;
      case '--skip-activity-check':
        result.skipActivityCheck = true;
        break;
    }
  }

  if (!result.ventureId) {
    console.error('Error: --venture-id is required');
    printUsage();
    process.exit(1);
  }
  if (!result.amount) {
    console.error('Error: --amount is required');
    printUsage();
    process.exit(1);
  }

  return result as DistributeArgs;
}

function printUsage() {
  console.log(`
Usage: yarn tsx scripts/ventures/distribute-rewards.ts [options]

Required:
  --venture-id <uuid>    Venture ID to distribute rewards for
  --amount <tokens>      Total tokens to distribute this round

Optional:
  --dry-run              Calculate allocations without generating batch JSON
  --output <path>        Output path for Safe TX batch JSON (default: ./safe-tx-distribute.json)
  --rpc-url <url>        Base RPC URL (default: BASE_RPC_URL env)
  --skip-activity-check  Skip MechActivityChecker verification

How it works:
  1. Queries Ponder for completed deliveries in the venture's workstream
  2. Checks each worker's service activity via MechActivityChecker
  3. Groups deliveries by eligible worker addresses
  4. Calculates proportional token allocation
  5. Outputs a Safe Transaction Builder JSON batch file
  6. The venture's Safe imports and executes the batch to distribute tokens
     from the governance contract treasury

Safe TX batch:
  The batch contains ERC20 transfer() calls on the venture token.
  The governance contract holds the 80% treasury and is controlled by the Safe.
  Import the JSON in the Safe app → Transaction Builder to execute.

Examples:
  # Preview allocation (dry run)
  yarn tsx scripts/ventures/distribute-rewards.ts \\
    --venture-id "123..." \\
    --amount "10000" \\
    --dry-run

  # Generate Safe TX batch
  yarn tsx scripts/ventures/distribute-rewards.ts \\
    --venture-id "123..." \\
    --amount "10000" \\
    --output "./safe-tx-distribute.json"
`);
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  try {
    const args = parseArgs();
    const result = await distributeRewards(args);
    console.log(JSON.stringify({ ok: true, data: result }, null, 2));
  } catch (err: any) {
    console.error(JSON.stringify({ ok: false, error: err.message }));
    process.exit(1);
  }
}

const isDirectRun = process.argv[1]?.endsWith('distribute-rewards.ts') || process.argv[1]?.endsWith('distribute-rewards.js');
if (isDirectRun) {
  main();
}
