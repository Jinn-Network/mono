/**
 * Tests for the Phase A3 JinnDistributor (src/jinn/distribution/JinnDistributor.sol).
 *
 * Covers:
 *   1. Deploy state
 *   2. Happy-path single claim
 *   3. Replay protection
 *   4. Increasing snapshots → mint the delta
 *   5. Decreasing snapshots → clamped to zero (accumulators sticky)
 *   6. Weight-change semantics
 *   7. Ratio-change semantics
 *   8. Messenger swap
 *   9. Setter access control + Ownable2Step handover
 *  10. Reentrancy regression (CEI ordering)
 *  11. Zero-multisig revert
 *  12. End-to-end JINN integration
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

const JINN_FQN = "src/jinn/token/JINN.sol:JINN";
const DISTRIBUTOR_FQN = "src/jinn/distribution/JinnDistributor.sol:JinnDistributor";
const MOCK_MESSENGER_FQN = "src/jinn/cross-chain/MockMessenger.sol:MockMessenger";
const REENTRANT_JINN_FQN =
  "src/jinn/distribution/DistributionTestMocks.sol:ReentrantMockJinn";

const ONE = 10n ** 18n;
const RATIO_OPERATOR = (ONE * 75n) / 100n; // 0.75e18
const RATIO_DAO = (ONE * 25n) / 100n; // 0.25e18

function encodeProof(serviceId: bigint): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [serviceId]);
}

async function deployFixture() {
  const [deployer, dao, alice, bob, carol, timelock, attacker] =
    await ethers.getSigners();

  // Real JINN token, deployer as owner.
  const Jinn = await ethers.getContractFactory(JINN_FQN);
  const jinn = await Jinn.deploy("Jinn", "JINN", deployer.address);
  await jinn.waitForDeployment();

  // Mock messenger.
  const MockMessenger = await ethers.getContractFactory(MOCK_MESSENGER_FQN);
  const messenger = await MockMessenger.deploy(deployer.address);
  await messenger.waitForDeployment();

  // Distributor.
  const Distributor = await ethers.getContractFactory(DISTRIBUTOR_FQN);
  const distributor = await Distributor.deploy(
    deployer.address, // initialOwner
    await jinn.getAddress(),
    dao.address, // daoTreasury
    await messenger.getAddress(),
    RATIO_OPERATOR,
    RATIO_DAO,
    1n, // wCreation
    1n, // wRestorationDelivery
    1n, // wEvaluationDelivery
  );
  await distributor.waitForDeployment();

  // Make the distributor the JINN minter for end-to-end mint paths.
  await jinn.connect(deployer).setMinter(await distributor.getAddress());

  return {
    deployer,
    dao,
    alice,
    bob,
    carol,
    timelock,
    attacker,
    jinn,
    messenger,
    distributor,
  };
}

describe("JinnDistributor (Phase A3)", function () {
  this.timeout(120_000);

  describe("Deploy state", function () {
    it("reflects all constructor args in storage and starts with zero supply", async function () {
      const { distributor, jinn, messenger, dao, deployer } =
        await loadFixture(deployFixture);

      expect(await distributor.owner()).to.equal(deployer.address);
      expect(await distributor.jinn()).to.equal(await jinn.getAddress());
      expect(await distributor.daoTreasury()).to.equal(dao.address);
      expect(await distributor.messenger()).to.equal(await messenger.getAddress());
      expect(await distributor.operatorRatio()).to.equal(RATIO_OPERATOR);
      expect(await distributor.daoRatio()).to.equal(RATIO_DAO);
      expect(await distributor.wCreation()).to.equal(1n);
      expect(await distributor.wRestorationDelivery()).to.equal(1n);
      expect(await distributor.wEvaluationDelivery()).to.equal(1n);

      expect(await jinn.totalSupply()).to.equal(0n);
    });

    it("reverts on zero address constructor args", async function () {
      const [deployer, dao] = await ethers.getSigners();
      const Distributor = await ethers.getContractFactory(DISTRIBUTOR_FQN);
      const Jinn = await ethers.getContractFactory(JINN_FQN);
      const jinn = await Jinn.deploy("Jinn", "JINN", deployer.address);
      const MockMessenger = await ethers.getContractFactory(MOCK_MESSENGER_FQN);
      const messenger = await MockMessenger.deploy(deployer.address);

      await expect(
        Distributor.deploy(
          deployer.address,
          ethers.ZeroAddress,
          dao.address,
          await messenger.getAddress(),
          RATIO_OPERATOR,
          RATIO_DAO,
          1n,
          1n,
          1n,
        ),
      ).to.be.revertedWithCustomError(
        { interface: Distributor.interface } as any,
        "ZeroAddress",
      );

      await expect(
        Distributor.deploy(
          deployer.address,
          await jinn.getAddress(),
          ethers.ZeroAddress,
          await messenger.getAddress(),
          RATIO_OPERATOR,
          RATIO_DAO,
          1n,
          1n,
          1n,
        ),
      ).to.be.revertedWithCustomError(
        { interface: Distributor.interface } as any,
        "ZeroAddress",
      );

      await expect(
        Distributor.deploy(
          deployer.address,
          await jinn.getAddress(),
          dao.address,
          ethers.ZeroAddress,
          RATIO_OPERATOR,
          RATIO_DAO,
          1n,
          1n,
          1n,
        ),
      ).to.be.revertedWithCustomError(
        { interface: Distributor.interface } as any,
        "ZeroAddress",
      );
    });
  });

  describe("Happy-path single claim", function () {
    it("mints operator + DAO shares and updates accumulators", async function () {
      const { distributor, messenger, jinn, alice, dao } =
        await loadFixture(deployFixture);
      const SERVICE_ID = 42n;

      await messenger.setFixture(SERVICE_ID, {
        serviceId: SERVICE_ID,
        verifiedCreations: 10n,
        noveltyWeightedRestorationDeliveries: 20n,
        evaluationDeliveryCount: 5n,
        multisig: alice.address,
      });

      // weighted = 1*10 + 1*20 + 1*5 = 35
      // entitledOperator = 35 * 0.75e18 / 1e18 = 26
      // entitledDao      = 35 * 0.25e18 / 1e18 =  8
      const weighted = 35n;
      const entitledOperator = (weighted * RATIO_OPERATOR) / ONE;
      const entitledDao = (weighted * RATIO_DAO) / ONE;
      expect(entitledOperator).to.equal(26n);
      expect(entitledDao).to.equal(8n);

      await expect(distributor.claim(encodeProof(SERVICE_ID)))
        .to.emit(distributor, "Claimed")
        .withArgs(
          SERVICE_ID,
          alice.address,
          entitledOperator,
          entitledDao,
          entitledOperator,
          entitledDao,
        );

      expect(await distributor.totalClaimedOperator(SERVICE_ID)).to.equal(
        entitledOperator,
      );
      expect(await distributor.totalClaimedDao(SERVICE_ID)).to.equal(entitledDao);

      expect(await jinn.balanceOf(alice.address)).to.equal(entitledOperator);
      expect(await jinn.balanceOf(dao.address)).to.equal(entitledDao);
      expect(await jinn.totalSupply()).to.equal(entitledOperator + entitledDao);
    });
  });

  describe("Replay protection", function () {
    it("treats a re-submitted proof as a no-op (no mint, no revert)", async function () {
      const { distributor, messenger, jinn, alice } =
        await loadFixture(deployFixture);
      const SERVICE_ID = 1n;

      await messenger.setFixture(SERVICE_ID, {
        serviceId: SERVICE_ID,
        verifiedCreations: 10n,
        noveltyWeightedRestorationDeliveries: 20n,
        evaluationDeliveryCount: 5n,
        multisig: alice.address,
      });

      await distributor.claim(encodeProof(SERVICE_ID));
      const supplyAfterFirst = await jinn.totalSupply();

      // Replay — should be a clean no-op.
      const tx = await distributor.claim(encodeProof(SERVICE_ID));
      const receipt = await tx.wait();

      expect(await jinn.totalSupply()).to.equal(supplyAfterFirst);
      // Replay should NOT emit Claimed (since both owedOperator & owedDao are 0).
      const claimedTopic = distributor.interface.getEvent("Claimed")!.topicHash;
      const hasClaimedLog = receipt!.logs.some(
        (l: any) => l.topics[0] === claimedTopic,
      );
      expect(hasClaimedLog).to.equal(false);
    });
  });

  describe("Increasing snapshots", function () {
    it("mints the delta when the same service's counters grow", async function () {
      const { distributor, messenger, jinn, alice, dao } =
        await loadFixture(deployFixture);
      const SERVICE_ID = 9n;

      // Snapshot A: weighted=35.
      await messenger.setFixture(SERVICE_ID, {
        serviceId: SERVICE_ID,
        verifiedCreations: 10n,
        noveltyWeightedRestorationDeliveries: 20n,
        evaluationDeliveryCount: 5n,
        multisig: alice.address,
      });
      await distributor.claim(encodeProof(SERVICE_ID));
      const operatorAfterA = await jinn.balanceOf(alice.address);
      const daoAfterA = await jinn.balanceOf(dao.address);

      // Snapshot B: weighted=100.
      await messenger.setFixture(SERVICE_ID, {
        serviceId: SERVICE_ID,
        verifiedCreations: 30n,
        noveltyWeightedRestorationDeliveries: 50n,
        evaluationDeliveryCount: 20n,
        multisig: alice.address,
      });
      await distributor.claim(encodeProof(SERVICE_ID));

      const weightedB = 100n;
      const entitledOperatorB = (weightedB * RATIO_OPERATOR) / ONE; // 75
      const entitledDaoB = (weightedB * RATIO_DAO) / ONE; // 25

      expect(await distributor.totalClaimedOperator(SERVICE_ID)).to.equal(
        entitledOperatorB,
      );
      expect(await distributor.totalClaimedDao(SERVICE_ID)).to.equal(entitledDaoB);

      // Operator + DAO each got the delta.
      expect(await jinn.balanceOf(alice.address)).to.equal(entitledOperatorB);
      expect(await jinn.balanceOf(dao.address)).to.equal(entitledDaoB);

      // Sanity check the delta direction.
      expect(await jinn.balanceOf(alice.address)).to.be.greaterThan(operatorAfterA);
      expect(await jinn.balanceOf(dao.address)).to.be.greaterThan(daoAfterA);
    });
  });

  describe("Decreasing snapshots", function () {
    it("clamps to zero and keeps accumulators sticky on a lower snapshot", async function () {
      const { distributor, messenger, jinn, alice, dao } =
        await loadFixture(deployFixture);
      const SERVICE_ID = 11n;

      // High snapshot first.
      await messenger.setFixture(SERVICE_ID, {
        serviceId: SERVICE_ID,
        verifiedCreations: 30n,
        noveltyWeightedRestorationDeliveries: 50n,
        evaluationDeliveryCount: 20n,
        multisig: alice.address,
      });
      await distributor.claim(encodeProof(SERVICE_ID));
      const supplyAfterHigh = await jinn.totalSupply();
      const opAccHigh = await distributor.totalClaimedOperator(SERVICE_ID);
      const daoAccHigh = await distributor.totalClaimedDao(SERVICE_ID);

      // Now a lower snapshot for the same service.
      await messenger.setFixture(SERVICE_ID, {
        serviceId: SERVICE_ID,
        verifiedCreations: 10n,
        noveltyWeightedRestorationDeliveries: 20n,
        evaluationDeliveryCount: 5n,
        multisig: alice.address,
      });
      await distributor.claim(encodeProof(SERVICE_ID));

      // No mint, accumulators unchanged.
      expect(await jinn.totalSupply()).to.equal(supplyAfterHigh);
      expect(await distributor.totalClaimedOperator(SERVICE_ID)).to.equal(opAccHigh);
      expect(await distributor.totalClaimedDao(SERVICE_ID)).to.equal(daoAccHigh);
      expect(await jinn.balanceOf(alice.address)).to.equal(opAccHigh);
      expect(await jinn.balanceOf(dao.address)).to.equal(daoAccHigh);
    });
  });

  describe("Weight-change semantics", function () {
    it("decrease → no unmint; subsequent growth resumes from high-water mark", async function () {
      const { distributor, messenger, jinn, alice, deployer } =
        await loadFixture(deployFixture);
      const SERVICE_ID = 21n;

      // First claim at default weights (1,1,1).
      await messenger.setFixture(SERVICE_ID, {
        serviceId: SERVICE_ID,
        verifiedCreations: 10n,
        noveltyWeightedRestorationDeliveries: 20n,
        evaluationDeliveryCount: 5n,
        multisig: alice.address,
      });
      await distributor.claim(encodeProof(SERVICE_ID));
      const supplyAfterFirst = await jinn.totalSupply();
      const opAcc1 = await distributor.totalClaimedOperator(SERVICE_ID);

      // Zero out wCreation. Same fixture: weighted drops from 35 → 25.
      // entitledOperator(B) = 25 * 0.75e18 / 1e18 = 18 < 26 → owed=0.
      await expect(
        distributor.connect(deployer).setWeights(0n, 1n, 1n),
      )
        .to.emit(distributor, "WeightsUpdated")
        .withArgs(0n, 1n, 1n);

      await distributor.claim(encodeProof(SERVICE_ID));
      expect(await jinn.totalSupply()).to.equal(supplyAfterFirst);
      expect(await distributor.totalClaimedOperator(SERVICE_ID)).to.equal(opAcc1);

      // Bump restoration so the weighted snapshot exceeds the high-water mark.
      // Need weighted >= ceil(opAcc1 * 1e18 / RATIO_OPERATOR).
      // opAcc1 = 26. minimum weighted to advance = ceil(26 / 0.75) = 35.
      // With wCreation=0, weighted = 1*restoration + 1*evalDelivery.
      // Set restoration=100, evalDelivery=5 → weighted=105.
      await messenger.setFixture(SERVICE_ID, {
        serviceId: SERVICE_ID,
        verifiedCreations: 10n, // ignored, wCreation=0
        noveltyWeightedRestorationDeliveries: 100n,
        evaluationDeliveryCount: 5n,
        multisig: alice.address,
      });

      await distributor.claim(encodeProof(SERVICE_ID));
      const weighted = 105n;
      const entitledOperator = (weighted * RATIO_OPERATOR) / ONE; // 78
      const entitledDao = (weighted * RATIO_DAO) / ONE; // 26

      expect(await distributor.totalClaimedOperator(SERVICE_ID)).to.equal(
        entitledOperator,
      );
      expect(await distributor.totalClaimedDao(SERVICE_ID)).to.equal(entitledDao);
      expect(await jinn.balanceOf(alice.address)).to.equal(entitledOperator);
    });
  });

  describe("Ratio-change semantics", function () {
    it("ratio decrease → no unmint; ratio increase → mint the delta", async function () {
      const { distributor, messenger, jinn, alice, dao, deployer } =
        await loadFixture(deployFixture);
      const SERVICE_ID = 31n;

      await messenger.setFixture(SERVICE_ID, {
        serviceId: SERVICE_ID,
        verifiedCreations: 10n,
        noveltyWeightedRestorationDeliveries: 20n,
        evaluationDeliveryCount: 5n,
        multisig: alice.address,
      });
      await distributor.claim(encodeProof(SERVICE_ID));
      const supplyAfterFirst = await jinn.totalSupply();
      const opAccBefore = await distributor.totalClaimedOperator(SERVICE_ID);
      const daoAccBefore = await distributor.totalClaimedDao(SERVICE_ID);

      // Decrease operator ratio to 0.50e18, DAO ratio to 0.10e18. Both
      // entitlements drop below the high-water mark → owed=0, no mint.
      await expect(
        distributor.connect(deployer).setRatios((ONE * 50n) / 100n, (ONE * 10n) / 100n),
      )
        .to.emit(distributor, "RatiosUpdated")
        .withArgs((ONE * 50n) / 100n, (ONE * 10n) / 100n);

      await distributor.claim(encodeProof(SERVICE_ID));
      expect(await jinn.totalSupply()).to.equal(supplyAfterFirst);
      expect(await distributor.totalClaimedOperator(SERVICE_ID)).to.equal(opAccBefore);
      expect(await distributor.totalClaimedDao(SERVICE_ID)).to.equal(daoAccBefore);

      // Increase operator ratio to 1.00e18 (and DAO to 0.50e18). Same
      // fixture, weighted=35, entitledOperator=35, entitledDao=17 →
      // delta is 35-26=9 operator, 17-8=9 DAO.
      await distributor.connect(deployer).setRatios(ONE, (ONE * 50n) / 100n);
      await distributor.claim(encodeProof(SERVICE_ID));

      const weighted = 35n;
      const entitledOperator = (weighted * ONE) / ONE; // 35
      const entitledDao = (weighted * ((ONE * 50n) / 100n)) / ONE; // 17

      expect(await distributor.totalClaimedOperator(SERVICE_ID)).to.equal(
        entitledOperator,
      );
      expect(await distributor.totalClaimedDao(SERVICE_ID)).to.equal(entitledDao);
      expect(await jinn.balanceOf(alice.address)).to.equal(entitledOperator);
      expect(await jinn.balanceOf(dao.address)).to.equal(entitledDao);
    });
  });

  describe("Messenger swap", function () {
    it("after setMessenger, claims see the new messenger's view", async function () {
      const { distributor, messenger, jinn, alice, deployer } =
        await loadFixture(deployFixture);
      const SERVICE_ID = 41n;

      // Original messenger: snapshot A (weighted=35).
      await messenger.setFixture(SERVICE_ID, {
        serviceId: SERVICE_ID,
        verifiedCreations: 10n,
        noveltyWeightedRestorationDeliveries: 20n,
        evaluationDeliveryCount: 5n,
        multisig: alice.address,
      });
      await distributor.claim(encodeProof(SERVICE_ID));
      const supplyAfterFirst = await jinn.totalSupply();

      // Deploy a second messenger with a HIGHER snapshot for the same serviceId.
      const MockMessenger = await ethers.getContractFactory(MOCK_MESSENGER_FQN);
      const messenger2 = await MockMessenger.deploy(deployer.address);
      await messenger2.waitForDeployment();
      await messenger2.setFixture(SERVICE_ID, {
        serviceId: SERVICE_ID,
        verifiedCreations: 30n,
        noveltyWeightedRestorationDeliveries: 50n,
        evaluationDeliveryCount: 20n,
        multisig: alice.address,
      });

      await expect(
        distributor.connect(deployer).setMessenger(await messenger2.getAddress()),
      )
        .to.emit(distributor, "MessengerUpdated")
        .withArgs(await messenger2.getAddress());

      // Claim now reads from messenger2 → weighted=100 → mint the delta.
      await distributor.claim(encodeProof(SERVICE_ID));

      const weighted = 100n;
      const entitledOperator = (weighted * RATIO_OPERATOR) / ONE; // 75
      const entitledDao = (weighted * RATIO_DAO) / ONE; // 25

      expect(await distributor.totalClaimedOperator(SERVICE_ID)).to.equal(
        entitledOperator,
      );
      expect(await distributor.totalClaimedDao(SERVICE_ID)).to.equal(entitledDao);
      expect(await jinn.totalSupply()).to.be.greaterThan(supplyAfterFirst);
    });

    it("messenger-swap to a LOWER-snapshot source does not unmint or rewind accumulators", async function () {
      const { distributor, messenger, jinn, alice, deployer } =
        await loadFixture(deployFixture);
      const SERVICE_ID = 43n;

      // Start on a high snapshot via the original messenger.
      await messenger.setFixture(SERVICE_ID, {
        serviceId: SERVICE_ID,
        verifiedCreations: 30n,
        noveltyWeightedRestorationDeliveries: 50n,
        evaluationDeliveryCount: 20n,
        multisig: alice.address,
      });
      await distributor.claim(encodeProof(SERVICE_ID));
      const supplyHigh = await jinn.totalSupply();
      const opAccHigh = await distributor.totalClaimedOperator(SERVICE_ID);
      const daoAccHigh = await distributor.totalClaimedDao(SERVICE_ID);

      // Swap in a messenger with a LOWER snapshot.
      const MockMessenger = await ethers.getContractFactory(MOCK_MESSENGER_FQN);
      const messenger2 = await MockMessenger.deploy(deployer.address);
      await messenger2.setFixture(SERVICE_ID, {
        serviceId: SERVICE_ID,
        verifiedCreations: 10n,
        noveltyWeightedRestorationDeliveries: 20n,
        evaluationDeliveryCount: 5n,
        multisig: alice.address,
      });
      await distributor.connect(deployer).setMessenger(await messenger2.getAddress());

      await distributor.claim(encodeProof(SERVICE_ID));
      // No-op: total supply and accumulators unchanged.
      expect(await jinn.totalSupply()).to.equal(supplyHigh);
      expect(await distributor.totalClaimedOperator(SERVICE_ID)).to.equal(opAccHigh);
      expect(await distributor.totalClaimedDao(SERVICE_ID)).to.equal(daoAccHigh);
    });
  });

  describe("Setter access control", function () {
    it("non-owner cannot call setMessenger / setRatios / setWeights", async function () {
      const { distributor, messenger, alice } = await loadFixture(deployFixture);

      await expect(
        distributor.connect(alice).setMessenger(await messenger.getAddress()),
      )
        .to.be.revertedWithCustomError(distributor, "OwnableUnauthorizedAccount")
        .withArgs(alice.address);

      await expect(distributor.connect(alice).setRatios(ONE, ONE))
        .to.be.revertedWithCustomError(distributor, "OwnableUnauthorizedAccount")
        .withArgs(alice.address);

      await expect(distributor.connect(alice).setWeights(2n, 3n, 4n))
        .to.be.revertedWithCustomError(distributor, "OwnableUnauthorizedAccount")
        .withArgs(alice.address);
    });

    it("setMessenger reverts on zero address", async function () {
      const { distributor, deployer } = await loadFixture(deployFixture);
      await expect(
        distributor.connect(deployer).setMessenger(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(distributor, "ZeroAddress");
    });

    it("after Ownable2Step transfer + accept, only the new owner can call setters", async function () {
      const { distributor, deployer, timelock, messenger, alice } =
        await loadFixture(deployFixture);

      // Pending transfer.
      await distributor.connect(deployer).transferOwnership(timelock.address);
      expect(await distributor.owner()).to.equal(deployer.address);
      expect(await distributor.pendingOwner()).to.equal(timelock.address);

      // Pending owner can't call setters yet.
      await expect(
        distributor.connect(timelock).setRatios(ONE, ONE),
      ).to.be.revertedWithCustomError(
        distributor,
        "OwnableUnauthorizedAccount",
      );

      // Old owner still can.
      await distributor.connect(deployer).setRatios(ONE, ONE);

      // Accept ownership.
      await distributor.connect(timelock).acceptOwnership();
      expect(await distributor.owner()).to.equal(timelock.address);

      // Old owner is locked out.
      await expect(
        distributor.connect(deployer).setRatios(ONE, ONE),
      ).to.be.revertedWithCustomError(
        distributor,
        "OwnableUnauthorizedAccount",
      );

      // New owner controls all three setters.
      await distributor.connect(timelock).setMessenger(await messenger.getAddress());
      await distributor.connect(timelock).setRatios(RATIO_OPERATOR, RATIO_DAO);
      await distributor.connect(timelock).setWeights(2n, 3n, 4n);
      expect(await distributor.wCreation()).to.equal(2n);
      expect(await distributor.wRestorationDelivery()).to.equal(3n);
      expect(await distributor.wEvaluationDelivery()).to.equal(4n);

      // alice still can't.
      await expect(
        distributor.connect(alice).setWeights(0n, 0n, 0n),
      ).to.be.revertedWithCustomError(
        distributor,
        "OwnableUnauthorizedAccount",
      );
    });
  });

  describe("Reentrancy regression", function () {
    it("CEI ordering: a reentrant claim() inside mint() observes the post-update accumulators and short-circuits", async function () {
      const [deployer, dao, alice] = await ethers.getSigners();
      const SERVICE_ID = 77n;

      const Reentrant = await ethers.getContractFactory(REENTRANT_JINN_FQN);
      const fakeJinn = await Reentrant.deploy();
      await fakeJinn.waitForDeployment();

      const MockMessenger = await ethers.getContractFactory(MOCK_MESSENGER_FQN);
      const messenger = await MockMessenger.deploy(deployer.address);
      await messenger.waitForDeployment();
      await messenger.setFixture(SERVICE_ID, {
        serviceId: SERVICE_ID,
        verifiedCreations: 10n,
        noveltyWeightedRestorationDeliveries: 20n,
        evaluationDeliveryCount: 5n,
        multisig: alice.address,
      });

      const Distributor = await ethers.getContractFactory(DISTRIBUTOR_FQN);
      const distributor = await Distributor.deploy(
        deployer.address,
        await fakeJinn.getAddress(),
        dao.address,
        await messenger.getAddress(),
        RATIO_OPERATOR,
        RATIO_DAO,
        1n,
        1n,
        1n,
      );
      await distributor.waitForDeployment();

      // Arm the fake JINN to re-enter the distributor on every mint.
      const proof = encodeProof(SERVICE_ID);
      await fakeJinn.setReentrancy(await distributor.getAddress(), proof);

      // Outer claim → mint(operator) → reentrant claim() (observes
      // updated operator accumulator, advances DAO accumulator, mints
      // DAO) → unwind back to the outer mint(DAO), which sees DAO
      // accumulator already updated and short-circuits.
      await distributor.claim(proof);

      const weighted = 35n;
      const entitledOperator = (weighted * RATIO_OPERATOR) / ONE;
      const entitledDao = (weighted * RATIO_DAO) / ONE;

      // Accumulators land on the entitled values exactly once.
      expect(await distributor.totalClaimedOperator(SERVICE_ID)).to.equal(
        entitledOperator,
      );
      expect(await distributor.totalClaimedDao(SERVICE_ID)).to.equal(entitledDao);

      // No double-mint: total minted equals entitledOperator + entitledDao.
      expect(await fakeJinn.totalMinted()).to.equal(entitledOperator + entitledDao);
      expect(await fakeJinn.balanceOf(alice.address)).to.equal(entitledOperator);
      expect(await fakeJinn.balanceOf(dao.address)).to.equal(entitledDao);
    });
  });

  describe("Zero-multisig revert", function () {
    it("reverts when the messenger surfaces a zero multisig", async function () {
      const [deployer, dao] = await ethers.getSigners();

      // Build a custom messenger that returns multisig=0 for serviceId=0.
      // We can't use MockMessenger here because its setFixture refuses
      // multisig=0. Instead, use a plain bytes-decode messenger written
      // inline as a factory-deployed contract.
      const ZeroMsgFactory = await ethers.getContractFactory(
        "ZeroMultisigMessenger",
      );
      const zeroMsg = await ZeroMsgFactory.deploy();
      await zeroMsg.waitForDeployment();

      const Jinn = await ethers.getContractFactory(JINN_FQN);
      const jinn = await Jinn.deploy("Jinn", "JINN", deployer.address);

      const Distributor = await ethers.getContractFactory(DISTRIBUTOR_FQN);
      const distributor = await Distributor.deploy(
        deployer.address,
        await jinn.getAddress(),
        dao.address,
        await zeroMsg.getAddress(),
        RATIO_OPERATOR,
        RATIO_DAO,
        1n,
        1n,
        1n,
      );

      await expect(distributor.claim("0x")).to.be.revertedWithCustomError(
        distributor,
        "ZeroMultisig",
      );
    });
  });

  describe("ServiceId ↔ multisig binding (audit fix)", function () {
    it("first claim binds the multisig in serviceMultisig[serviceId]", async function () {
      const { distributor, messenger, alice } = await loadFixture(deployFixture);
      const SERVICE_ID = 51n;

      await messenger.setFixture(SERVICE_ID, {
        serviceId: SERVICE_ID,
        verifiedCreations: 10n,
        noveltyWeightedRestorationDeliveries: 20n,
        evaluationDeliveryCount: 5n,
        multisig: alice.address,
      });

      expect(await distributor.serviceMultisig(SERVICE_ID)).to.equal(
        ethers.ZeroAddress,
      );
      await distributor.claim(encodeProof(SERVICE_ID));
      expect(await distributor.serviceMultisig(SERVICE_ID)).to.equal(alice.address);
    });

    it("second claim with the same multisig succeeds (mints the delta)", async function () {
      const { distributor, messenger, jinn, alice } = await loadFixture(deployFixture);
      const SERVICE_ID = 52n;

      await messenger.setFixture(SERVICE_ID, {
        serviceId: SERVICE_ID,
        verifiedCreations: 10n,
        noveltyWeightedRestorationDeliveries: 20n,
        evaluationDeliveryCount: 5n,
        multisig: alice.address,
      });
      await distributor.claim(encodeProof(SERVICE_ID));

      // Same multisig, growing snapshot — should mint the delta and
      // leave the binding unchanged.
      await messenger.setFixture(SERVICE_ID, {
        serviceId: SERVICE_ID,
        verifiedCreations: 30n,
        noveltyWeightedRestorationDeliveries: 50n,
        evaluationDeliveryCount: 20n,
        multisig: alice.address,
      });
      await distributor.claim(encodeProof(SERVICE_ID));

      expect(await distributor.serviceMultisig(SERVICE_ID)).to.equal(alice.address);
      const weighted = 100n;
      expect(await jinn.balanceOf(alice.address)).to.equal(
        (weighted * RATIO_OPERATOR) / ONE,
      );
    });

    it("second claim with a rotated multisig reverts with ServiceMultisigChanged", async function () {
      const { distributor, messenger, alice, bob } = await loadFixture(deployFixture);
      const SERVICE_ID = 53n;

      await messenger.setFixture(SERVICE_ID, {
        serviceId: SERVICE_ID,
        verifiedCreations: 10n,
        noveltyWeightedRestorationDeliveries: 20n,
        evaluationDeliveryCount: 5n,
        multisig: alice.address,
      });
      await distributor.claim(encodeProof(SERVICE_ID));

      // Operator rotates the OLAS multisig from alice → bob. The
      // messenger now reports `multisig=bob` for the same serviceId.
      await messenger.setFixture(SERVICE_ID, {
        serviceId: SERVICE_ID,
        verifiedCreations: 30n,
        noveltyWeightedRestorationDeliveries: 50n,
        evaluationDeliveryCount: 20n,
        multisig: bob.address,
      });

      await expect(distributor.claim(encodeProof(SERVICE_ID)))
        .to.be.revertedWithCustomError(distributor, "ServiceMultisigChanged")
        .withArgs(SERVICE_ID, alice.address, bob.address);
    });

    it("does not bind the multisig when the recovered multisig is zero", async function () {
      // The ZeroMultisig revert fires BEFORE the binding write. This
      // keeps a poisoned messenger from accidentally pinning a
      // serviceId to address(0) (which would then forever revert
      // future legitimate claims).
      const [deployer, dao] = await ethers.getSigners();
      const ZeroMsgFactory = await ethers.getContractFactory(
        "ZeroMultisigMessenger",
      );
      const zeroMsg = await ZeroMsgFactory.deploy();
      await zeroMsg.waitForDeployment();

      const Jinn = await ethers.getContractFactory(JINN_FQN);
      const jinn = await Jinn.deploy("Jinn", "JINN", deployer.address);
      const Distributor = await ethers.getContractFactory(DISTRIBUTOR_FQN);
      const distributor = await Distributor.deploy(
        deployer.address,
        await jinn.getAddress(),
        dao.address,
        await zeroMsg.getAddress(),
        RATIO_OPERATOR,
        RATIO_DAO,
        1n,
        1n,
        1n,
      );

      await expect(distributor.claim("0x")).to.be.revertedWithCustomError(
        distributor,
        "ZeroMultisig",
      );
      // No state change — the binding remains unset.
      expect(await distributor.serviceMultisig(0n)).to.equal(ethers.ZeroAddress);
    });
  });

  describe("Parameter bounds (audit fix)", function () {
    it("setRatios reverts when operatorRatio > MAX_RATIO", async function () {
      const { distributor, deployer } = await loadFixture(deployFixture);
      const max = await distributor.MAX_RATIO();
      await expect(
        distributor.connect(deployer).setRatios(max + 1n, 0n),
      ).to.be.revertedWithCustomError(distributor, "RatioOutOfBounds");
    });

    it("setRatios reverts when daoRatio > MAX_RATIO", async function () {
      const { distributor, deployer } = await loadFixture(deployFixture);
      const max = await distributor.MAX_RATIO();
      await expect(
        distributor.connect(deployer).setRatios(0n, max + 1n),
      ).to.be.revertedWithCustomError(distributor, "RatioOutOfBounds");
    });

    it("setRatios accepts values exactly at MAX_RATIO", async function () {
      const { distributor, deployer } = await loadFixture(deployFixture);
      const max = await distributor.MAX_RATIO();
      await distributor.connect(deployer).setRatios(max, max);
      expect(await distributor.operatorRatio()).to.equal(max);
      expect(await distributor.daoRatio()).to.equal(max);
    });

    it("setWeights reverts when any weight > MAX_WEIGHT", async function () {
      const { distributor, deployer } = await loadFixture(deployFixture);
      const max = await distributor.MAX_WEIGHT();
      await expect(
        distributor.connect(deployer).setWeights(max + 1n, 0n, 0n),
      ).to.be.revertedWithCustomError(distributor, "WeightOutOfBounds");
      await expect(
        distributor.connect(deployer).setWeights(0n, max + 1n, 0n),
      ).to.be.revertedWithCustomError(distributor, "WeightOutOfBounds");
      await expect(
        distributor.connect(deployer).setWeights(0n, 0n, max + 1n),
      ).to.be.revertedWithCustomError(distributor, "WeightOutOfBounds");
    });

    it("setWeights accepts values exactly at MAX_WEIGHT", async function () {
      const { distributor, deployer } = await loadFixture(deployFixture);
      const max = await distributor.MAX_WEIGHT();
      await distributor.connect(deployer).setWeights(max, max, max);
      expect(await distributor.wCreation()).to.equal(max);
      expect(await distributor.wRestorationDelivery()).to.equal(max);
      expect(await distributor.wEvaluationDelivery()).to.equal(max);
    });

    it("setMessenger reverts when target has no deployed bytecode (EOA)", async function () {
      const { distributor, deployer, alice } = await loadFixture(deployFixture);
      // alice is an EOA — code.length == 0.
      await expect(
        distributor.connect(deployer).setMessenger(alice.address),
      ).to.be.revertedWithCustomError(distributor, "MessengerNotContract");
    });

    it("setMessenger still rejects address(0) before the code-presence check", async function () {
      const { distributor, deployer } = await loadFixture(deployFixture);
      await expect(
        distributor.connect(deployer).setMessenger(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(distributor, "ZeroAddress");
    });
  });

  describe("End-to-end JINN integration", function () {
    it("real JINN.setMinter + claim mints to the recovered multisig", async function () {
      const { distributor, messenger, jinn, alice, dao } =
        await loadFixture(deployFixture);
      const SERVICE_ID = 99n;

      // The fixture already wired distributor as JINN's minter.
      expect(await jinn.minter()).to.equal(await distributor.getAddress());

      await messenger.setFixture(SERVICE_ID, {
        serviceId: SERVICE_ID,
        verifiedCreations: 100n,
        noveltyWeightedRestorationDeliveries: 200n,
        evaluationDeliveryCount: 50n,
        multisig: alice.address,
      });

      const weighted = 350n;
      const entitledOperator = (weighted * RATIO_OPERATOR) / ONE; // 262
      const entitledDao = (weighted * RATIO_DAO) / ONE; // 87

      await distributor.claim(encodeProof(SERVICE_ID));

      expect(await jinn.balanceOf(alice.address)).to.equal(entitledOperator);
      expect(await jinn.balanceOf(dao.address)).to.equal(entitledDao);
      expect(await jinn.totalSupply()).to.equal(entitledOperator + entitledDao);
    });
  });
});
