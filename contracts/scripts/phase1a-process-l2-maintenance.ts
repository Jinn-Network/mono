import { ethers } from "hardhat";
import { loadPhase1aArtifactsFromDisk } from "./lib/phase1a-rollout-helpers";

interface MaintenanceConfig {
  data: string;
  updateWithheldAmount: boolean;
}

const TARGET_DISPENSER_ABI = [
  "function processDataMaintenance(bytes data, bool updateWithheldAmount)",
];

export function resolveMaintenanceConfig(
  env: Record<string, string | undefined> = process.env,
): MaintenanceConfig {
  const data = env.PHASE1A_MAINTENANCE_DATA?.trim();
  if (data && ethers.isHexString(data)) {
    return {
      data,
      updateWithheldAmount: env.PHASE1A_UPDATE_WITHHELD_AMOUNT === "true",
    };
  }

  const target = env.PHASE1A_MAINTENANCE_TARGET?.trim();
  const amount = env.PHASE1A_MAINTENANCE_AMOUNT?.trim();
  const batchHash = env.PHASE1A_MAINTENANCE_BATCH_HASH?.trim();
  if (!target || !amount || !batchHash) {
    throw new Error(
      "Set PHASE1A_MAINTENANCE_DATA or provide PHASE1A_MAINTENANCE_TARGET, " +
        "PHASE1A_MAINTENANCE_AMOUNT, and PHASE1A_MAINTENANCE_BATCH_HASH.",
    );
  }
  if (!ethers.isAddress(target)) {
    throw new Error(`Invalid maintenance target: ${target}`);
  }
  if (!ethers.isHexString(batchHash, 32)) {
    throw new Error(`Invalid maintenance batch hash: ${batchHash}`);
  }

  return {
    data: ethers.AbiCoder.defaultAbiCoder().encode(
      ["address[]", "uint256[]", "bytes32"],
      [[target], [BigInt(amount)], batchHash],
    ),
    updateWithheldAmount: env.PHASE1A_UPDATE_WITHHELD_AMOUNT === "true",
  };
}

async function main() {
  const artifacts = loadPhase1aArtifactsFromDisk();
  const [signer] = await ethers.getSigners();
  const config = resolveMaintenanceConfig();
  const targetDispenser = new ethers.Contract(artifacts.targetDispenserL2, TARGET_DISPENSER_ABI, signer);

  console.log(`Signer:                ${signer.address}`);
  console.log(`Target dispenser:      ${artifacts.targetDispenserL2}`);
  console.log(`Update withheld flag:  ${config.updateWithheldAmount}`);
  console.log(`Maintenance data:      ${config.data}`);

  const tx = await targetDispenser.processDataMaintenance(config.data, config.updateWithheldAmount);
  console.log(`Maintenance tx:        ${tx.hash}`);
  await tx.wait();
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
