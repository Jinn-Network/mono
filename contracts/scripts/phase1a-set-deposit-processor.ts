import { isRunEntry } from "./lib/run-entry.js";
import { network } from "hardhat";
import { ethers } from "ethers";
import {
  BASE_SEPOLIA_CHAIN_ID,
  loadPhase1aArtifactsFromDisk,
} from "./lib/phase1a-rollout-helpers.js";

const DISPENSER_ABI = [
  "function mapChainIdDepositProcessors(uint256) view returns (address)",
  "function setDepositProcessorChainIds(address[] depositProcessors, uint256[] chainIds)",
];

async function main() {
  const { ethers: hh } = await network.connect();
  const artifacts = loadPhase1aArtifactsFromDisk();
  const [signer] = await hh.getSigners();
  const dispenser = new ethers.Contract(artifacts.dispenserL1, DISPENSER_ABI, signer);

  const current = (await dispenser.mapChainIdDepositProcessors(BASE_SEPOLIA_CHAIN_ID)) as string;
  console.log(`Signer:                    ${signer.address}`);
  console.log(`Dispenser:                 ${artifacts.dispenserL1}`);
  console.log(`Base Sepolia chain id:     ${BASE_SEPOLIA_CHAIN_ID}`);
  console.log(`Current deposit processor: ${current}`);
  console.log(`Expected deposit processor:${artifacts.depositProcessorL1}`);

  if (current.toLowerCase() === artifacts.depositProcessorL1.toLowerCase()) {
    console.log("Dispenser already points Base Sepolia at the expected deposit processor.");
    return;
  }

  const tx = await dispenser.setDepositProcessorChainIds(
    [artifacts.depositProcessorL1],
    [BASE_SEPOLIA_CHAIN_ID],
  );
  console.log(`Submitted tx:              ${tx.hash}`);
  await tx.wait();

  const updated = (await dispenser.mapChainIdDepositProcessors(BASE_SEPOLIA_CHAIN_ID)) as string;
  console.log(`Updated deposit processor: ${updated}`);
}

if (isRunEntry(import.meta.url)) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
