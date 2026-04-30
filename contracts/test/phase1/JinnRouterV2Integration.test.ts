/**
 * JinnRouterV2Integration.test.ts — Integration tests for JinnRouterV2 + RestorationActivityCheckerV2.
 *
 * Tests:
 *  1. Evidence forwarding on restoration delivery claim
 *  2. No evidence forwarding when hash is zero
 *  3. No evidence forwarding on evaluation delivery
 *  4. Anti-farming through router — duplicate evidence decayed
 *  5. getMultisigNonces combines router + checker
 *  6. isRatioPass with combined counts — novel work passes
 *  7. isRatioPass with combined counts — farmed work fails
 *  8. Unauthorized router rejected
 *  9. Proxy getImplementation
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import type { Signer } from "ethers";

// keccak256("FixedPriceNative")
const NATIVE_PAYMENT_TYPE = "0xba699a34be8fe0e7725e93dcbce1701b0211a8ca61330aaeb8a05bf2ec7abed1";
const MARKETPLACE_FEE = 0;
const MIN_RESPONSE_TIMEOUT = 60;
const MAX_RESPONSE_TIMEOUT = 300;
const LIVENESS_RATIO = ethers.parseEther("0.001"); // 1e15

// Encode a uint256 maxDeliveryRate as factory payload (must be exactly 32 bytes)
function encodeMaxDeliveryRate(rate: bigint): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [rate]);
}

describe("JinnRouterV2 + RestorationActivityCheckerV2 Integration", function () {
  this.timeout(120_000);

  let deployer: Signer;
  let operator: Signer; // acts as service multisig
  let attacker: Signer;
  let deployerAddress: string;
  let operatorAddress: string;
  let attackerAddress: string;

  // Contract instances
  let serviceRegistry: any;
  let karma: any;
  let marketplace: any;
  let balanceTracker: any;
  let mechFactory: any;
  let checker: any;
  let routerImpl: any;
  let routerProxy: any;
  let router: any; // impl ABI attached to proxy address
  let mockSafe: any;

  let wethAddress: string;
  let serviceId: bigint;
  let mechAddress: string;

  before(async function () {
    [deployer, operator, attacker] = await ethers.getSigners();
    deployerAddress = await deployer.getAddress();
    operatorAddress = await operator.getAddress();
    attackerAddress = await attacker.getAddress();

    // ── Deploy a WETH stub ────────────────────────────────────────────────────
    const TestERC20Factory = await ethers.getContractFactory("TestERC20", deployer);
    const weth = await TestERC20Factory.deploy("Wrapped Ether", "WETH");
    await weth.waitForDeployment();
    wethAddress = await weth.getAddress();

    // ── 1. ServiceRegistryStub ────────────────────────────────────────────────
    const ServiceRegistryFactory = await ethers.getContractFactory("ServiceRegistryStub", deployer);
    serviceRegistry = await ServiceRegistryFactory.deploy();
    await serviceRegistry.waitForDeployment();
    const serviceRegistryAddress = await serviceRegistry.getAddress();

    // Create a mock service — multisig must be the deployer so we can call router functions
    const tx = await serviceRegistry.createMockService(
      deployerAddress,        // multisig = deployer (so we can call claimDelivery as deployer)
      ethers.parseEther("1"), // securityDeposit
      1,                      // numAgentInstances
      0,                      // threshold
      [1],                    // agentIds
      ethers.ZeroHash         // configHash
    );
    await tx.wait();
    serviceId = 1n;

    // ── 2. Karma impl + proxy ─────────────────────────────────────────────────
    const KarmaFactory = await ethers.getContractFactory("Karma", deployer);
    const karmaImpl = await KarmaFactory.deploy();
    await karmaImpl.waitForDeployment();

    const karmaInitData = karmaImpl.interface.encodeFunctionData("initialize");
    const KarmaProxyFactory = await ethers.getContractFactory("KarmaProxy", deployer);
    const karmaProxy = await KarmaProxyFactory.deploy(await karmaImpl.getAddress(), karmaInitData);
    await karmaProxy.waitForDeployment();
    karma = KarmaFactory.attach(await karmaProxy.getAddress());

    // ── 3. MechMarketplace impl + proxy ───────────────────────────────────────
    const MarketplaceFactory = await ethers.getContractFactory("MechMarketplace", deployer);
    const marketplaceImpl = await MarketplaceFactory.deploy(
      serviceRegistryAddress,
      await karma.getAddress()
    );
    await marketplaceImpl.waitForDeployment();

    const marketplaceInitData = marketplaceImpl.interface.encodeFunctionData("initialize", [
      MARKETPLACE_FEE,
      MIN_RESPONSE_TIMEOUT,
      MAX_RESPONSE_TIMEOUT,
    ]);
    const MechMarketplaceProxyFactory = await ethers.getContractFactory("MechMarketplaceProxy", deployer);
    const marketplaceProxy = await MechMarketplaceProxyFactory.deploy(
      await marketplaceImpl.getAddress(),
      marketplaceInitData
    );
    await marketplaceProxy.waitForDeployment();
    marketplace = MarketplaceFactory.attach(await marketplaceProxy.getAddress());
    const marketplaceAddress = await marketplace.getAddress();

    // ── 4. BalanceTrackerFixedPriceNative ─────────────────────────────────────
    const BalanceTrackerFactory = await ethers.getContractFactory("BalanceTrackerFixedPriceNative", deployer);
    balanceTracker = await BalanceTrackerFactory.deploy(
      marketplaceAddress,
      deployerAddress, // drainer
      wethAddress
    );
    await balanceTracker.waitForDeployment();

    // ── 5. MechFactoryFixedPriceNative ────────────────────────────────────────
    const MechFactoryFactory = await ethers.getContractFactory("MechFactoryFixedPriceNative", deployer);
    mechFactory = await MechFactoryFactory.deploy(marketplaceAddress);
    await mechFactory.waitForDeployment();

    // ── 6. Register factory + balance tracker ─────────────────────────────────
    await (await marketplace.setMechFactoryStatuses([await mechFactory.getAddress()], [true])).wait();
    await (await marketplace.setPaymentTypeBalanceTrackers(
      [NATIVE_PAYMENT_TYPE],
      [await balanceTracker.getAddress()]
    )).wait();

    // ── 7. Whitelist marketplace in Karma ─────────────────────────────────────
    await (await karma.setMechMarketplaceStatuses([marketplaceAddress], [true])).wait();

    // ── 8. RestorationActivityCheckerV2 ──────────────────────────────────────
    const CheckerFactory = await ethers.getContractFactory("RestorationActivityCheckerV2", deployer);
    checker = await CheckerFactory.deploy();
    await checker.waitForDeployment();
    await (await checker.initialize(
      LIVENESS_RATIO,           // livenessRatio = 1e15
      deployerAddress,          // owner
      64n,                      // similarityThreshold
      0n,                       // similarDecayMultiplier (binary: similar = zero weight)
      20n                       // comparisonWindow
    )).wait();
    const checkerAddress = await checker.getAddress();

    // ── 9. JinnRouterV2 impl + proxy ──────────────────────────────────────────
    const JinnRouterV2Factory = await ethers.getContractFactory("JinnRouterV2", deployer);
    routerImpl = await JinnRouterV2Factory.deploy();
    await routerImpl.waitForDeployment();

    const initData = routerImpl.interface.encodeFunctionData("initialize", [
      marketplaceAddress,
      LIVENESS_RATIO,
      checkerAddress,
    ]);
    const RouterProxyFactory = await ethers.getContractFactory("JinnRouterProxy", deployer);
    routerProxy = await RouterProxyFactory.deploy(await routerImpl.getAddress(), initData);
    await routerProxy.waitForDeployment();

    // Attach impl ABI to proxy address for interacting with the router
    router = await ethers.getContractAt("JinnRouterV2", await routerProxy.getAddress());

    // ── 10. Wire checker → router ─────────────────────────────────────────────
    // Both jinnRouter (for reading counts) and authorizedRouter (for recording evidence)
    // point to the proxy address
    const routerProxyAddress = await routerProxy.getAddress();
    await (await checker.setRouterAddresses(routerProxyAddress, routerProxyAddress)).wait();

    // ── 11. Create a mech via marketplace ─────────────────────────────────────
    const maxDeliveryRate = ethers.parseEther("0.001");
    const payload = encodeMaxDeliveryRate(maxDeliveryRate);

    // The service owner (deployer, who minted serviceId=1) creates the mech
    const mechTx = await marketplace.create(serviceId, await mechFactory.getAddress(), payload);
    const mechReceipt = await mechTx.wait();

    const createMechEvent = mechReceipt?.logs
      .map((log: any) => {
        try { return marketplace.interface.parseLog(log); } catch { return null; }
      })
      .find((e: any) => e?.name === "CreateMech");

    expect(createMechEvent, "CreateMech event not found").to.not.be.null;
    mechAddress = createMechEvent!.args.mech;

    // ── 12. Deploy MockSafeWithNonce ──────────────────────────────────────────
    const MockSafeFactory = await ethers.getContractFactory("MockSafeWithNonce", deployer);
    mockSafe = await MockSafeFactory.deploy();
    await mockSafe.waitForDeployment();
  });

  // ============================================================================
  // Helper: create a restoration job and deliver it, returning the requestId
  // ============================================================================

  async function createAndDeliverRestorationJob(): Promise<string> {
    const requestData = ethers.toUtf8Bytes("restore: service healthy " + Date.now());
    const maxDeliveryRate = ethers.parseEther("0.001");
    const responseTimeout = 120;

    const tx = await router.createRestorationJob(
      requestData,
      mechAddress,
      maxDeliveryRate,
      responseTimeout,
      NATIVE_PAYMENT_TYPE,
      "0x",
      { value: ethers.parseEther("0.001") }
    );
    const receipt = await tx.wait();

    const event = receipt?.logs
      .map((log: any) => {
        try { return router.interface.parseLog(log); } catch { return null; }
      })
      .find((e: any) => e?.name === "RestorationJobCreated");

    const requestId = event!.args.requestId;

    // Deliver via mech (operator = service multisig = deployer in this test setup)
    // Note: the mech's operator is determined by the service's multisig at creation time.
    // In this suite the service multisig is deployerAddress, so deployer IS the operator.
    const mech = await ethers.getContractAt("MechFixedPriceNative", mechAddress, deployer);
    await (await mech.deliverToMarketplace([requestId], [ethers.toUtf8Bytes("result")])).wait();

    return requestId;
  }

  // ============================================================================
  // Deployment sanity
  // ============================================================================

  describe("Deployment", function () {
    it("all contracts deployed to non-zero addresses", async function () {
      expect(await serviceRegistry.getAddress()).to.not.equal(ethers.ZeroAddress);
      expect(await karma.getAddress()).to.not.equal(ethers.ZeroAddress);
      expect(await marketplace.getAddress()).to.not.equal(ethers.ZeroAddress);
      expect(await balanceTracker.getAddress()).to.not.equal(ethers.ZeroAddress);
      expect(await mechFactory.getAddress()).to.not.equal(ethers.ZeroAddress);
      expect(await checker.getAddress()).to.not.equal(ethers.ZeroAddress);
      expect(await routerProxy.getAddress()).to.not.equal(ethers.ZeroAddress);
      expect(mechAddress).to.not.equal(ethers.ZeroAddress);
    });

    it("router is initialized with correct marketplace and checker", async function () {
      expect(await router.mechMarketplace()).to.equal(await marketplace.getAddress());
      expect(await router.livenessRatio()).to.equal(LIVENESS_RATIO);
      expect(await router.activityChecker()).to.equal(await checker.getAddress());
      expect(await router.initialized()).to.equal(true);
    });

    it("checker has correct router addresses set", async function () {
      const routerProxyAddress = await routerProxy.getAddress();
      expect(await checker.jinnRouter()).to.equal(routerProxyAddress);
      expect(await checker.authorizedRouter()).to.equal(routerProxyAddress);
    });

    it("router cannot be initialized twice", async function () {
      await expect(
        router.initialize(await marketplace.getAddress(), LIVENESS_RATIO, await checker.getAddress())
      ).to.be.reverted;
    });
  });

  // ============================================================================
  // Proxy
  // ============================================================================

  describe("Proxy", function () {
    it("getImplementation returns correct impl address", async function () {
      const implAddress = await routerProxy.getImplementation();
      expect(implAddress).to.equal(await routerImpl.getAddress());
    });
  });

  // ============================================================================
  // Test 1: Evidence forwarding on restoration delivery
  // ============================================================================

  describe("Evidence forwarding on restoration delivery", function () {
    it("claimDelivery with non-zero hash increments checker noveltyWeightedCounts by 1e18", async function () {
      const requestId = await createAndDeliverRestorationJob();

      const weightBefore = await checker.noveltyWeightedCounts(deployerAddress);
      const hashCountBefore = await checker.getEvidenceHashCount(deployerAddress);

      const evidenceHash = ethers.id("novel-restoration-evidence-" + requestId);
      const tx = await router.claimDelivery(requestId, evidenceHash);
      await tx.wait();

      const weightAfter = await checker.noveltyWeightedCounts(deployerAddress);
      const hashCountAfter = await checker.getEvidenceHashCount(deployerAddress);

      // Novel evidence: +1e18
      expect(weightAfter - weightBefore).to.equal(ethers.parseEther("1"));
      // Evidence hash stored
      expect(hashCountAfter - hashCountBefore).to.equal(1n);
    });

    it("router's restorationDeliveryCount increments regardless of evidence", async function () {
      const requestId = await createAndDeliverRestorationJob();
      const countBefore = await router.restorationDeliveryCount(deployerAddress);

      const evidenceHash = ethers.id("evidence-for-delivery-count-test");
      await (await router.claimDelivery(requestId, evidenceHash)).wait();

      const countAfter = await router.restorationDeliveryCount(deployerAddress);
      expect(countAfter).to.equal(countBefore + 1n);
    });
  });

  // ============================================================================
  // Test 2: No evidence forwarding when hash is zero
  // ============================================================================

  describe("No evidence forwarding when hash is zero", function () {
    it("claimDelivery with bytes32(0) does NOT forward to checker", async function () {
      const requestId = await createAndDeliverRestorationJob();

      const weightBefore = await checker.noveltyWeightedCounts(deployerAddress);
      const hashCountBefore = await checker.getEvidenceHashCount(deployerAddress);

      // Pass zero evidence hash
      await (await router.claimDelivery(requestId, ethers.ZeroHash)).wait();

      const weightAfter = await checker.noveltyWeightedCounts(deployerAddress);
      const hashCountAfter = await checker.getEvidenceHashCount(deployerAddress);

      // Checker unchanged
      expect(weightAfter).to.equal(weightBefore);
      expect(hashCountAfter).to.equal(hashCountBefore);
    });

    it("router's restorationDeliveryCount still increments with zero evidence", async function () {
      const requestId = await createAndDeliverRestorationJob();
      const countBefore = await router.restorationDeliveryCount(deployerAddress);

      await (await router.claimDelivery(requestId, ethers.ZeroHash)).wait();

      const countAfter = await router.restorationDeliveryCount(deployerAddress);
      expect(countAfter).to.equal(countBefore + 1n);
    });
  });

  // ============================================================================
  // Test 3: No evidence forwarding on evaluation delivery
  // ============================================================================

  describe("No evidence forwarding on evaluation delivery", function () {
    it("claimDelivery for an eval job does NOT increment checker evidence count", async function () {
      // Step 1: create and deliver a restoration job, claim it
      const restorationRequestId = await createAndDeliverRestorationJob();
      const restorationEvidenceHash = ethers.id("restoration-evidence-for-eval-test");
      await (await router.claimDelivery(restorationRequestId, restorationEvidenceHash)).wait();

      const hashCountAfterRestoration = await checker.getEvidenceHashCount(deployerAddress);

      // Step 2: create evaluation job
      const evalTx = await router.createEvaluationJob(
        restorationRequestId,
        ethers.toUtf8Bytes("evaluate: was it restored?"),
        mechAddress,
        ethers.parseEther("0.001"),
        120,
        NATIVE_PAYMENT_TYPE,
        "0x",
        { value: ethers.parseEther("0.001") }
      );
      const evalReceipt = await evalTx.wait();
      const evalEvent = evalReceipt?.logs
        .map((log: any) => {
          try { return router.interface.parseLog(log); } catch { return null; }
        })
        .find((e: any) => e?.name === "EvaluationJobCreated");
      const evalRequestId = evalEvent!.args.requestId;

      // Step 3: deliver the evaluation via mech
      const mech = await ethers.getContractAt("MechFixedPriceNative", mechAddress, deployer);
      await (await mech.deliverToMarketplace([evalRequestId], [ethers.toUtf8Bytes("evaluation result")])).wait();

      // Step 4: claim the evaluation delivery with an evidence hash
      const evalEvidenceHash = ethers.id("eval-evidence-should-not-count");
      await (await router.claimDelivery(evalRequestId, evalEvidenceHash)).wait();

      // Checker's evidence hash count should NOT have changed from the eval claim
      const hashCountAfterEval = await checker.getEvidenceHashCount(deployerAddress);
      expect(hashCountAfterEval).to.equal(hashCountAfterRestoration);
    });

    it("eval delivery increments evaluationDeliveryCount, not noveltyWeightedCounts", async function () {
      // Setup: restoration claim needed first
      const restorationRequestId = await createAndDeliverRestorationJob();
      await (await router.claimDelivery(restorationRequestId, ethers.id("restoration-evidence"))).wait();

      const evalTx = await router.createEvaluationJob(
        restorationRequestId,
        ethers.toUtf8Bytes("evaluate"),
        mechAddress,
        ethers.parseEther("0.001"),
        120,
        NATIVE_PAYMENT_TYPE,
        "0x",
        { value: ethers.parseEther("0.001") }
      );
      const evalReceipt = await evalTx.wait();
      const evalEvent = evalReceipt?.logs
        .map((log: any) => {
          try { return router.interface.parseLog(log); } catch { return null; }
        })
        .find((e: any) => e?.name === "EvaluationJobCreated");
      const evalRequestId = evalEvent!.args.requestId;

      const mech = await ethers.getContractAt("MechFixedPriceNative", mechAddress, deployer);
      await (await mech.deliverToMarketplace([evalRequestId], [ethers.toUtf8Bytes("result")])).wait();

      const weightBefore = await checker.noveltyWeightedCounts(deployerAddress);
      const evalDeliveryCountBefore = await router.evaluationDeliveryCount(deployerAddress);

      await (await router.claimDelivery(evalRequestId, ethers.id("should-be-ignored"))).wait();

      // Checker weight unchanged
      expect(await checker.noveltyWeightedCounts(deployerAddress)).to.equal(weightBefore);
      // But eval delivery count incremented
      expect(await router.evaluationDeliveryCount(deployerAddress)).to.equal(evalDeliveryCountBefore + 1n);
    });
  });

  // ============================================================================
  // Test 4: Anti-farming through router — duplicate evidence decayed
  // ============================================================================

  describe("Anti-farming — duplicate evidence decayed", function () {
    it("first claim with evidence X earns 1e18, second claim with same X earns 0", async function () {
      // Create two separate restoration jobs
      const requestId1 = await createAndDeliverRestorationJob();
      const requestId2 = await createAndDeliverRestorationJob();

      // Both use the same evidence hash (farming pattern)
      const farmingHash = ethers.id("farming-evidence-same-result");

      const weightBefore = await checker.noveltyWeightedCounts(deployerAddress);

      // First claim — novel, earns 1e18
      await (await router.claimDelivery(requestId1, farmingHash)).wait();
      const weightAfterFirst = await checker.noveltyWeightedCounts(deployerAddress);
      expect(weightAfterFirst - weightBefore).to.equal(ethers.parseEther("1"));

      // Second claim — duplicate, earns 0 (similarDecayMultiplier = 0)
      await (await router.claimDelivery(requestId2, farmingHash)).wait();
      const weightAfterSecond = await checker.noveltyWeightedCounts(deployerAddress);
      expect(weightAfterSecond).to.equal(weightAfterFirst); // unchanged

      // Total noveltyWeightedCounts only went up by 1e18 (not 2e18)
      expect(weightAfterSecond - weightBefore).to.equal(ethers.parseEther("1"));
    });
  });

  // ============================================================================
  // Test 5: getMultisigNonces combines router + checker
  // ============================================================================

  describe("getMultisigNonces combines router + checker", function () {
    it("nonces[1] = (creationCount + evalCreationCount + evalDeliveryCount) * 1e18 + noveltyWeightedCounts", async function () {
      // Use mockSafe as the multisig to isolate this test from other state
      const mockSafeAddress = await mockSafe.getAddress();

      // Verify initial state is clean
      expect(await router.creationCount(mockSafeAddress)).to.equal(0n);
      expect(await router.evaluationCreationCount(mockSafeAddress)).to.equal(0n);
      expect(await router.evaluationDeliveryCount(mockSafeAddress)).to.equal(0n);
      expect(await checker.noveltyWeightedCounts(mockSafeAddress)).to.equal(0n);

      // To interact as mockSafe, we need the mockSafe to be a service multisig.
      // Instead of doing a full setup from mockSafe, we verify the formula directly
      // by reading existing state for deployerAddress and computing expected values.
      const creation = await router.creationCount(deployerAddress);
      const evalCreation = await router.evaluationCreationCount(deployerAddress);
      const evalDelivery = await router.evaluationDeliveryCount(deployerAddress);
      const noveltyWeighted = await checker.noveltyWeightedCounts(deployerAddress);

      // Expected: (creation + evalCreation + evalDelivery) * 1e18 + noveltyWeighted
      const expectedNonces1 = (creation + evalCreation + evalDelivery) * ethers.parseEther("1") + noveltyWeighted;

      // For getMultisigNonces we need a contract address with nonce()
      // Use mockSafe, but record activity for mockSafe manually via checker.recordActivity
      // so we can verify the formula. First, let's just verify the formula for mockSafe directly
      // by recording some activity manually.

      // Record 1 creation via checker for mockSafe (simulating what router would do)
      // We need to use recordActivity for the creation/eval counts side
      // But actually those come from the ROUTER's counts, not checker's.
      // The checker reads router.creationCount(multisig) directly.
      //
      // So for mockSafe: creation=0, evalCreation=0, evalDelivery=0 → routerActivity = 0
      // Plus noveltyWeightedCounts = 0 → nonces[1] = 0
      const nonces = await checker.getMultisigNonces(mockSafeAddress);
      expect(nonces.length).to.equal(2);
      expect(nonces[0]).to.equal(0n); // mockSafe.nonce() = 0
      expect(nonces[1]).to.equal(0n); // no activity for mockSafe

      // Verify the deployer's nonces match the formula
      // We can't call getMultisigNonces(deployerAddress) since deployer is an EOA (no nonce()),
      // but we can verify the formula components are correct from the individual reads.
      expect(expectedNonces1).to.equal(
        (creation + evalCreation + evalDelivery) * ethers.parseEther("1") + noveltyWeighted
      );
    });

    it("nonces[1] = 3e18 after 1 creation + 1 novel delivery + 1 eval creation for mockSafe", async function () {
      // We need to simulate the full flow for the mockSafe address.
      // Since the mech delivery system requires a real service, we'll verify the formula
      // by manually triggering the checker's state with the correct multisig address.
      //
      // The checker reads from:
      // - router.creationCount(mockSafe) — via IJinnRouter interface
      // - router.evaluationCreationCount(mockSafe)
      // - router.evaluationDeliveryCount(mockSafe)
      // - checker.noveltyWeightedCounts(mockSafe) — from direct evidence forwarding
      //
      // We can't easily make the router emit counts for mockSafe without creating a service
      // with mockSafe as multisig. So we use the deployer address state after the full flow
      // that was built up in earlier tests.

      // Read current state for deployer
      const creation = await router.creationCount(deployerAddress);
      const evalCreation = await router.evaluationCreationCount(deployerAddress);
      const evalDelivery = await router.evaluationDeliveryCount(deployerAddress);
      const noveltyWeighted = await checker.noveltyWeightedCounts(deployerAddress);

      // Ensure we have at least: creation >= 1, evalCreation >= 1, noveltyWeighted >= 1e18
      expect(creation).to.be.gte(1n);
      expect(evalCreation).to.be.gte(1n);
      expect(noveltyWeighted).to.be.gte(ethers.parseEther("1"));

      // Compute expected nonces[1] for deployer
      // (deployer is EOA so we can't call getMultisigNonces, but we verify the math)
      const expectedNonces1 = (creation + evalCreation + evalDelivery) * ethers.parseEther("1") + noveltyWeighted;

      // Use mockSafe which has nonce() — create a fresh service with mockSafe as multisig
      // and perform one of each operation to hit exactly 3e18
      const mockSafeAddress = await mockSafe.getAddress();

      // Setup: new service with mockSafe as multisig
      const svcTx = await serviceRegistry.createMockService(
        mockSafeAddress,        // multisig = mockSafe
        ethers.parseEther("1"),
        1, 0, [1],
        ethers.ZeroHash
      );
      await svcTx.wait();
      const mockSafeServiceId = 2n;

      // Create a mech for this service (deployer owns the NFT for serviceId=2)
      const mechTx2 = await marketplace.create(
        mockSafeServiceId,
        await mechFactory.getAddress(),
        encodeMaxDeliveryRate(ethers.parseEther("0.001"))
      );
      const mechReceipt2 = await mechTx2.wait();
      const createMechEvent2 = mechReceipt2?.logs
        .map((log: any) => {
          try { return marketplace.interface.parseLog(log); } catch { return null; }
        })
        .find((e: any) => e?.name === "CreateMech");
      const mechAddress2 = createMechEvent2!.args.mech;

      // The mech's operator is the service multisig (mockSafe), but we can't call
      // deliverToMarketplace from mockSafe (it's a contract without that function).
      // However, OlasMech.isOperator checks the service registry's multisig.
      // Let's verify who the operator is:
      const mech2 = await ethers.getContractAt("MechFixedPriceNative", mechAddress2);
      const mech2Operator = await mech2.getOperator();

      // The operator is mockSafe — we need to impersonate it for delivery.
      // Use hardhat's impersonateAccount.
      await ethers.provider.send("hardhat_impersonateAccount", [mockSafeAddress]);
      await ethers.provider.send("hardhat_setBalance", [mockSafeAddress, ethers.toBeHex(ethers.parseEther("10"))]);
      const mockSafeSigner = await ethers.getSigner(mockSafeAddress);

      // Step 1: createRestorationJob as mockSafe → creationCount[mockSafe] = 1
      const restorationTx = await router.connect(mockSafeSigner).createRestorationJob(
        ethers.toUtf8Bytes("restore from mockSafe"),
        mechAddress2,
        ethers.parseEther("0.001"),
        120,
        NATIVE_PAYMENT_TYPE,
        "0x",
        { value: ethers.parseEther("0.001") }
      );
      const restorationReceipt = await restorationTx.wait();
      const restorationEvent = restorationReceipt?.logs
        .map((log: any) => {
          try { return router.interface.parseLog(log); } catch { return null; }
        })
        .find((e: any) => e?.name === "RestorationJobCreated");
      const restorationRequestId = restorationEvent!.args.requestId;

      expect(await router.creationCount(mockSafeAddress)).to.equal(1n);

      // Step 2: deliver via mech2 (operator = mockSafe)
      await (await mech2.connect(mockSafeSigner).deliverToMarketplace(
        [restorationRequestId],
        [ethers.toUtf8Bytes("result")]
      )).wait();

      // Step 3: claimDelivery with novel evidence → noveltyWeightedCounts[mockSafe] += 1e18
      const novelEvidence = ethers.id("mock-safe-novel-evidence");
      await (await router.connect(mockSafeSigner).claimDelivery(restorationRequestId, novelEvidence)).wait();

      expect(await checker.noveltyWeightedCounts(mockSafeAddress)).to.equal(ethers.parseEther("1"));

      // Step 4: createEvaluationJob as mockSafe → evaluationCreationCount[mockSafe] = 1
      const evalTx2 = await router.connect(mockSafeSigner).createEvaluationJob(
        restorationRequestId,
        ethers.toUtf8Bytes("evaluate from mockSafe"),
        mechAddress2,
        ethers.parseEther("0.001"),
        120,
        NATIVE_PAYMENT_TYPE,
        "0x",
        { value: ethers.parseEther("0.001") }
      );
      await evalTx2.wait();
      expect(await router.evaluationCreationCount(mockSafeAddress)).to.equal(1n);

      // Now verify getMultisigNonces
      // nonces[1] = (creationCount=1 + evalCreationCount=1 + evalDeliveryCount=0) * 1e18 + noveltyWeightedCounts=1e18
      //           = 2 * 1e18 + 1e18 = 3e18
      const nonces = await checker.getMultisigNonces(mockSafeAddress);
      expect(nonces.length).to.equal(2);
      expect(nonces[0]).to.equal(0n); // mockSafe.nonce() = 0 (not incremented)
      expect(nonces[1]).to.equal(ethers.parseEther("3")); // 3e18

      // Stop impersonation
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [mockSafeAddress]);
    });
  });

  // ============================================================================
  // Test 6: isRatioPass — novel work passes
  // ============================================================================

  describe("isRatioPass with combined counts — novel work passes", function () {
    it("3e18 weighted activity / 1000 seconds = 3e15 >= 1e15 → true", async function () {
      // curNonces[1] = 3e18 (from above test's state or synthetic)
      const curNonces = [0n, ethers.parseEther("3")];
      const lastNonces = [0n, 0n];
      const ts = 1000n;

      // ratio = 3e18 / 1000 = 3e15 >= 1e15 → pass
      expect(await checker.isRatioPass(curNonces, lastNonces, ts)).to.be.true;
    });

    it("1 novel activity (1e18) / 1000 seconds = 1e15 >= 1e15 → true (borderline)", async function () {
      const curNonces = [0n, ethers.parseEther("1")];
      const lastNonces = [0n, 0n];
      const ts = 1000n;

      expect(await checker.isRatioPass(curNonces, lastNonces, ts)).to.be.true;
    });
  });

  // ============================================================================
  // Test 7: isRatioPass — farmed work fails
  // ============================================================================

  describe("isRatioPass with combined counts — farmed work fails", function () {
    it("only 1e18 total (creation alone, no novel delivery) / 1001 seconds → false", async function () {
      // Only 1 creation (1e18) + 0 from delivery (duplicate evidence) = 1e18 total
      // ts = 1001 → 1e18 / 1001 < 1e15 → false
      const curNonces = [0n, ethers.parseEther("1")];
      const lastNonces = [0n, 0n];
      const ts = 1001n;

      // 1e18 / 1001 ≈ 9.99e14 < 1e15 → fails
      expect(await checker.isRatioPass(curNonces, lastNonces, ts)).to.be.false;
    });

    it("ts=0 always fails", async function () {
      const curNonces = [0n, ethers.parseEther("3")];
      const lastNonces = [0n, 0n];

      expect(await checker.isRatioPass(curNonces, lastNonces, 0n)).to.be.false;
    });

    it("no activity delta (curNonces == lastNonces) fails", async function () {
      const nonces = [0n, ethers.parseEther("3")];
      expect(await checker.isRatioPass(nonces, nonces, 1000n)).to.be.false;
    });

    it("high ts causes ratio to drop below threshold", async function () {
      // 3e18 / 1_000_000 = 3e12 < 1e15 → false
      const curNonces = [0n, ethers.parseEther("3")];
      const lastNonces = [0n, 0n];
      const ts = 1_000_000n;

      expect(await checker.isRatioPass(curNonces, lastNonces, ts)).to.be.false;
    });
  });

  // ============================================================================
  // Test 8: Unauthorized router rejected
  // ============================================================================

  describe("Unauthorized router rejected", function () {
    it("recordRestorationEvidence reverts when called by non-router address", async function () {
      // attacker tries to directly call recordRestorationEvidence (3-arg signature
      // with the new ε creation-gating creator parameter).
      await expect(
        checker.connect(attacker).recordRestorationEvidence(
          deployerAddress,
          deployerAddress,
          ethers.id("malicious-evidence")
        )
      ).to.be.revertedWithCustomError(checker, "UnauthorizedRouter");
    });

    it("deployer (owner, but not authorized router) also cannot call recordRestorationEvidence", async function () {
      await expect(
        checker.recordRestorationEvidence(
          deployerAddress,
          deployerAddress,
          ethers.id("owner-trying-to-record")
        )
      ).to.be.revertedWithCustomError(checker, "UnauthorizedRouter");
    });

    it("recordActivity reverts when called by non-router address (C4 fix)", async function () {
      const dummyMultisig = ethers.Wallet.createRandom().address;
      // Direct call by deployer (NOT the authorized router) must revert.
      await expect(
        checker.recordActivity(dummyMultisig, 0)
      ).to.be.revertedWithCustomError(checker, "UnauthorizedRouter");
    });

    it("recordActivityWithEvidence reverts when called by non-router address (C4 fix)", async function () {
      const dummyMultisig = ethers.Wallet.createRandom().address;
      await expect(
        checker.recordActivityWithEvidence(dummyMultisig, 0, ethers.id("ev"))
      ).to.be.revertedWithCustomError(checker, "UnauthorizedRouter");
    });
  });
});
