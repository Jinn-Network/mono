/**
 * Phase B' tests for RestorationActivityCheckerV2 + JinnRouterV2.
 *
 * Covers:
 *   1. C4 fix — recordActivity / recordActivityWithEvidence are router-only.
 *   2. ε creation gating — recordRestorationEvidence credits the creator only
 *      when the delivery passes the novelty test.
 *   3. C1 fix — evidenceHashes is a circular buffer bounded by comparisonWindow,
 *      and the Hamming similarity check still works against the bounded window.
 *   4. Router → checker creator flow — createRestorationJob from one address,
 *      claimDelivery from a different deliverer credits both correctly.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import type { Signer } from "ethers";

const DEFAULT_LIVENESS_RATIO = ethers.parseEther("0.001"); // 1e15
const DEFAULT_SIMILARITY_THRESHOLD = 64n;
const DEFAULT_DECAY_MULTIPLIER = 0n;
const DEFAULT_COMPARISON_WINDOW = 20n;

const NATIVE_PAYMENT_TYPE = "0xba699a34be8fe0e7725e93dcbce1701b0211a8ca61330aaeb8a05bf2ec7abed1";
const MARKETPLACE_FEE = 0;
const MIN_RESPONSE_TIMEOUT = 60;
const MAX_RESPONSE_TIMEOUT = 300;

function encodeMaxDeliveryRate(rate: bigint): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [rate]);
}

async function deployChecker(
  deployer: Signer,
  authorizedRouter: string,
  overrides?: { comparisonWindow?: bigint; similarityThreshold?: bigint; similarDecayMultiplier?: bigint },
) {
  const Checker = await ethers.getContractFactory("RestorationActivityCheckerV2", deployer);
  const checker = await Checker.deploy();
  await checker.waitForDeployment();
  await (await checker.initialize(
    DEFAULT_LIVENESS_RATIO,
    await deployer.getAddress(),
    overrides?.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD,
    overrides?.similarDecayMultiplier ?? DEFAULT_DECAY_MULTIPLIER,
    overrides?.comparisonWindow ?? DEFAULT_COMPARISON_WINDOW,
  )).wait();
  // Wire the test signer that will impersonate the router.
  await (await checker.setRouterAddresses(authorizedRouter, authorizedRouter)).wait();
  return checker;
}

describe("Phase B' — RestorationActivityCheckerV2 audit fixes & ε gating", function () {
  this.timeout(120_000);

  let deployer: Signer;
  let routerEoa: Signer; // signer that plays the role of the authorized router
  let attacker: Signer;
  let creatorSigner: Signer;
  let delivererSigner: Signer;
  let deployerAddress: string;
  let routerEoaAddress: string;
  let attackerAddress: string;
  let creatorAddress: string;
  let delivererAddress: string;

  before(async function () {
    [deployer, routerEoa, attacker, creatorSigner, delivererSigner] = await ethers.getSigners();
    deployerAddress = await deployer.getAddress();
    routerEoaAddress = await routerEoa.getAddress();
    attackerAddress = await attacker.getAddress();
    creatorAddress = await creatorSigner.getAddress();
    delivererAddress = await delivererSigner.getAddress();
  });

  // ===========================================================================
  // 1. C4 fix — recordActivity / recordActivityWithEvidence are router-only
  // ===========================================================================
  describe("C4 fix — router-only writes", function () {
    it("recordActivity reverts when sender is not authorizedRouter", async function () {
      const checker = await deployChecker(deployer, routerEoaAddress);
      const multisig = ethers.Wallet.createRandom().address;

      await expect(
        checker.connect(attacker).recordActivity(multisig, 0)
      ).to.be.revertedWithCustomError(checker, "UnauthorizedRouter");

      // Even the contract owner cannot write — only authorizedRouter can.
      await expect(
        checker.connect(deployer).recordActivity(multisig, 0)
      ).to.be.revertedWithCustomError(checker, "UnauthorizedRouter");
    });

    it("recordActivityWithEvidence reverts when sender is not authorizedRouter", async function () {
      const checker = await deployChecker(deployer, routerEoaAddress);
      const multisig = ethers.Wallet.createRandom().address;
      const evidence = ethers.id("evidence");

      await expect(
        checker.connect(attacker).recordActivityWithEvidence(multisig, 0, evidence)
      ).to.be.revertedWithCustomError(checker, "UnauthorizedRouter");

      await expect(
        checker.connect(deployer).recordActivityWithEvidence(multisig, 0, evidence)
      ).to.be.revertedWithCustomError(checker, "UnauthorizedRouter");
    });

    it("authorized router can call all three write methods successfully", async function () {
      const checker = await deployChecker(deployer, routerEoaAddress);
      const multisig = ethers.Wallet.createRandom().address;
      const evidence = ethers.id("router-evidence");

      // recordActivity
      await (await checker.connect(routerEoa).recordActivity(multisig, 0)).wait();
      expect(await checker.activityCounts(multisig)).to.equal(1n);

      // recordActivityWithEvidence
      await (await checker.connect(routerEoa).recordActivityWithEvidence(multisig, 1, evidence)).wait();
      expect(await checker.activityCounts(multisig)).to.equal(2n);

      // recordRestorationEvidence (creator = address(0), creator credit skipped)
      await (await checker.connect(routerEoa).recordRestorationEvidence(
        multisig,
        ethers.ZeroAddress,
        ethers.id("another-evidence"),
      )).wait();
      // noveltyWeightedCounts has 1e18 (recordActivity) + 1e18 (novel evidence) + 1e18 (third evidence)
      expect(await checker.noveltyWeightedCounts(multisig)).to.equal(ethers.parseEther("3"));
    });
  });

  // ===========================================================================
  // 2. ε creator credit
  // ===========================================================================
  describe("ε creation gating — recordRestorationEvidence credits creator", function () {
    it("novel evidence credits BOTH deliverer and creator with same weight", async function () {
      const checker = await deployChecker(deployer, routerEoaAddress);
      const multisig = ethers.Wallet.createRandom().address;
      const creator = ethers.Wallet.createRandom().address;

      const evidence = ethers.id("first-novel");
      await (await checker.connect(routerEoa).recordRestorationEvidence(
        multisig,
        creator,
        evidence,
      )).wait();

      expect(await checker.noveltyWeightedCounts(multisig)).to.equal(ethers.parseEther("1"));
      expect(await checker.verifiedCreations(creator)).to.equal(ethers.parseEther("1"));
    });

    it("non-novel evidence (weight=0) credits NEITHER deliverer nor creator", async function () {
      const checker = await deployChecker(deployer, routerEoaAddress);
      const multisig = ethers.Wallet.createRandom().address;
      const creator = ethers.Wallet.createRandom().address;

      const evidence = ethers.id("repeated-evidence");
      // First submission — novel, full weight.
      await (await checker.connect(routerEoa).recordRestorationEvidence(multisig, creator, evidence)).wait();
      expect(await checker.noveltyWeightedCounts(multisig)).to.equal(ethers.parseEther("1"));
      expect(await checker.verifiedCreations(creator)).to.equal(ethers.parseEther("1"));

      // Second submission — same evidence, weight=0 with default decay multiplier.
      await (await checker.connect(routerEoa).recordRestorationEvidence(multisig, creator, evidence)).wait();
      expect(await checker.noveltyWeightedCounts(multisig)).to.equal(ethers.parseEther("1")); // unchanged
      expect(await checker.verifiedCreations(creator)).to.equal(ethers.parseEther("1")); // unchanged
    });

    it("partial decay (similarDecayMultiplier=0.3e18) credits both with the same partial weight", async function () {
      const checker = await deployChecker(deployer, routerEoaAddress, {
        similarDecayMultiplier: ethers.parseEther("0.3"),
      });
      const multisig = ethers.Wallet.createRandom().address;
      const creator = ethers.Wallet.createRandom().address;
      const evidence = ethers.id("repeated-with-partial-decay");

      await (await checker.connect(routerEoa).recordRestorationEvidence(multisig, creator, evidence)).wait();
      // First: full weight 1e18 for both.
      expect(await checker.noveltyWeightedCounts(multisig)).to.equal(ethers.parseEther("1"));
      expect(await checker.verifiedCreations(creator)).to.equal(ethers.parseEther("1"));

      await (await checker.connect(routerEoa).recordRestorationEvidence(multisig, creator, evidence)).wait();
      // Second: similar evidence → 0.3e18 added to both → totals 1.3e18.
      expect(await checker.noveltyWeightedCounts(multisig)).to.equal(ethers.parseEther("1.3"));
      expect(await checker.verifiedCreations(creator)).to.equal(ethers.parseEther("1.3"));
    });

    it("creator=address(0) skips creator crediting (back-compat path)", async function () {
      const checker = await deployChecker(deployer, routerEoaAddress);
      const multisig = ethers.Wallet.createRandom().address;
      const evidence = ethers.id("no-creator");

      await (await checker.connect(routerEoa).recordRestorationEvidence(
        multisig,
        ethers.ZeroAddress,
        evidence,
      )).wait();

      expect(await checker.noveltyWeightedCounts(multisig)).to.equal(ethers.parseEther("1"));
      expect(await checker.verifiedCreations(ethers.ZeroAddress)).to.equal(0n);
    });

    it("emits CreationCredited only when weight > 0 and creator != 0", async function () {
      const checker = await deployChecker(deployer, routerEoaAddress);
      const multisig = ethers.Wallet.createRandom().address;
      const creator = ethers.Wallet.createRandom().address;
      const evidence = ethers.id("credit-emit");

      await expect(
        checker.connect(routerEoa).recordRestorationEvidence(multisig, creator, evidence)
      ).to.emit(checker, "CreationCredited").withArgs(creator, multisig, evidence, ethers.parseEther("1"));

      // Same evidence again with default decay (0) → weight=0 → no CreationCredited event.
      const tx = await checker.connect(routerEoa).recordRestorationEvidence(multisig, creator, evidence);
      const receipt = await tx.wait();
      const creditedLogs = receipt!.logs.filter((log: any) => {
        try { return checker.interface.parseLog(log)?.name === "CreationCredited"; } catch { return false; }
      });
      expect(creditedLogs.length).to.equal(0);
    });

    it("multiple creators are tracked independently", async function () {
      const checker = await deployChecker(deployer, routerEoaAddress);
      const multisig = ethers.Wallet.createRandom().address;
      const creatorA = ethers.Wallet.createRandom().address;
      const creatorB = ethers.Wallet.createRandom().address;

      await (await checker.connect(routerEoa).recordRestorationEvidence(
        multisig, creatorA, ethers.id("evA"),
      )).wait();
      await (await checker.connect(routerEoa).recordRestorationEvidence(
        multisig, creatorB, ethers.id("evB"),
      )).wait();

      expect(await checker.verifiedCreations(creatorA)).to.equal(ethers.parseEther("1"));
      expect(await checker.verifiedCreations(creatorB)).to.equal(ethers.parseEther("1"));
    });
  });

  // ===========================================================================
  // 3. C1 — circular buffer bounds storage and similarity still works
  // ===========================================================================
  describe("C1 fix — evidenceHashes is a bounded circular buffer", function () {
    it("buffer length never exceeds comparisonWindow even after many writes", async function () {
      const checker = await deployChecker(deployer, routerEoaAddress, { comparisonWindow: 5n });
      const multisig = ethers.Wallet.createRandom().address;

      for (let i = 0; i < 12; i++) {
        await (await checker.connect(routerEoa).recordRestorationEvidence(
          multisig,
          ethers.ZeroAddress,
          ethers.id(`unique-${i}`),
        )).wait();
      }

      // Exactly comparisonWindow stored.
      expect(await checker.getEvidenceHashCount(multisig)).to.equal(5n);
    });

    it("only the most recent comparisonWindow entries are retained", async function () {
      const checker = await deployChecker(deployer, routerEoaAddress, { comparisonWindow: 3n });
      const multisig = ethers.Wallet.createRandom().address;

      const tags = ["a", "b", "c", "d", "e"];
      const hashes = tags.map((t) => ethers.id(t));
      for (const h of hashes) {
        await (await checker.connect(routerEoa).recordRestorationEvidence(
          multisig,
          ethers.ZeroAddress,
          h,
        )).wait();
      }

      // Buffer should contain c, d, e (oldest..newest).
      expect(await checker.getEvidenceHashCount(multisig)).to.equal(3n);
      expect(await checker.getEvidenceHash(multisig, 0)).to.equal(hashes[2]); // c
      expect(await checker.getEvidenceHash(multisig, 1)).to.equal(hashes[3]); // d
      expect(await checker.getEvidenceHash(multisig, 2)).to.equal(hashes[4]); // e
    });

    it("similarity check still detects duplicates against the bounded window", async function () {
      const checker = await deployChecker(deployer, routerEoaAddress, { comparisonWindow: 3n });
      const multisig = ethers.Wallet.createRandom().address;

      const farmHash = ethers.id("farmer");
      const novel1 = ethers.id("novel-1");
      const novel2 = ethers.id("novel-2");

      // First record the farm hash, then two more novel ones — buffer = [farm, novel1, novel2].
      await (await checker.connect(routerEoa).recordRestorationEvidence(multisig, ethers.ZeroAddress, farmHash)).wait();
      await (await checker.connect(routerEoa).recordRestorationEvidence(multisig, ethers.ZeroAddress, novel1)).wait();
      await (await checker.connect(routerEoa).recordRestorationEvidence(multisig, ethers.ZeroAddress, novel2)).wait();

      const weightAfterThree = await checker.noveltyWeightedCounts(multisig);
      // 3 * 1e18 (all novel because hashes diverge a lot)
      expect(weightAfterThree).to.equal(ethers.parseEther("3"));

      // Now resubmit farmHash. It is still inside the window of 3 (oldest is farm).
      // Window [farm, novel1, novel2] → distance(farm, farm)=0 < 64 → similar → weight 0.
      await (await checker.connect(routerEoa).recordRestorationEvidence(multisig, ethers.ZeroAddress, farmHash)).wait();
      // No additional novelty weight.
      expect(await checker.noveltyWeightedCounts(multisig)).to.equal(weightAfterThree);
    });

    it("hashes outside the (now bounded) window are forgiven", async function () {
      const checker = await deployChecker(deployer, routerEoaAddress, { comparisonWindow: 2n });
      const multisig = ethers.Wallet.createRandom().address;

      const farmHash = ethers.id("farmer-2");
      const novel1 = ethers.id("novel-A");
      const novel2 = ethers.id("novel-B");

      // Buffer fills with farm (then evicted as we add more)
      await (await checker.connect(routerEoa).recordRestorationEvidence(multisig, ethers.ZeroAddress, farmHash)).wait();
      await (await checker.connect(routerEoa).recordRestorationEvidence(multisig, ethers.ZeroAddress, novel1)).wait();
      await (await checker.connect(routerEoa).recordRestorationEvidence(multisig, ethers.ZeroAddress, novel2)).wait();

      // Now buffer is [novel1, novel2] (farm evicted).
      expect(await checker.getEvidenceHashCount(multisig)).to.equal(2n);

      const weightBefore = await checker.noveltyWeightedCounts(multisig);

      // Resubmitting the farm hash should be novel because it's no longer in the window.
      await (await checker.connect(routerEoa).recordRestorationEvidence(multisig, ethers.ZeroAddress, farmHash)).wait();
      expect(await checker.noveltyWeightedCounts(multisig) - weightBefore).to.equal(ethers.parseEther("1"));
    });

    it("getEvidenceHash reverts on out-of-bounds index", async function () {
      const checker = await deployChecker(deployer, routerEoaAddress, { comparisonWindow: 3n });
      const multisig = ethers.Wallet.createRandom().address;

      await (await checker.connect(routerEoa).recordRestorationEvidence(
        multisig, ethers.ZeroAddress, ethers.id("only"),
      )).wait();
      // length is 1, asking for index 1 should revert.
      await expect(checker.getEvidenceHash(multisig, 1)).to.be.reverted;
    });
  });

  // ===========================================================================
  // 4. Router → checker creator flow (end-to-end via real router proxy)
  // ===========================================================================
  describe("Router → checker creator flow", function () {
    let serviceRegistry: any;
    let karma: any;
    let marketplace: any;
    let balanceTracker: any;
    let mechFactory: any;
    let checker: any;
    let routerProxy: any;
    let router: any;
    let mechAddress: string;
    let serviceMultisig: string; // = creatorAddress (deployer of mech & service multisig)

    before(async function () {
      // Use creatorSigner as the service multisig + creator. delivererSigner will
      // exercise the deliverer path for separation. The mech factory ties the
      // mech operator to the service multisig, so we need creator == operator
      // for the mech to accept the delivery. We then have creator post the job
      // and (still as creator) deliver via mech, and finally call claimDelivery
      // from the deliverer signer to demonstrate the creator/deliverer split.

      serviceMultisig = creatorAddress;

      // ── WETH stub
      const TestERC20Factory = await ethers.getContractFactory("TestERC20", deployer);
      const weth = await TestERC20Factory.deploy("Wrapped Ether", "WETH");
      await weth.waitForDeployment();
      const wethAddress = await weth.getAddress();

      // ── Service registry
      const ServiceRegistryFactory = await ethers.getContractFactory("ServiceRegistryStub", deployer);
      serviceRegistry = await ServiceRegistryFactory.deploy();
      await serviceRegistry.waitForDeployment();
      const serviceRegistryAddress = await serviceRegistry.getAddress();

      // Service with creatorAddress as multisig — required because mech.deliver
      // checks operator == multisig.
      await (await serviceRegistry.createMockService(
        serviceMultisig,
        ethers.parseEther("1"),
        1, 0, [1],
        ethers.ZeroHash,
      )).wait();

      // ── Karma
      const KarmaFactory = await ethers.getContractFactory("Karma", deployer);
      const karmaImpl = await KarmaFactory.deploy();
      await karmaImpl.waitForDeployment();
      const KarmaProxyFactory = await ethers.getContractFactory("KarmaProxy", deployer);
      const karmaProxy = await KarmaProxyFactory.deploy(
        await karmaImpl.getAddress(),
        karmaImpl.interface.encodeFunctionData("initialize"),
      );
      await karmaProxy.waitForDeployment();
      karma = KarmaFactory.attach(await karmaProxy.getAddress());

      // ── Marketplace
      const MarketplaceFactory = await ethers.getContractFactory("MechMarketplace", deployer);
      const marketplaceImpl = await MarketplaceFactory.deploy(serviceRegistryAddress, await karma.getAddress());
      await marketplaceImpl.waitForDeployment();
      const initData = marketplaceImpl.interface.encodeFunctionData("initialize", [
        MARKETPLACE_FEE,
        MIN_RESPONSE_TIMEOUT,
        MAX_RESPONSE_TIMEOUT,
      ]);
      const MechMarketplaceProxyFactory = await ethers.getContractFactory("MechMarketplaceProxy", deployer);
      const marketplaceProxy = await MechMarketplaceProxyFactory.deploy(
        await marketplaceImpl.getAddress(),
        initData,
      );
      await marketplaceProxy.waitForDeployment();
      marketplace = MarketplaceFactory.attach(await marketplaceProxy.getAddress());
      const marketplaceAddress = await marketplace.getAddress();

      // ── Balance tracker
      const BalanceTrackerFactory = await ethers.getContractFactory("BalanceTrackerFixedPriceNative", deployer);
      balanceTracker = await BalanceTrackerFactory.deploy(marketplaceAddress, deployerAddress, wethAddress);
      await balanceTracker.waitForDeployment();

      // ── Mech factory
      const MechFactoryFactory = await ethers.getContractFactory("MechFactoryFixedPriceNative", deployer);
      mechFactory = await MechFactoryFactory.deploy(marketplaceAddress);
      await mechFactory.waitForDeployment();

      await (await marketplace.setMechFactoryStatuses([await mechFactory.getAddress()], [true])).wait();
      await (await marketplace.setPaymentTypeBalanceTrackers(
        [NATIVE_PAYMENT_TYPE],
        [await balanceTracker.getAddress()],
      )).wait();
      await (await karma.setMechMarketplaceStatuses([marketplaceAddress], [true])).wait();

      // ── V2 checker
      const CheckerFactory = await ethers.getContractFactory("RestorationActivityCheckerV2", deployer);
      checker = await CheckerFactory.deploy();
      await checker.waitForDeployment();
      await (await checker.initialize(
        DEFAULT_LIVENESS_RATIO,
        deployerAddress,
        DEFAULT_SIMILARITY_THRESHOLD,
        DEFAULT_DECAY_MULTIPLIER,
        DEFAULT_COMPARISON_WINDOW,
      )).wait();

      // ── V2 router proxy
      const JinnRouterV2Factory = await ethers.getContractFactory("JinnRouterV2", deployer);
      const routerImpl = await JinnRouterV2Factory.deploy();
      await routerImpl.waitForDeployment();
      const routerInit = routerImpl.interface.encodeFunctionData("initialize", [
        marketplaceAddress,
        DEFAULT_LIVENESS_RATIO,
        await checker.getAddress(),
      ]);
      const RouterProxyFactory = await ethers.getContractFactory("JinnRouterProxy", deployer);
      routerProxy = await RouterProxyFactory.deploy(await routerImpl.getAddress(), routerInit);
      await routerProxy.waitForDeployment();
      router = await ethers.getContractAt("JinnRouterV2", await routerProxy.getAddress());

      // Wire checker → router proxy.
      const routerProxyAddress = await routerProxy.getAddress();
      await (await checker.setRouterAddresses(routerProxyAddress, routerProxyAddress)).wait();

      // ── Mech created by service owner (deployer minted serviceId=1)
      const mechTx = await marketplace.create(
        1n,
        await mechFactory.getAddress(),
        encodeMaxDeliveryRate(ethers.parseEther("0.001")),
      );
      const mechReceipt = await mechTx.wait();
      const createMechEvent = mechReceipt!.logs
        .map((log: any) => {
          try { return marketplace.interface.parseLog(log); } catch { return null; }
        })
        .find((e: any) => e?.name === "CreateMech");
      mechAddress = createMechEvent!.args.mech;
    });

    it("createRestorationJob from creator + claimDelivery from a different deliverer credits both correctly", async function () {
      // Step 1: creator posts the restoration job.
      const requestData = ethers.toUtf8Bytes("restore: phaseB-prime " + Date.now());
      const tx = await router.connect(creatorSigner).createRestorationJob(
        requestData,
        mechAddress,
        ethers.parseEther("0.001"),
        120,
        NATIVE_PAYMENT_TYPE,
        "0x",
        { value: ethers.parseEther("0.001") },
      );
      const receipt = await tx.wait();
      const evt = receipt!.logs
        .map((log: any) => { try { return router.interface.parseLog(log); } catch { return null; } })
        .find((e: any) => e?.name === "RestorationJobCreated");
      const requestId: string = evt!.args.requestId;

      // Sanity: router stored the creator.
      expect(await router.creators(requestId)).to.equal(creatorAddress);

      // Step 2: deliver via mech. The mech operator is the service multisig
      // (creatorAddress in this fixture). We use creatorSigner to deliver, but
      // the *claimDelivery* call comes from a different signer (delivererSigner)
      // to demonstrate the creator/deliverer split.
      const mech = await ethers.getContractAt("MechFixedPriceNative", mechAddress, creatorSigner);
      await (await mech.deliverToMarketplace([requestId], [ethers.toUtf8Bytes("result")])).wait();

      // Step 3: claimDelivery from deliverer with novel evidence.
      const noveltyWeightCreatorBefore = await checker.verifiedCreations(creatorAddress);
      const deliveryWeightBefore = await checker.noveltyWeightedCounts(delivererAddress);

      const evidence = ethers.id("novel-restoration-phaseB-prime");
      await (await router.connect(delivererSigner).claimDelivery(requestId, evidence)).wait();

      // Deliverer earns 1e18 novelty weight.
      expect(
        (await checker.noveltyWeightedCounts(delivererAddress)) - deliveryWeightBefore
      ).to.equal(ethers.parseEther("1"));

      // Creator earns 1e18 ε credit (gated by the same novelty test).
      expect(
        (await checker.verifiedCreations(creatorAddress)) - noveltyWeightCreatorBefore
      ).to.equal(ethers.parseEther("1"));

      // restorationDeliveryCount goes to deliverer.
      expect(await router.restorationDeliveryCount(delivererAddress)).to.be.gte(1n);
    });

    it("isRatioPass regression — novel work passes, farmed work fails", async function () {
      // 1 novel activity (1e18) over 1000s = 1e15 = livenessRatio → passes.
      expect(await checker.isRatioPass(
        [0n, ethers.parseEther("1")],
        [0n, 0n],
        1000n,
      )).to.be.true;

      // Same weight over 1001s → just below threshold → fails.
      expect(await checker.isRatioPass(
        [0n, ethers.parseEther("1")],
        [0n, 0n],
        1001n,
      )).to.be.false;

      // No delta → fails.
      expect(await checker.isRatioPass(
        [0n, ethers.parseEther("3")],
        [0n, ethers.parseEther("3")],
        100n,
      )).to.be.false;

      // ts=0 → fails.
      expect(await checker.isRatioPass(
        [0n, ethers.parseEther("3")],
        [0n, 0n],
        0n,
      )).to.be.false;
    });
  });
});
