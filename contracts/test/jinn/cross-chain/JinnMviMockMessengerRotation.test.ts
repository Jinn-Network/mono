import { expect } from "chai";
import { network } from "hardhat";

import {
  FAST_TEST_GOVERNANCE_CONFIG,
  LOCKED_DISTRIBUTOR_INITIAL_CONFIG,
} from "../../../scripts/lib/jinn-mvi-helpers.js";
import { deployJinnMviL1 } from "../../../scripts/deploy-jinn-mvi-l1.js";
import {
  applyMockMessengerRotationArtifact,
  rotateJinnMviMockMessenger,
} from "../../../scripts/rotate-jinn-mvi-mock-messenger.js";

const DISTRIBUTOR_FQN = "src/jinn/distribution/JinnDistributor.sol:JinnDistributor";
const MOCK_MESSENGER_FQN = "src/jinn/cross-chain/MockMessenger.sol:MockMessenger";

describe("JINN MVI mock messenger rotation", function () {
  this.timeout(120_000);

  let ethers: Awaited<ReturnType<typeof network.connect>>["ethers"];

  before(async function () {
    ({ ethers } = await network.connect());
  });

  it("deploys a new MockMessenger and points the distributor at it", async function () {
    const [deployer, relayerOwner] = await ethers.getSigners();
    const deployment = await deployJinnMviL1(ethers, deployer, FAST_TEST_GOVERNANCE_CONFIG, {
      messenger: { mode: "mock" },
      distributorConfig: { ...LOCKED_DISTRIBUTOR_INITIAL_CONFIG },
      renounceAdmin: false,
    });

    const rotation = await rotateJinnMviMockMessenger(ethers, deployer, {
      distributorAddress: deployment.distributor,
      messengerOwner: relayerOwner.address,
      rotatedAt: "2026-05-20T00:00:00.000Z",
    });

    expect(rotation.previousMessenger).to.equal(deployment.messenger);
    expect(rotation.newMessenger).to.not.equal(deployment.messenger);
    expect(rotation.owner).to.equal(relayerOwner.address);
    expect(rotation.distributor).to.equal(deployment.distributor);

    const distributor = await ethers.getContractAt(
      DISTRIBUTOR_FQN,
      deployment.distributor,
    );
    const messenger = await ethers.getContractAt(
      MOCK_MESSENGER_FQN,
      rotation.newMessenger,
    );

    expect(await distributor.messenger()).to.equal(rotation.newMessenger);
    expect(await messenger.owner()).to.equal(relayerOwner.address);
  });

  it("updates the L1 artifact to the rotated messenger without losing existing addresses", function () {
    const artifact = {
      network: "sepolia",
      contracts: {
        JINN: "0x0bc0B2f733bF4229FD58Baaac5ebFEf2AEc83C4A",
        JinnDistributor: "0xaC9CD847660d05e77D82A3684aFC4EbFd94fBfe6",
        Messenger: "0x30E2f1A5691a999053A54e8DAf9496CD7ccF2DFD",
      },
      messenger: {
        mode: "mock",
        address: "0x30E2f1A5691a999053A54e8DAf9496CD7ccF2DFD",
        owner: "0x34516dB851f03f8E14d0c1cD56200175e914cCf0",
      },
    };
    const updated = applyMockMessengerRotationArtifact(artifact, {
      previousMessenger: "0x30E2f1A5691a999053A54e8DAf9496CD7ccF2DFD",
      newMessenger: "0x1111111111111111111111111111111111111111",
      owner: "0x2222222222222222222222222222222222222222",
      distributor: "0xaC9CD847660d05e77D82A3684aFC4EbFd94fBfe6",
      deployTxHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      setMessengerTxHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      blockNumber: 123,
      rotatedAt: "2026-05-20T00:00:00.000Z",
    });

    expect(updated.contracts).to.deep.include({
      JINN: "0x0bc0B2f733bF4229FD58Baaac5ebFEf2AEc83C4A",
      JinnDistributor: "0xaC9CD847660d05e77D82A3684aFC4EbFd94fBfe6",
      Messenger: "0x1111111111111111111111111111111111111111",
      MockMessenger: "0x1111111111111111111111111111111111111111",
    });
    expect(updated.messenger).to.deep.include({
      mode: "mock",
      address: "0x1111111111111111111111111111111111111111",
      owner: "0x2222222222222222222222222222222222222222",
      previousAddress: "0x30E2f1A5691a999053A54e8DAf9496CD7ccF2DFD",
      rotatedAt: "2026-05-20T00:00:00.000Z",
    });
    expect(updated.rotations).to.have.length(1);
  });
});
