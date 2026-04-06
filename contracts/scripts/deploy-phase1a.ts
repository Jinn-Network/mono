/**
 * Deploy the full Jinn Phase 1a L1 tokenomics stack.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-phase1a.ts --network hardhat   # local
 *   npx hardhat run scripts/deploy-phase1a.ts --network sepolia   # testnet
 *
 * Env vars:
 *   DEPLOYER_PRIVATE_KEY  - deployer wallet private key (required for live networks)
 *   EPOCH_LENGTH          - epoch length in seconds (default: 864000 = 10 days)
 *
 * Outputs:
 *   deployment-phase1a-{network}.json  - JSON file with all contract addresses
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import {
  deployL1Stack,
  DEFAULT_DEPLOY_CONFIG,
  DeployConfig,
} from "./lib/deploy-helpers";

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;

  console.log("=== Jinn Phase 1a L1 Stack Deployment ===");
  console.log(`Network:  ${networkName} (chainId: ${network.chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(
    `Balance:  ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`
  );
  console.log();

  // Build config from env overrides
  const config: DeployConfig = {
    ...DEFAULT_DEPLOY_CONFIG,
  };

  if (process.env.EPOCH_LENGTH) {
    config.epochLen = parseInt(process.env.EPOCH_LENGTH);
    console.log(`Using custom epoch length: ${config.epochLen}s`);
  }

  console.log("Deploying L1 stack (this may take a minute)...\n");
  const d = await deployL1Stack(deployer, config);

  // Collect addresses
  const addresses: Record<string, string> = {};
  const contracts = [
    ["JINN", d.jinn],
    ["veOLAS", d.veOLAS],
    ["Tokenomics", d.tokenomics],
    ["Treasury", d.treasury],
    ["Depository", d.depository],
    ["Dispenser", d.dispenser],
    ["GenericBondCalculator", d.bondCalculator],
    ["VoteWeighting", d.voteWeighting],
    ["ComponentRegistry (stub)", d.componentRegistry],
    ["AgentRegistry (stub)", d.agentRegistry],
    ["ServiceRegistry (stub)", d.serviceRegistry],
  ] as const;

  for (const [name, contract] of contracts) {
    addresses[name] = await contract.getAddress();
  }

  // Set PROXY_TOKENOMICS so checkpoint() works without a proxy.
  // Tokenomics.checkpoint() checks sload(PROXY_TOKENOMICS) != 0 to guard
  // against non-delegatecall usage. In a non-proxy deployment we satisfy this
  // by writing the Tokenomics address itself into that slot.
  console.log("Setting Tokenomics implementation pointer (for checkpoint)...");
  const tokenomicsAddr = await d.tokenomics.getAddress();
  const implTx = await d.tokenomics.changeTokenomicsImplementation(
    tokenomicsAddr
  );
  await implTx.wait();
  console.log("  Done.\n");

  // Print summary
  console.log("=== Deployment Summary ===");
  for (const [name, addr] of Object.entries(addresses)) {
    console.log(`  ${name.padEnd(30)} ${addr}`);
  }

  // Build output JSON
  const output = {
    network: networkName,
    chainId: Number(network.chainId),
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    config: {
      epochLen: config.epochLen,
      maxNumClaimingEpochs: config.maxNumClaimingEpochs,
      maxNumStakingTargets: config.maxNumStakingTargets,
      defaultMinStakingWeight: config.defaultMinStakingWeight,
      defaultMaxStakingIncentive: config.defaultMaxStakingIncentive,
    },
    contracts: addresses,
  };

  // Write to file
  const outPath = path.resolve(
    process.cwd(),
    `deployment-phase1a-${networkName}.json`
  );
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");
  console.log(`\nDeployment written to: ${outPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
