import { isRunEntry } from "./lib/run-entry.js";
/**
 * rotate-jinn-mvi-mock-messenger.ts
 *
 * Testnet-only operational script for the fast JINN MVI claim path. It deploys
 * a fresh MockMessenger controlled by the relayer ops key, then points the
 * existing JinnDistributor at it. This avoids redeploying the token or
 * distributor when only the owner-controlled mock messenger needs to move.
 *
 * Usage:
 *   JINN_MVI_MOCK_MESSENGER_OWNER=0x... \
 *   yarn hardhat run scripts/rotate-jinn-mvi-mock-messenger.ts --network sepolia
 *
 * Env vars:
 *   JINN_MVI_MOCK_MESSENGER_OWNER     owner for the new MockMessenger;
 *                                     defaults to the deployer signer
 *   JINN_MVI_DISTRIBUTOR              optional distributor override; otherwise
 *                                     read from the existing deployment artifact
 *   JINN_MVI_L1_ARTIFACT_PATHS        optional comma-separated artifact paths to
 *                                     update; otherwise all known Sepolia L1
 *                                     artifacts that exist are updated
 */

import { network } from "hardhat";
import { ethers as ethersLib } from "ethers";
import * as fs from "fs";
import * as path from "path";
import {
  CHAIN_ID_HARDHAT,
  CHAIN_ID_SEPOLIA,
  assertChainIdAllowed,
} from "./lib/jinn-mvi-helpers.js";

type HardhatEthers = Awaited<ReturnType<typeof network.connect>>["ethers"];

const DISTRIBUTOR_FQN = "src/jinn/distribution/JinnDistributor.sol:JinnDistributor";
const MOCK_MESSENGER_FQN = "src/jinn/cross-chain/MockMessenger.sol:MockMessenger";

export interface MockMessengerRotation {
  previousMessenger: string;
  newMessenger: string;
  owner: string;
  distributor: string;
  deployTxHash: string;
  setMessengerTxHash: string;
  blockNumber: number;
  rotatedAt: string;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function pickAddress(root: unknown, paths: string[][]): string | undefined {
  for (const segments of paths) {
    let cursor: unknown = root;
    for (const segment of segments) {
      cursor = asRecord(cursor)[segment];
    }
    if (typeof cursor === "string" && ethersLib.isAddress(cursor)) {
      return ethersLib.getAddress(cursor);
    }
  }
  return undefined;
}

function defaultArtifactPaths(networkName: string): string[] {
  const contractsDir = process.cwd();
  const repoRoot = path.resolve(contractsDir, "..");
  const names = [
    `deployment-jinn-mvi-l1-${networkName}.json`,
    `deployment-jinn-mvi-l1-${networkName}-fast.json`,
  ];

  const candidates = [
    ...names.map((name) => path.resolve(contractsDir, name)),
    ...names.map((name) => path.resolve(repoRoot, "client", "deployments", name)),
  ];
  return [...new Set(candidates)].filter((candidate) => fs.existsSync(candidate));
}

function resolveArtifactPaths(networkName: string): string[] {
  const raw = process.env.JINN_MVI_L1_ARTIFACT_PATHS;
  if (raw && raw.trim() !== "") {
    return raw
      .split(",")
      .map((entry) => path.resolve(entry.trim()))
      .filter((entry) => entry !== "");
  }
  return defaultArtifactPaths(networkName);
}

function resolveDistributorAddress(artifactPaths: string[]): string {
  const override = process.env.JINN_MVI_DISTRIBUTOR;
  if (override) {
    if (!ethersLib.isAddress(override)) {
      throw new Error("JINN_MVI_DISTRIBUTOR must be an EVM address");
    }
    return ethersLib.getAddress(override);
  }

  for (const artifactPath of artifactPaths) {
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as unknown;
    const address = pickAddress(artifact, [
      ["contracts", "JinnDistributor"],
      ["JinnDistributor"],
      ["distributor", "address"],
      ["distributor"],
    ]);
    if (address) return address;
  }

  throw new Error(
    "Could not resolve JinnDistributor. Set JINN_MVI_DISTRIBUTOR or provide a deployment artifact.",
  );
}

function resolveMessengerOwner(deployer: string): string {
  const configured = process.env.JINN_MVI_MOCK_MESSENGER_OWNER;
  if (!configured || configured.trim() === "") return deployer;
  if (!ethersLib.isAddress(configured)) {
    throw new Error("JINN_MVI_MOCK_MESSENGER_OWNER must be an EVM address");
  }
  return ethersLib.getAddress(configured);
}

export function applyMockMessengerRotationArtifact(
  artifact: JsonRecord,
  rotation: MockMessengerRotation,
): JsonRecord {
  const next = JSON.parse(JSON.stringify(artifact)) as JsonRecord;
  const messenger = { ...asRecord(next.messenger) };
  messenger.mode = "mock";
  messenger.address = rotation.newMessenger;
  messenger.owner = rotation.owner;
  messenger.previousAddress = rotation.previousMessenger;
  messenger.rotatedAt = rotation.rotatedAt;
  messenger.deployTxHash = rotation.deployTxHash;
  messenger.setMessengerTxHash = rotation.setMessengerTxHash;
  messenger.rotationBlockNumber = rotation.blockNumber;
  next.messenger = messenger;

  const contracts = { ...asRecord(next.contracts) };
  contracts.Messenger = rotation.newMessenger;
  contracts.MockMessenger = rotation.newMessenger;
  next.contracts = contracts;

  const rotations = Array.isArray(next.rotations)
    ? [...next.rotations]
    : [];
  rotations.push({
    type: "mock-messenger",
    previousMessenger: rotation.previousMessenger,
    newMessenger: rotation.newMessenger,
    owner: rotation.owner,
    distributor: rotation.distributor,
    deployTxHash: rotation.deployTxHash,
    setMessengerTxHash: rotation.setMessengerTxHash,
    blockNumber: rotation.blockNumber,
    rotatedAt: rotation.rotatedAt,
  });
  next.rotations = rotations;
  return next;
}

function updateArtifacts(artifactPaths: string[], rotation: MockMessengerRotation): void {
  for (const artifactPath of artifactPaths) {
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as JsonRecord;
    const updated = applyMockMessengerRotationArtifact(artifact, rotation);
    fs.writeFileSync(artifactPath, JSON.stringify(updated, null, 2) + "\n");
    console.log(`Updated artifact: ${artifactPath}`);
  }
}

export async function rotateJinnMviMockMessenger(
  ethers: HardhatEthers,
  signer: import("ethers").Signer,
  options: {
    distributorAddress: string;
    messengerOwner: string;
    rotatedAt?: string;
  },
): Promise<MockMessengerRotation> {
  const deployerAddress = ethers.getAddress(await signer.getAddress());
  const ownerAddress = ethers.getAddress(options.messengerOwner);
  const distributorAddress = ethers.getAddress(options.distributorAddress);

  const distributor = await ethers.getContractAt(
    DISTRIBUTOR_FQN,
    distributorAddress,
    signer,
  );
  const currentOwner = ethers.getAddress(await distributor.owner());
  if (currentOwner !== deployerAddress) {
    throw new Error(
      `JinnDistributor.owner() ${currentOwner} does not match deployer ${deployerAddress}`,
    );
  }

  const previousMessenger = ethers.getAddress(await distributor.messenger());

  const MockMessenger = await ethers.getContractFactory(MOCK_MESSENGER_FQN, signer);
  const messenger = await MockMessenger.deploy(ownerAddress);
  const deployReceipt = await messenger.deploymentTransaction()?.wait();
  if (!deployReceipt) {
    throw new Error("MockMessenger deployment receipt was unavailable");
  }
  const newMessenger = ethers.getAddress(await messenger.getAddress());

  const setMessengerTx = await distributor.setMessenger(newMessenger);
  const setMessengerReceipt = await setMessengerTx.wait();
  if (!setMessengerReceipt) {
    throw new Error("JinnDistributor.setMessenger receipt was unavailable");
  }

  const [verifiedOwner, verifiedMessenger] = await Promise.all([
    messenger.owner(),
    distributor.messenger(),
  ]);
  if (ethers.getAddress(verifiedOwner) !== ownerAddress) {
    throw new Error("New MockMessenger owner verification failed");
  }
  if (ethers.getAddress(verifiedMessenger) !== newMessenger) {
    throw new Error("JinnDistributor messenger verification failed");
  }

  return {
    previousMessenger,
    newMessenger,
    owner: ownerAddress,
    distributor: distributorAddress,
    deployTxHash: deployReceipt.hash,
    setMessengerTxHash: setMessengerReceipt.hash,
    blockNumber: setMessengerReceipt.blockNumber,
    rotatedAt: options.rotatedAt ?? new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  const connection = await network.connect();
  const { ethers } = connection;
  const networkName = connection.networkName;
  const chain = await ethers.provider.getNetwork();
  const chainId = Number(chain.chainId);
  assertChainIdAllowed({
    chainId,
    allowed: [CHAIN_ID_HARDHAT, CHAIN_ID_SEPOLIA],
    scriptName: "rotate-jinn-mvi-mock-messenger",
  });

  const [deployer] = await ethers.getSigners();
  const deployerAddress = ethers.getAddress(deployer.address);
  const artifactPaths = resolveArtifactPaths(networkName);
  const distributorAddress = resolveDistributorAddress(artifactPaths);
  const messengerOwner = resolveMessengerOwner(deployerAddress);

  console.log(`Network: ${networkName} (${chainId})`);
  console.log(`Deployer: ${deployerAddress}`);
  console.log(`JinnDistributor: ${distributorAddress}`);
  console.log(`New MockMessenger owner: ${messengerOwner}`);

  const rotation = await rotateJinnMviMockMessenger(ethers, deployer, {
    distributorAddress,
    messengerOwner,
  });

  console.log(`Previous Messenger: ${rotation.previousMessenger}`);
  console.log(`New Messenger: ${rotation.newMessenger}`);
  console.log(`MockMessenger deploy tx: ${rotation.deployTxHash}`);
  console.log(`JinnDistributor.setMessenger tx: ${rotation.setMessengerTxHash}`);

  updateArtifacts(artifactPaths, rotation);
}

if (isRunEntry(import.meta.url)) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
