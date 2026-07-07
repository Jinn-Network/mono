/**
 * Deploy JinnTestnetFaucet on Base Sepolia.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-jinn-testnet-faucet.ts --network baseSepolia
 *
 * Required env vars:
 *   DEPLOYER_PRIVATE_KEY  - deployer wallet private key (signs the deploy tx)
 *   L2_JINN_ADDRESS       - L2 JINN token address on Base Sepolia
 *                            (defaults to the current phase1a deployment address)
 *
 * Optional env vars:
 *   DRIP_AMOUNT_ETHER     - JINN per drip, in whole tokens (default: 100)
 *   DRIP_INTERVAL_SECONDS - seconds between drips per recipient (default: 86400 = 24h)
 *
 * After deploy: bridge JINN from Sepolia L1 to Base Sepolia L2 and transfer into
 * the faucet contract. See contracts/scripts/README-jinn-testnet-faucet.md for the
 * step-by-step cast commands.
 */

import { network } from 'hardhat';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ESM (package "type":"module" + nodenext) has no CJS `__dirname`; derive it
// from import.meta (same transform used in test/storage-layout.test.ts).
const __dirname = import.meta.dirname;

const DEFAULT_L2_JINN = '0xAB9a01cd4A379e36006ec6df2960CF39EF79df63';
const DEFAULT_DRIP_AMOUNT_ETHER = '100';
const DEFAULT_DRIP_INTERVAL_SECONDS = 24 * 60 * 60;

async function main() {
  const { ethers } = await network.connect();
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);

  if (chainId !== 84532) {
    throw new Error(
      `Refusing to deploy JinnTestnetFaucet on chainId ${chainId}. This is a testnet-only contract — run against baseSepolia (84532).`,
    );
  }

  const jinnAddress = process.env.L2_JINN_ADDRESS ?? DEFAULT_L2_JINN;
  const dripAmountEther = process.env.DRIP_AMOUNT_ETHER ?? DEFAULT_DRIP_AMOUNT_ETHER;
  const dripInterval = process.env.DRIP_INTERVAL_SECONDS
    ? parseInt(process.env.DRIP_INTERVAL_SECONDS, 10)
    : DEFAULT_DRIP_INTERVAL_SECONDS;
  const dripAmount = ethers.parseEther(dripAmountEther);

  console.log('Network        :', net.name, `(chainId=${chainId})`);
  console.log('Deployer       :', deployer.address);
  console.log('Balance        :', ethers.formatEther(await ethers.provider.getBalance(deployer.address)), 'ETH');
  console.log('L2 JINN token  :', jinnAddress);
  console.log('Drip amount    :', dripAmountEther, 'JINN');
  console.log('Drip interval  :', dripInterval, 'seconds');

  console.log('\n--- Deploying JinnTestnetFaucet ---');
  const Factory = await ethers.getContractFactory('JinnTestnetFaucet');
  const faucet = await Factory.deploy(jinnAddress, dripAmount, dripInterval);
  await faucet.waitForDeployment();
  const faucetAddress = await faucet.getAddress();
  console.log('JinnTestnetFaucet deployed to:', faucetAddress);

  // Write conventional deployment JSON
  const summary = {
    network: net.name || 'baseSepolia',
    chainId,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    config: {
      jinnToken: jinnAddress,
      dripAmount: dripAmount.toString(),
      dripInterval,
      initialSupplyBridged: '0',
    },
    contracts: {
      faucet: faucetAddress,
    },
  };

  const outDir = path.resolve(__dirname, '..');
  const outFile = path.join(outDir, 'deployment-jinn-testnet-faucet-baseSepolia.json');
  fs.writeFileSync(outFile, JSON.stringify(summary, null, 2) + '\n');
  console.log('\nDeployment artifact written to:', outFile);

  // Also copy to client/deployments/ for the bundled-default loader
  const clientDeployments = path.resolve(__dirname, '..', '..', 'client', 'deployments');
  if (fs.existsSync(clientDeployments)) {
    const clientOut = path.join(clientDeployments, 'deployment-jinn-testnet-faucet-baseSepolia-fast.json');
    fs.writeFileSync(clientOut, JSON.stringify(summary, null, 2) + '\n');
    console.log('Bundled default copy:', clientOut);
  } else {
    console.log('(client/deployments not found — skipping bundled-default copy)');
  }

  console.log('\n=== Deployment Summary ===');
  console.log(JSON.stringify(summary, null, 2));

  console.log('\n--- Next steps ---');
  console.log('1. Bridge JINN from Sepolia L1 to this faucet — see');
  console.log('   contracts/scripts/README-jinn-testnet-faucet.md');
  console.log('2. Verify faucet balance:');
  console.log(`   cast call ${faucetAddress} "balance()(uint256)" --rpc-url $BASE_SEPOLIA_RPC_URL`);
  console.log('3. The client reads the new artifact automatically from');
  console.log('   client/deployments/deployment-jinn-testnet-faucet-baseSepolia-fast.json');
  console.log('   (override via env JINN_TESTNET_FAUCET_DEPLOYMENT=…)');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
