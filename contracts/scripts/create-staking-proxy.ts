import { ethers } from "hardhat";
import { JsonRpcProvider, Wallet } from "ethers";
import * as fs from "fs";

async function main() {
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY!;
  const deployer = new Wallet(privateKey, new JsonRpcProvider("https://sepolia.base.org"));
  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await deployer.provider!.getBalance(deployer.address)));

  const l2 = JSON.parse(fs.readFileSync("deployment-phase1a-l2-baseSepolia-fast.json", "utf-8"));
  const checkerAddr = "0xF4Ca4943Eb0b0927d754A6A95206364f017D45f6";

  const StakingToken = await ethers.getContractFactory("StakingToken", deployer);
  const initPayload = StakingToken.interface.encodeFunctionData("initialize", [{
    metadataHash: ethers.id("jinn-phase1b-staking"),
    maxNumServices: 100,
    rewardsPerSecond: ethers.parseEther("0.0001"),
    minStakingDeposit: ethers.parseEther("10"),
    minNumStakingPeriods: 2,
    maxNumInactivityPeriods: 1,
    livenessPeriod: 300,
    timeForEmissions: 21600,
    numAgentInstances: 1,
    agentIds: [] as number[],
    threshold: 0,
    configHash: ethers.ZeroHash,
    proxyHash: "0xb89c1b3bdf2cf8827818646bce9a8f6e372885f8c55e5c07acbd307cb133b000",
    serviceRegistry: l2.contracts.serviceRegistry,
    activityChecker: checkerAddr,
  }, l2.contracts.serviceRegistryTokenUtility, l2.contracts.jinnToken]);

  const factory = new ethers.Contract(l2.contracts.stakingFactory, [
    "function createStakingInstance(address, bytes) returns (address)",
    "event InstanceCreated(address indexed instance, address indexed implementation)",
  ], deployer);

  console.log("Creating staking proxy...");
  const tx = await factory.createStakingInstance(l2.contracts.stakingImplementation, initPayload, {
    gasLimit: 5_000_000n,
    maxFeePerGas: ethers.parseUnits("2", "gwei"),
    maxPriorityFeePerGas: ethers.parseUnits("1", "gwei"),
  });
  console.log("Tx:", tx.hash);
  const receipt = await tx.wait();
  for (const log of receipt!.logs) {
    try {
      const parsed = factory.interface.parseLog(log);
      if (parsed?.name === "InstanceCreated") {
        console.log("StakingToken proxy:", parsed.args[0]);
      }
    } catch {}
  }
}
main().catch(console.error);
