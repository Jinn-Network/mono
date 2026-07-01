import { isRunEntry } from "./lib/run-entry.js";
/**
 * In-place upgrade of the live TaskActivityCheckerV3 proxy implementation.
 *
 * The tokenless-OLAS trim stubs the on-chain anti-farming (novelty/decay) to a
 * flat full-weight credit while preserving EVERY storage slot (verified:
 * eligibleActivityWeight stays at slot 16, the slot the OLAS StakingBase
 * checkpoint reads). That makes this a storage-identical `changeImplementation`
 * on the existing checker proxy — the staking proxy's immutable checker pointer
 * is undisturbed and NO operator re-stakes.
 *
 * The main deploy script (deploy-task-coordinator-router-v3.ts) deliberately
 * SKIPS the checker impl upgrade on live (its `alreadyV3` probe sees the
 * surviving taskCreationWeight getter), so this script forces it.
 *
 *   DEPLOYER_PRIVATE_KEY=… BASE_SEPOLIA_RPC_URL=… \
 *     ./node_modules/.bin/hardhat run scripts/upgrade-checker-impl.ts --network baseSepolia
 *
 * Optional env: ACTIVITY_CHECKER_ADDRESS (default the live Base Sepolia proxy).
 */
import { network } from "hardhat";
import { JsonRpcProvider, Wallet, type TransactionRequest } from "ethers";

const DEFAULT_CHECKER = "0x0e1B5f264F4FAdcFAA950fb00c58d9A39C040f70";

const CHECKER_ABI = [
  "function owner() view returns (address)",
  "function authorizedRouter() view returns (address)",
  "function taskCreationWeight(address) view returns (uint256)",
  "function eligibleActivityWeight(address) view returns (uint256)",
  "function changeImplementation(address newImplementation) external",
];

async function main() {
  const { ethers } = await network.connect();

  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) throw new Error("DEPLOYER_PRIVATE_KEY is required for the live checker upgrade.");
  const rpcUrl = (process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org").split(",")[0].trim();
  const checkerAddr = (process.env.ACTIVITY_CHECKER_ADDRESS ?? DEFAULT_CHECKER).trim();

  const provider = new JsonRpcProvider(rpcUrl);
  const deployer = new Wallet(pk, provider);
  const deployerAddr = await deployer.getAddress();
  const net = await provider.getNetwork();

  console.log("=== Upgrade TaskActivityCheckerV3 impl (in place) ===");
  console.log(`Network:  chainId ${net.chainId}`);
  console.log(`Deployer: ${deployerAddr}`);
  console.log(`Checker:  ${checkerAddr}`);
  console.log(`Balance:  ${ethers.formatEther(await provider.getBalance(deployerAddr))} ETH`);

  if (net.chainId !== 84532n) {
    throw new Error(`Refusing: expected Base Sepolia (84532), connected to chainId ${net.chainId}.`);
  }

  const checker = new ethers.Contract(checkerAddr, CHECKER_ABI, deployer);
  const owner: string = await checker.owner();
  if (owner.toLowerCase() !== deployerAddr.toLowerCase()) {
    throw new Error(`Checker owner ${owner} is not the deployer ${deployerAddr}; changeImplementation is owner-gated.`);
  }
  const preRouter: string = await checker.authorizedRouter();
  console.log(`pre  authorizedRouter: ${preRouter}`);

  const overrides: TransactionRequest = {
    maxFeePerGas: ethers.parseUnits(process.env.BASE_SEPOLIA_MAX_FEE_GWEI ?? "2", "gwei"),
    maxPriorityFeePerGas: ethers.parseUnits(process.env.BASE_SEPOLIA_PRIORITY_FEE_GWEI ?? "1", "gwei"),
  };

  console.log("Deploying trimmed TaskActivityCheckerV3 implementation...");
  const Factory = await ethers.getContractFactory("TaskActivityCheckerV3", deployer);
  const impl = await Factory.deploy({ ...overrides, gasLimit: 2_500_000n });
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log(`  new impl: ${implAddr}`);

  console.log("changeImplementation on the proxy...");
  const tx = await checker.changeImplementation(implAddr, { ...overrides, gasLimit: 250_000n });
  console.log(`  tx: ${tx.hash}`);
  const rc = await tx.wait();
  console.log(`  mined block ${rc?.blockNumber}, status ${rc?.status}`);
  if (rc?.status !== 1) throw new Error("changeImplementation reverted.");

  // Verify the proxy still answers a V3 getter (it now delegatecalls the new impl)
  // and that authorizedRouter (storage) is preserved across the upgrade.
  const postRouter: string = await checker.authorizedRouter();
  const preserved = postRouter.toLowerCase() === preRouter.toLowerCase();
  console.log(`post authorizedRouter: ${postRouter} (preserved: ${preserved})`);
  console.log(`post taskCreationWeight(deployer): ${await checker.taskCreationWeight(deployerAddr)}`);
  if (!preserved) throw new Error("authorizedRouter changed across the upgrade — storage layout drift!");

  console.log(`\nNEW_CHECKER_IMPL=${implAddr}`);
  console.log("Checker upgraded in place. Storage preserved; staking proxy unaffected.");
}

if (isRunEntry(import.meta.url)) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
