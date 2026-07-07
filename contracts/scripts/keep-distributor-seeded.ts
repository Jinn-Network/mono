/**
 * Protocol-team keeper: ensure the stOLAS L2 distributor has enough JINN
 * for a fleet of testnet operators to stake.
 *
 * This is NOT an operator-facing tool. Operators never hold JINN directly
 * under stOLAS standard mode — the distributor pool does, funded by the
 * protocol team on testnet (real L1 stakers fill it on mainnet).
 *
 * Flow on each invocation:
 *   1. Read L2 JINN balance of the stOLAS distributor address.
 *   2. If below `FLOOR_JINN`, try to top up from the JinnTestnetFaucet.
 *      - `faucet.withdraw(distributor, shortfall)` is an owner-only call;
 *        we use DEPLOYER_PRIVATE_KEY.
 *   3. If the faucet itself is too low to cover the shortfall, print the
 *      exact `cast` commands to bridge more JINN from Sepolia L1.
 *
 * Intended invocation: cron every 15 min, or manually before a testnet
 * acceptance run.
 *
 * Usage:
 *   npx hardhat run scripts/keep-distributor-seeded.ts --network baseSepolia
 *
 * Required env vars:
 *   DEPLOYER_PRIVATE_KEY  deployer / faucet owner key
 *   BASE_SEPOLIA_RPC_URL  (via hardhat network config)
 *
 * Optional env vars:
 *   DISTRIBUTOR_FLOOR_JINN   minimum pool balance, in whole tokens (default: 500)
 *   DISTRIBUTOR_TARGET_JINN  top-up target, in whole tokens (default: 1000)
 *   FAUCET_ADDRESS           JinnTestnetFaucet address (default: reads from
 *                            deployment-jinn-testnet-faucet-baseSepolia.json)
 *   DISTRIBUTOR_ADDRESS      stOLAS distributor (default: from stolas-l2 JSON)
 *   L2_JINN_ADDRESS          L2 JINN token (default: 0xAB9a01cd…)
 */

import { network } from 'hardhat';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ESM (package "type":"module" + nodenext) has no CJS `__dirname`; derive it
// from import.meta (same transform used in test/storage-layout.test.ts).
const __dirname = import.meta.dirname;

const DEFAULT_L2_JINN = '0xAB9a01cd4A379e36006ec6df2960CF39EF79df63';
const DEFAULT_FLOOR_JINN = '500';
const DEFAULT_TARGET_JINN = '1000';
const L1_JINN = '0xc3ae831f146Eabbb8095E1EDf90a187AA4E5F408';
const L1_STANDARD_BRIDGE = '0xfd0Bf71F60660E2f608ed56e1659C450eB113120';

const ERC20_BALANCE_ABI = [
  'function balanceOf(address) view returns (uint256)',
];

const FAUCET_ABI = [
  'function balance() view returns (uint256)',
  'function withdraw(address to, uint256 amount) external',
];

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
}

async function main() {
  const { ethers } = await network.connect();
  const [signer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  if (chainId !== 84532) {
    throw new Error(`Expected Base Sepolia (chainId 84532); got ${chainId}. Run with --network baseSepolia.`);
  }

  const l2Jinn = process.env.L2_JINN_ADDRESS ?? DEFAULT_L2_JINN;
  const floorEther = process.env.DISTRIBUTOR_FLOOR_JINN ?? DEFAULT_FLOOR_JINN;
  const targetEther = process.env.DISTRIBUTOR_TARGET_JINN ?? DEFAULT_TARGET_JINN;
  const floor = ethers.parseEther(floorEther);
  const target = ethers.parseEther(targetEther);

  const distributorAddress = process.env.DISTRIBUTOR_ADDRESS ?? (() => {
    const stolasPath = path.resolve(__dirname, '..', 'deployments', 'deployment-stolas-l2-baseSepolia-fast.json');
    // Try both the contracts/deployments path and the client bundled path.
    const candidates = [
      stolasPath,
      path.resolve(__dirname, '..', '..', 'client', 'deployments', 'deployment-stolas-l2-baseSepolia-fast.json'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const j = readJson(p);
        const contracts = j['contracts'] as Record<string, string> | undefined;
        if (contracts?.['distributor']) return contracts['distributor'];
      }
    }
    throw new Error(
      'Could not resolve DISTRIBUTOR_ADDRESS. Pass it explicitly via the env var, ' +
      'or ensure deployment-stolas-l2-baseSepolia-fast.json exists in contracts/deployments/ or client/deployments/.',
    );
  })();

  const faucetAddress = process.env.FAUCET_ADDRESS ?? (() => {
    const candidates = [
      path.resolve(__dirname, '..', 'deployment-jinn-testnet-faucet-baseSepolia.json'),
      path.resolve(__dirname, '..', '..', 'client', 'deployments', 'deployment-jinn-testnet-faucet-baseSepolia-fast.json'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const j = readJson(p);
        const contracts = j['contracts'] as Record<string, string> | undefined;
        if (contracts?.['faucet']) return contracts['faucet'];
      }
    }
    throw new Error(
      'Could not resolve FAUCET_ADDRESS. Pass it explicitly via the env var, or ensure ' +
      'the faucet deployment JSON exists.',
    );
  })();

  console.log('Network          :', net.name, `(chainId=${chainId})`);
  console.log('Signer           :', signer.address);
  console.log('L2 JINN token    :', l2Jinn);
  console.log('Distributor      :', distributorAddress);
  console.log('Faucet           :', faucetAddress);
  console.log('Floor JINN       :', floorEther);
  console.log('Target JINN      :', targetEther);
  console.log('');

  const token = new ethers.Contract(l2Jinn, ERC20_BALANCE_ABI, signer);
  const faucet = new ethers.Contract(faucetAddress, FAUCET_ABI, signer);

  const distributorBalance: bigint = await token.balanceOf(distributorAddress);
  const faucetBalance: bigint = await faucet.balance();

  const distributorJinn = Number(distributorBalance) / 1e18;
  const faucetJinn = Number(faucetBalance) / 1e18;
  console.log(`Distributor holds: ${distributorJinn.toFixed(2)} JINN`);
  console.log(`Faucet holds     : ${faucetJinn.toFixed(2)} JINN`);

  if (distributorBalance >= floor) {
    console.log(`\nOK — distributor balance ≥ floor (${floorEther} JINN). No action needed.`);
    return;
  }

  const shortfall = target - distributorBalance;
  const shortfallJinn = Number(shortfall) / 1e18;
  console.log(`\nShortfall: ${shortfallJinn.toFixed(2)} JINN needed to reach target.`);

  if (faucetBalance < shortfall) {
    console.log('\nFaucet has insufficient JINN to cover the top-up.');
    console.log('Bridge more JINN from Sepolia L1 first:');
    console.log('');
    console.log('  # On Sepolia L1');
    console.log(`  cast send ${L1_JINN} "mint(address,uint256)" <DEPLOYER> ${shortfallJinn * 2}ether \\`);
    console.log('    --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$SEPOLIA_RPC_URL"');
    console.log('');
    console.log(`  cast send ${L1_JINN} "approve(address,uint256)" ${L1_STANDARD_BRIDGE} ${shortfallJinn * 2}ether \\`);
    console.log('    --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$SEPOLIA_RPC_URL"');
    console.log('');
    console.log(`  cast send ${L1_STANDARD_BRIDGE} \\`);
    console.log('    "depositERC20(address,address,uint256,uint32,bytes)" \\');
    console.log(`    ${L1_JINN} ${l2Jinn} ${shortfallJinn * 2}ether 200000 0x \\`);
    console.log('    --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$SEPOLIA_RPC_URL"');
    console.log('');
    console.log('  # Wait ~3 min for L2 to observe the deposit, then on Base Sepolia:');
    console.log(`  cast send ${l2Jinn} "transfer(address,uint256)" ${faucetAddress} ${shortfallJinn * 2}ether \\`);
    console.log('    --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$BASE_SEPOLIA_RPC_URL"');
    console.log('');
    console.log('Then re-run this script.');
    process.exitCode = 1;
    return;
  }

  console.log(`Withdrawing ${shortfallJinn.toFixed(2)} JINN from faucet to distributor...`);
  const tx = await faucet.withdraw(distributorAddress, shortfall);
  console.log(`  tx: ${tx.hash}`);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`Withdraw tx failed: ${tx.hash}`);
  }
  console.log('  confirmed.');

  const post: bigint = await token.balanceOf(distributorAddress);
  const postJinn = Number(post) / 1e18;
  console.log(`\nDistributor now holds: ${postJinn.toFixed(2)} JINN.`);
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
