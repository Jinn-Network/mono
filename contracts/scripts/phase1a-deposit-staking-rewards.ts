import { network } from "hardhat";
import { ethers } from "ethers";
import { loadPhase1aArtifactsFromDisk } from "./lib/phase1a-rollout-helpers.js";
import { isRunEntry } from "./lib/run-entry.js";

interface DepositRewardsConfig {
  stakingToken: string;
  amount: bigint;
}

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

const STAKING_ABI = [
  "function deposit(uint256 amount)",
  "function availableRewards() view returns (uint256)",
  "function balance() view returns (uint256)",
];

export function resolveDepositRewardsConfig(
  defaultStakingToken: string,
  env: Record<string, string | undefined> = process.env,
): DepositRewardsConfig {
  const stakingToken = env.PHASE1A_STAKING_TARGET?.trim() ?? defaultStakingToken;
  if (!ethers.isAddress(stakingToken)) {
    throw new Error(`Invalid staking target address: ${stakingToken}`);
  }

  const amount = env.PHASE1A_STAKING_DEPOSIT_AMOUNT?.trim();
  if (!amount) {
    throw new Error("Set PHASE1A_STAKING_DEPOSIT_AMOUNT to the L2 JINN amount to deposit.");
  }

  return {
    stakingToken,
    amount: BigInt(amount),
  };
}

async function main() {
  const { ethers: hh } = await network.connect();
  const artifacts = loadPhase1aArtifactsFromDisk();
  const [signer] = await hh.getSigners();
  const config = resolveDepositRewardsConfig(artifacts.stakingTokenL2);
  const token = new ethers.Contract(artifacts.jinnL2, ERC20_ABI, signer);
  const staking = new ethers.Contract(config.stakingToken, STAKING_ABI, signer);

  const [balance, allowance, rewardsBefore, stakingBalanceBefore] = (await Promise.all([
    token.balanceOf(signer.address) as Promise<bigint>,
    token.allowance(signer.address, config.stakingToken) as Promise<bigint>,
    staking.availableRewards() as Promise<bigint>,
    staking.balance() as Promise<bigint>,
  ])) as [bigint, bigint, bigint, bigint];

  console.log(`Signer:                   ${signer.address}`);
  console.log(`L2 JINN:                  ${artifacts.jinnL2}`);
  console.log(`Staking target:           ${config.stakingToken}`);
  console.log(`Amount:                   ${ethers.formatEther(config.amount)} JINN`);
  console.log(`Signer L2 balance:        ${ethers.formatEther(balance)} JINN`);
  console.log(`Available rewards before: ${ethers.formatEther(rewardsBefore)} JINN`);
  console.log(`Staking balance before:   ${ethers.formatEther(stakingBalanceBefore)} JINN`);

  if (balance < config.amount) {
    throw new Error(`Signer only has ${balance} JINN on L2 but needs ${config.amount}.`);
  }

  if (allowance < config.amount) {
    const approveTx = await token.approve(config.stakingToken, config.amount);
    console.log(`Approve tx:               ${approveTx.hash}`);
    await approveTx.wait();
  }

  const depositTx = await staking.deposit(config.amount);
  console.log(`Deposit tx:               ${depositTx.hash}`);
  await depositTx.wait();

  const [rewardsAfter, stakingBalanceAfter] = (await Promise.all([
    staking.availableRewards() as Promise<bigint>,
    staking.balance() as Promise<bigint>,
  ])) as [bigint, bigint];
  console.log(`Available rewards after:  ${ethers.formatEther(rewardsAfter)} JINN`);
  console.log(`Staking balance after:    ${ethers.formatEther(stakingBalanceAfter)} JINN`);
}

if (isRunEntry(import.meta.url)) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
