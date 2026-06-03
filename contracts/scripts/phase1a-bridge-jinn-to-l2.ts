import { network } from "hardhat";
import { ethers } from "ethers";
import { loadPhase1aArtifactsFromDisk } from "./lib/phase1a-rollout-helpers.js";
import { isRunEntry } from "./lib/run-entry.js";

interface BridgeToL2Config {
  recipient: string;
  amount: bigint;
  minGasLimit: bigint;
}

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

const L1_STANDARD_BRIDGE_ABI = [
  "function depositERC20To(address localToken, address remoteToken, address to, uint256 amount, uint32 minGasLimit, bytes extraData)",
];

export function resolveBridgeToL2Config(
  signerAddress: string,
  env: Record<string, string | undefined> = process.env,
): BridgeToL2Config {
  const recipient = env.PHASE1A_BRIDGE_RECIPIENT?.trim() ?? signerAddress;
  if (!ethers.isAddress(recipient)) {
    throw new Error(`Invalid PHASE1A_BRIDGE_RECIPIENT: ${recipient}`);
  }

  const amount = env.PHASE1A_BRIDGE_AMOUNT?.trim();
  if (!amount) {
    throw new Error("Set PHASE1A_BRIDGE_AMOUNT to the L1 JINN amount to bridge.");
  }

  const minGasLimit = BigInt(env.PHASE1A_BRIDGE_MIN_GAS_LIMIT?.trim() ?? "300000");
  return {
    recipient,
    amount: BigInt(amount),
    minGasLimit,
  };
}

async function main() {
  const { ethers: hh } = await network.connect();
  const artifacts = loadPhase1aArtifactsFromDisk();
  const [signer] = await hh.getSigners();
  const config = resolveBridgeToL2Config(signer.address);
  const bridgeAddress = process.env.L1_STANDARD_BRIDGE_PROXY ?? "0xfd0Bf71F60660E2f608ed56e1659C450eB113120";

  const l1Token = new ethers.Contract(artifacts.l1Jinn, ERC20_ABI, signer);
  const bridge = new ethers.Contract(bridgeAddress, L1_STANDARD_BRIDGE_ABI, signer);

  const [balance, allowance] = (await Promise.all([
    l1Token.balanceOf(signer.address) as Promise<bigint>,
    l1Token.allowance(signer.address, bridgeAddress) as Promise<bigint>,
  ])) as [bigint, bigint];

  console.log(`Signer:        ${signer.address}`);
  console.log(`Bridge:        ${bridgeAddress}`);
  console.log(`L1 JINN:       ${artifacts.l1Jinn}`);
  console.log(`L2 JINN:       ${artifacts.jinnL2}`);
  console.log(`Recipient:     ${config.recipient}`);
  console.log(`Amount:        ${ethers.formatEther(config.amount)} JINN`);
  console.log(`Min gas limit: ${config.minGasLimit}`);
  console.log(`L1 balance:    ${ethers.formatEther(balance)} JINN`);

  if (balance < config.amount) {
    throw new Error(`Signer only has ${balance} JINN on L1 but needs ${config.amount}.`);
  }

  if (allowance < config.amount) {
    const approveTx = await l1Token.approve(bridgeAddress, config.amount);
    console.log(`Approve tx:    ${approveTx.hash}`);
    await approveTx.wait();
  }

  const tx = await bridge.depositERC20To(
    artifacts.l1Jinn,
    artifacts.jinnL2,
    config.recipient,
    config.amount,
    Number(config.minGasLimit),
    "0x",
  );
  console.log(`Bridge tx:     ${tx.hash}`);
  await tx.wait();
}

if (isRunEntry(import.meta.url)) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
