/**
 * Bridge.test.ts — Configuration tests for OptimismDepositProcessorL1 and
 * OptimismTargetDispenserL2.
 *
 * These tests verify that the bridge contracts deploy correctly and that all
 * immutable constructor params are stored and readable via public getters.
 *
 * Actual cross-chain message passing (L1 → L2 → L1) cannot be tested in a
 * local Hardhat environment — that requires a live Sepolia ↔ Base Sepolia
 * setup with the OP Stack relayer running. This suite covers deployment
 * configuration only.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import type { Signer } from "ethers";
import {
  deployBridgeContracts,
  BridgeDeployConfig,
  BridgeDeployment,
} from "../../scripts/deploy-phase1a-bridge";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return a fresh random address (non-zero, not a real contract). */
function fakeAddr(): string {
  return ethers.Wallet.createRandom().address;
}

// ---------------------------------------------------------------------------
// Shared test fixture
// ---------------------------------------------------------------------------

describe("Bridge Deployment Configuration", function () {
  // Compilation + 5 deployments — generous timeout
  this.timeout(120_000);

  let deployer: Signer;

  // Config values we'll verify in tests
  let jinnL1: string;
  let jinnL2: string;
  let dispenserL1: string;
  let stakingFactoryL2: string;
  let l1TokenRelayer: string;
  let l1MessageRelayer: string;
  let l2MessageRelayer: string;
  const l2ChainId = 84532; // Base Sepolia
  const l1ChainId = 11155111; // Sepolia

  let config: BridgeDeployConfig;
  let deployment: BridgeDeployment;

  before(async function () {
    [deployer] = await ethers.getSigners();

    // Use random addresses as stand-ins for external contracts
    // (the bridge contracts only store them as immutables — they don't call
    // them during construction, so no stub contracts are needed)
    jinnL1 = fakeAddr();
    jinnL2 = fakeAddr();
    dispenserL1 = fakeAddr();
    stakingFactoryL2 = fakeAddr();
    l1TokenRelayer = fakeAddr();
    l1MessageRelayer = fakeAddr();
    l2MessageRelayer = fakeAddr();

    config = {
      jinnL1,
      jinnL2,
      dispenserL1,
      stakingFactoryL2,
      l1TokenRelayer,
      l1MessageRelayer,
      l2MessageRelayer,
      l2ChainId,
      l1ChainId,
    };

    deployment = await deployBridgeContracts(deployer, config);
  });

  // =========================================================================
  // Deployment sanity
  // =========================================================================

  describe("Deployment", function () {
    it("deploys both contracts to non-zero addresses", function () {
      expect(deployment.depositProcessorL1).to.not.equal(ethers.ZeroAddress);
      expect(deployment.targetDispenserL2).to.not.equal(ethers.ZeroAddress);
    });

    it("deploys contracts to distinct addresses", function () {
      expect(deployment.depositProcessorL1).to.not.equal(deployment.targetDispenserL2);
    });
  });

  // =========================================================================
  // OptimismDepositProcessorL1 — constructor params
  // =========================================================================

  describe("OptimismDepositProcessorL1 constructor params", function () {
    it("stores JINN L1 token address (olas)", async function () {
      const processor = await ethers.getContractAt(
        "OptimismDepositProcessorL1",
        deployment.depositProcessorL1
      );
      expect(await processor.olas()).to.equal(jinnL1);
    });

    it("stores L1 Dispenser address (l1Dispenser)", async function () {
      const processor = await ethers.getContractAt(
        "OptimismDepositProcessorL1",
        deployment.depositProcessorL1
      );
      expect(await processor.l1Dispenser()).to.equal(dispenserL1);
    });

    it("stores L1StandardBridgeProxy address (l1TokenRelayer)", async function () {
      const processor = await ethers.getContractAt(
        "OptimismDepositProcessorL1",
        deployment.depositProcessorL1
      );
      expect(await processor.l1TokenRelayer()).to.equal(l1TokenRelayer);
    });

    it("stores L1CrossDomainMessengerProxy address (l1MessageRelayer)", async function () {
      const processor = await ethers.getContractAt(
        "OptimismDepositProcessorL1",
        deployment.depositProcessorL1
      );
      expect(await processor.l1MessageRelayer()).to.equal(l1MessageRelayer);
    });

    it("stores Base Sepolia chain ID (l2TargetChainId)", async function () {
      const processor = await ethers.getContractAt(
        "OptimismDepositProcessorL1",
        deployment.depositProcessorL1
      );
      expect(await processor.l2TargetChainId()).to.equal(l2ChainId);
    });

    it("stores JINN L2 token address (olasL2)", async function () {
      const processor = await ethers.getContractAt(
        "OptimismDepositProcessorL1",
        deployment.depositProcessorL1
      );
      expect(await processor.olasL2()).to.equal(jinnL2);
    });

    it("stores L2 target dispenser after setL2TargetDispenser", async function () {
      const processor = await ethers.getContractAt(
        "OptimismDepositProcessorL1",
        deployment.depositProcessorL1
      );
      expect(await processor.l2TargetDispenser()).to.equal(
        deployment.targetDispenserL2
      );
    });

    it("owner is zero after setL2TargetDispenser (immutable config enforced)", async function () {
      const processor = await ethers.getContractAt(
        "OptimismDepositProcessorL1",
        deployment.depositProcessorL1
      );
      // setL2TargetDispenser revokes ownership by zeroing the owner slot
      expect(await processor.owner()).to.equal(ethers.ZeroAddress);
    });

    it("BRIDGE_PAYLOAD_LENGTH is 32", async function () {
      const processor = await ethers.getContractAt(
        "OptimismDepositProcessorL1",
        deployment.depositProcessorL1
      );
      expect(await processor.BRIDGE_PAYLOAD_LENGTH()).to.equal(32);
    });

    it("stakingBatchNonce starts at 0", async function () {
      const processor = await ethers.getContractAt(
        "OptimismDepositProcessorL1",
        deployment.depositProcessorL1
      );
      expect(await processor.stakingBatchNonce()).to.equal(0);
    });
  });

  // =========================================================================
  // OptimismTargetDispenserL2 — constructor params
  // =========================================================================

  describe("OptimismTargetDispenserL2 constructor params", function () {
    it("stores JINN L2 token address (olas)", async function () {
      const dispenser = await ethers.getContractAt(
        "OptimismTargetDispenserL2",
        deployment.targetDispenserL2
      );
      expect(await dispenser.olas()).to.equal(jinnL2);
    });

    it("stores StakingFactory address (stakingFactory)", async function () {
      const dispenser = await ethers.getContractAt(
        "OptimismTargetDispenserL2",
        deployment.targetDispenserL2
      );
      expect(await dispenser.stakingFactory()).to.equal(stakingFactoryL2);
    });

    it("stores L2CrossDomainMessengerProxy address (l2MessageRelayer)", async function () {
      const dispenser = await ethers.getContractAt(
        "OptimismTargetDispenserL2",
        deployment.targetDispenserL2
      );
      expect(await dispenser.l2MessageRelayer()).to.equal(l2MessageRelayer);
    });

    it("stores L1 deposit processor address (l1DepositProcessor)", async function () {
      const dispenser = await ethers.getContractAt(
        "OptimismTargetDispenserL2",
        deployment.targetDispenserL2
      );
      expect(await dispenser.l1DepositProcessor()).to.equal(
        deployment.depositProcessorL1
      );
    });

    it("stores Sepolia chain ID (l1SourceChainId)", async function () {
      const dispenser = await ethers.getContractAt(
        "OptimismTargetDispenserL2",
        deployment.targetDispenserL2
      );
      expect(await dispenser.l1SourceChainId()).to.equal(l1ChainId);
    });

    it("BRIDGE_PAYLOAD_LENGTH is 32", async function () {
      const dispenser = await ethers.getContractAt(
        "OptimismTargetDispenserL2",
        deployment.targetDispenserL2
      );
      expect(await dispenser.BRIDGE_PAYLOAD_LENGTH()).to.equal(32);
    });

    it("paused starts at 1 (unpaused)", async function () {
      const dispenser = await ethers.getContractAt(
        "OptimismTargetDispenserL2",
        deployment.targetDispenserL2
      );
      // DefaultTargetDispenserL2 sets paused = 1 in constructor
      expect(await dispenser.paused()).to.equal(1);
    });

    it("withheldAmount starts at 0", async function () {
      const dispenser = await ethers.getContractAt(
        "OptimismTargetDispenserL2",
        deployment.targetDispenserL2
      );
      expect(await dispenser.withheldAmount()).to.equal(0);
    });

    it("stakingBatchNonce starts at 0", async function () {
      const dispenser = await ethers.getContractAt(
        "OptimismTargetDispenserL2",
        deployment.targetDispenserL2
      );
      expect(await dispenser.stakingBatchNonce()).to.equal(0);
    });

    it("owner is the deployer", async function () {
      const dispenser = await ethers.getContractAt(
        "OptimismTargetDispenserL2",
        deployment.targetDispenserL2
      );
      const deployerAddress = await deployer.getAddress();
      expect(await dispenser.owner()).to.equal(deployerAddress);
    });
  });

  // =========================================================================
  // Constants
  // =========================================================================

  describe("Shared constants", function () {
    it("L1 processor TOKEN_GAS_LIMIT is 300_000", async function () {
      const processor = await ethers.getContractAt(
        "OptimismDepositProcessorL1",
        deployment.depositProcessorL1
      );
      expect(await processor.TOKEN_GAS_LIMIT()).to.equal(300_000);
    });

    it("L1 processor MESSAGE_GAS_LIMIT is 2_000_000", async function () {
      const processor = await ethers.getContractAt(
        "OptimismDepositProcessorL1",
        deployment.depositProcessorL1
      );
      expect(await processor.MESSAGE_GAS_LIMIT()).to.equal(2_000_000);
    });

    it("L2 dispenser MIN_GAS_LIMIT is 300_000", async function () {
      const dispenser = await ethers.getContractAt(
        "OptimismTargetDispenserL2",
        deployment.targetDispenserL2
      );
      expect(await dispenser.MIN_GAS_LIMIT()).to.equal(300_000);
    });

    it("L2 dispenser MAX_GAS_LIMIT is 2_000_000", async function () {
      const dispenser = await ethers.getContractAt(
        "OptimismTargetDispenserL2",
        deployment.targetDispenserL2
      );
      expect(await dispenser.MAX_GAS_LIMIT()).to.equal(2_000_000);
    });

    it("getBridgingDecimals returns 18 on L1 processor", async function () {
      const processor = await ethers.getContractAt(
        "OptimismDepositProcessorL1",
        deployment.depositProcessorL1
      );
      expect(await processor.getBridgingDecimals()).to.equal(18);
    });

    it("getBridgingDecimals returns 18 on L2 dispenser", async function () {
      const dispenser = await ethers.getContractAt(
        "OptimismTargetDispenserL2",
        deployment.targetDispenserL2
      );
      expect(await dispenser.getBridgingDecimals()).to.equal(18);
    });
  });

  // =========================================================================
  // Cross-linking verification
  // =========================================================================

  describe("L1 ↔ L2 cross-linking", function () {
    it("L1 processor l2TargetDispenser matches L2 dispenser address", async function () {
      const processor = await ethers.getContractAt(
        "OptimismDepositProcessorL1",
        deployment.depositProcessorL1
      );
      expect(await processor.l2TargetDispenser()).to.equal(
        deployment.targetDispenserL2
      );
    });

    it("L2 dispenser l1DepositProcessor matches L1 processor address", async function () {
      const dispenser = await ethers.getContractAt(
        "OptimismTargetDispenserL2",
        deployment.targetDispenserL2
      );
      expect(await dispenser.l1DepositProcessor()).to.equal(
        deployment.depositProcessorL1
      );
    });
  });

  // =========================================================================
  // Constructor guard: zero address rejection
  // =========================================================================

  describe("Constructor zero-address guards", function () {
    it("L1 processor reverts if olasL2 is zero", async function () {
      const DepositProcessor = await ethers.getContractFactory(
        "OptimismDepositProcessorL1",
        deployer
      );
      await expect(
        DepositProcessor.deploy(
          jinnL1,
          dispenserL1,
          l1TokenRelayer,
          l1MessageRelayer,
          l2ChainId,
          ethers.ZeroAddress // _olasL2 = zero
        )
      ).to.be.reverted;
    });

    it("L1 processor reverts if l1Dispenser is zero", async function () {
      const DepositProcessor = await ethers.getContractFactory(
        "OptimismDepositProcessorL1",
        deployer
      );
      await expect(
        DepositProcessor.deploy(
          jinnL1,
          ethers.ZeroAddress, // _l1Dispenser = zero
          l1TokenRelayer,
          l1MessageRelayer,
          l2ChainId,
          jinnL2
        )
      ).to.be.reverted;
    });

    it("L2 dispenser reverts if olas is zero", async function () {
      const TargetDispenser = await ethers.getContractFactory(
        "OptimismTargetDispenserL2",
        deployer
      );
      await expect(
        TargetDispenser.deploy(
          ethers.ZeroAddress, // _olas = zero
          stakingFactoryL2,
          l2MessageRelayer,
          deployment.depositProcessorL1,
          l1ChainId
        )
      ).to.be.reverted;
    });

    it("L2 dispenser reverts if proxyFactory is zero", async function () {
      const TargetDispenser = await ethers.getContractFactory(
        "OptimismTargetDispenserL2",
        deployer
      );
      await expect(
        TargetDispenser.deploy(
          jinnL2,
          ethers.ZeroAddress, // _proxyFactory = zero
          l2MessageRelayer,
          deployment.depositProcessorL1,
          l1ChainId
        )
      ).to.be.reverted;
    });

    it("L2 dispenser reverts if l1SourceChainId is zero", async function () {
      const TargetDispenser = await ethers.getContractFactory(
        "OptimismTargetDispenserL2",
        deployer
      );
      await expect(
        TargetDispenser.deploy(
          jinnL2,
          stakingFactoryL2,
          l2MessageRelayer,
          deployment.depositProcessorL1,
          0 // _l1SourceChainId = zero
        )
      ).to.be.reverted;
    });
  });

  // =========================================================================
  // setL2TargetDispenser access control
  // =========================================================================

  describe("setL2TargetDispenser access control", function () {
    it("reverts when called by non-owner (owner already zeroed)", async function () {
      const processor = await ethers.getContractAt(
        "OptimismDepositProcessorL1",
        deployment.depositProcessorL1
      );
      // Owner is already address(0) after deployBridgeContracts linked them
      const [, nonOwner] = await ethers.getSigners();
      await expect(
        processor.connect(nonOwner).setL2TargetDispenser(fakeAddr())
      ).to.be.reverted;
    });

    it("reverts if called a second time (owner is zero)", async function () {
      const processor = await ethers.getContractAt(
        "OptimismDepositProcessorL1",
        deployment.depositProcessorL1
      );
      // owner is address(0), so any signer is unauthorized
      await expect(
        processor.connect(deployer).setL2TargetDispenser(fakeAddr())
      ).to.be.reverted;
    });
  });
});
