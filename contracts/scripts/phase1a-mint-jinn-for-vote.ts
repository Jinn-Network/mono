import { ethers } from "hardhat";
import { loadJson, resolvePhase1aArtifactPaths } from "./lib/phase1a-rollout-helpers";

interface DeploymentArtifact {
  contracts: Record<string, string | undefined>;
}

interface MintForVoteConfig {
  jinn: string;
  treasury: string;
  recipient: string;
  amount: bigint;
}

const JINN_ABI = [
  "function owner() view returns (address)",
  "function minter() view returns (address)",
  "function changeMinter(address newMinter)",
  "function mint(address account, uint256 amount)",
];

function requireAddress(value: string | undefined, label: string): string {
  if (!value || !ethers.isAddress(value)) {
    throw new Error(`Invalid address for ${label}: ${value}`);
  }
  return value;
}

export function resolveMintForVoteConfig(
  deployment: DeploymentArtifact,
  signerAddress: string,
  env: Record<string, string | undefined> = process.env,
): MintForVoteConfig {
  const amount = env.PHASE1A_VOTE_MINT_AMOUNT?.trim() ?? ethers.parseEther("100").toString();
  return {
    jinn: requireAddress(env.JINN_TOKEN_L1 ?? deployment.contracts.JINN, "JINN"),
    treasury: requireAddress(deployment.contracts.Treasury, "Treasury"),
    recipient: requireAddress(env.PHASE1A_VOTE_RECIPIENT ?? signerAddress, "vote recipient"),
    amount: BigInt(amount),
  };
}

async function main() {
  const paths = resolvePhase1aArtifactPaths();
  const deployment = loadJson<DeploymentArtifact>(paths.l1);
  const [signer] = await ethers.getSigners();
  const config = resolveMintForVoteConfig(deployment, signer.address);
  const jinn = new ethers.Contract(config.jinn, JINN_ABI, signer);

  const [owner, minter] = (await Promise.all([
    jinn.owner() as Promise<string>,
    jinn.minter() as Promise<string>,
  ])) as [string, string];

  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`Signer ${signer.address} is not the JINN owner ${owner}.`);
  }

  console.log(`Signer:      ${signer.address}`);
  console.log(`JINN:        ${config.jinn}`);
  console.log(`Treasury:    ${config.treasury}`);
  console.log(`Recipient:   ${config.recipient}`);
  console.log(`Amount:      ${ethers.formatEther(config.amount)} JINN`);
  console.log(`Owner:       ${owner}`);
  console.log(`Minter:      ${minter}`);

  const restoreMinter = minter.toLowerCase() !== signer.address.toLowerCase();
  if (restoreMinter) {
    const setMinterTx = await jinn.changeMinter(signer.address);
    console.log(`Set minter tx: ${setMinterTx.hash}`);
    await setMinterTx.wait();
  }

  try {
    const mintTx = await jinn.mint(config.recipient, config.amount);
    console.log(`Mint tx:       ${mintTx.hash}`);
    await mintTx.wait();
  } finally {
    if (restoreMinter) {
      const restoreTx = await jinn.changeMinter(config.treasury);
      console.log(`Restore tx:    ${restoreTx.hash}`);
      await restoreTx.wait();
    }
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
