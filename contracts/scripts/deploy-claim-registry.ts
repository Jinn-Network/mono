/**
 * Deploy ClaimRegistry + AcceptAllChecker
 *
 * Usage:
 *   npx hardhat run scripts/deploy-claim-registry.ts --network hardhat  # local
 *   npx hardhat run scripts/deploy-claim-registry.ts --network base     # mainnet
 *
 * Env vars:
 *   DEPLOYER_PRIVATE_KEY - deployer wallet private key
 *   CLAIM_TTL - claim time-to-live in seconds (default: 300 = 5 minutes)
 */

import { ethers } from 'hardhat';

const DEFAULT_CLAIM_TTL = 300; // 5 minutes

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log('Deploying with account:', deployer.address);
  console.log('Account balance:', ethers.formatEther(await ethers.provider.getBalance(deployer.address)));

  // 1. Deploy AcceptAllChecker
  console.log('\n--- Deploying AcceptAllChecker ---');
  const CheckerFactory = await ethers.getContractFactory('AcceptAllChecker');
  const checker = await CheckerFactory.deploy();
  await checker.waitForDeployment();
  const checkerAddress = await checker.getAddress();
  console.log('AcceptAllChecker deployed to:', checkerAddress);

  // 2. Deploy ClaimRegistry
  console.log('\n--- Deploying ClaimRegistry ---');
  const claimTTL = process.env.CLAIM_TTL ? parseInt(process.env.CLAIM_TTL) : DEFAULT_CLAIM_TTL;
  console.log('Claim TTL:', claimTTL, 'seconds');

  const RegistryFactory = await ethers.getContractFactory('ClaimRegistry');
  const registry = await RegistryFactory.deploy(claimTTL, deployer.address);
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  console.log('ClaimRegistry deployed to:', registryAddress);

  // 3. Set eligibility checker
  console.log('\n--- Setting eligibility checker ---');
  await registry.setEligibilityChecker(checkerAddress);
  console.log('EligibilityChecker set to AcceptAllChecker');

  // 4. Summary
  console.log('\n=== Deployment Summary ===');
  console.log(JSON.stringify({
    ClaimRegistry: registryAddress,
    AcceptAllChecker: checkerAddress,
    claimTTL,
    owner: deployer.address,
    network: (await ethers.provider.getNetwork()).name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
  }, null, 2));

  console.log('\n--- Next steps ---');
  console.log(`1. Set env var on client:`);
  console.log(`   CLAIM_REGISTRY_ADDRESS=${registryAddress}`);
  console.log(`2. Configure OnChainClaimPolicy with this address`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
