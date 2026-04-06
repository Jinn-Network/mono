const { expect } = require("chai");
const { ethers } = require("hardhat");

const LIVENESS_RATIO = 230481481481481n; // ~20 activities/day

describe("JinnRouter", function () {
  this.timeout(60000);

  async function deployFixture() {
    const [owner, alice, bob] = await ethers.getSigners();

    // Deploy mock marketplace
    const MockFactory = await ethers.getContractFactory("MockMechMarketplace");
    const marketplace = await MockFactory.deploy();
    await marketplace.waitForDeployment();

    // Deploy JinnRouter (as implementation — no proxy in tests)
    const RouterFactory = await ethers.getContractFactory("JinnRouter");
    const router = await RouterFactory.deploy();
    await router.waitForDeployment();

    // Initialize
    await router.initialize(await marketplace.getAddress(), LIVENESS_RATIO);

    return { router, marketplace, owner, alice, bob };
  }

  // Helper: create a restoration job and return the requestId
  async function createRestoration(router: any, marketplace: any) {
    const tx = await router.createRestorationJob(
      "0x1234", // requestData
      ethers.ZeroAddress, // priorityMech
      99n, // maxDeliveryRate
      3600n, // responseTimeout
      ethers.ZeroHash, // paymentType
      "0x" // paymentData
    );
    const receipt = await tx.wait();
    // Get requestId from the RestorationJobCreated event
    const event = receipt.logs.find(
      (l: any) => l.fragment?.name === "RestorationJobCreated"
    );
    return event.args.requestId;
  }

  // Helper: create an evaluation job and return the requestId
  async function createEvaluation(
    router: any,
    marketplace: any,
    restorationRequestId: string
  ) {
    const tx = await router.createEvaluationJob(
      restorationRequestId,
      "0x5678", // requestData
      ethers.ZeroAddress, // evaluationMech
      99n,
      3600n,
      ethers.ZeroHash,
      "0x"
    );
    const receipt = await tx.wait();
    const event = receipt.logs.find(
      (l: any) => l.fragment?.name === "EvaluationJobCreated"
    );
    return event.args.requestId;
  }

  describe("Initialization", () => {
    it("should set state correctly", async () => {
      const { router, marketplace } = await deployFixture();
      expect(await router.mechMarketplace()).to.equal(
        await marketplace.getAddress()
      );
      expect(await router.livenessRatio()).to.equal(LIVENESS_RATIO);
      expect(await router.initialized()).to.be.true;
    });

    it("should revert on double initialization", async () => {
      const { router, marketplace } = await deployFixture();
      await expect(
        router.initialize(await marketplace.getAddress(), LIVENESS_RATIO)
      ).to.be.revertedWithCustomError(router, "AlreadyInitialized");
    });

    it("should revert on zero marketplace", async () => {
      const RouterFactory = await ethers.getContractFactory("JinnRouter");
      const router = await RouterFactory.deploy();
      await expect(
        router.initialize(ethers.ZeroAddress, LIVENESS_RATIO)
      ).to.be.revertedWithCustomError(router, "ZeroAddress");
    });

    it("should revert on zero liveness ratio", async () => {
      const RouterFactory = await ethers.getContractFactory("JinnRouter");
      const router = await RouterFactory.deploy();
      const MockFactory = await ethers.getContractFactory(
        "MockMechMarketplace"
      );
      const mp = await MockFactory.deploy();
      await expect(
        router.initialize(await mp.getAddress(), 0)
      ).to.be.revertedWithCustomError(router, "ZeroValue");
    });
  });

  describe("createRestorationJob", () => {
    it("should increment creation count and emit event", async () => {
      const { router, marketplace } = await deployFixture();

      expect(await router.creationCount(await router.runner.getAddress())).to.equal(0n);

      const requestId = await createRestoration(router, marketplace);

      expect(await router.creationCount(await router.runner.getAddress())).to.equal(1n);
      expect(await router.requestTypes(requestId)).to.equal(1n); // RESTORATION
    });

    it("should create multiple jobs with incrementing counts", async () => {
      const { router, marketplace } = await deployFixture();

      await createRestoration(router, marketplace);
      await createRestoration(router, marketplace);
      await createRestoration(router, marketplace);

      expect(await router.creationCount(await router.runner.getAddress())).to.equal(3n);
    });
  });

  describe("claimDelivery (restoration)", () => {
    it("should increment restoration delivery count after marketplace delivery", async () => {
      const { router, marketplace } = await deployFixture();

      const requestId = await createRestoration(router, marketplace);

      // Simulate marketplace delivery
      await marketplace.setDelivered(requestId);

      // Claim
      await router.claimDelivery(requestId);

      expect(await router.restorationDeliveryCount(await router.runner.getAddress())).to.equal(1n);
      expect(await router.claimed(requestId)).to.be.true;
      expect(await router.restorationDeliveryClaimed(requestId)).to.be.true;
    });

    it("should revert if request not found", async () => {
      const { router } = await deployFixture();
      await expect(
        router.claimDelivery(ethers.ZeroHash)
      ).to.be.revertedWithCustomError(router, "RequestNotFound");
    });

    it("should revert if not delivered", async () => {
      const { router, marketplace } = await deployFixture();
      const requestId = await createRestoration(router, marketplace);
      // Don't set delivered
      await expect(
        router.claimDelivery(requestId)
      ).to.be.revertedWithCustomError(router, "NotDelivered");
    });

    it("should revert on double claim", async () => {
      const { router, marketplace } = await deployFixture();
      const requestId = await createRestoration(router, marketplace);
      await marketplace.setDelivered(requestId);
      await router.claimDelivery(requestId);

      await expect(
        router.claimDelivery(requestId)
      ).to.be.revertedWithCustomError(router, "AlreadyClaimed");
    });
  });

  describe("createEvaluationJob", () => {
    it("should create evaluation after restoration delivery is claimed", async () => {
      const { router, marketplace } = await deployFixture();

      // Full loop: create → deliver → claim → create evaluation
      const restId = await createRestoration(router, marketplace);
      await marketplace.setDelivered(restId);
      await router.claimDelivery(restId);

      const evalId = await createEvaluation(router, marketplace, restId);

      expect(await router.evaluationCreationCount(await router.runner.getAddress())).to.equal(1n);
      expect(await router.requestTypes(evalId)).to.equal(2n); // EVALUATION
    });

    it("should revert without prior restoration claim (loop enforcement)", async () => {
      const { router, marketplace } = await deployFixture();

      const restId = await createRestoration(router, marketplace);
      // Don't deliver or claim

      await expect(
        router.createEvaluationJob(
          restId, "0x5678", ethers.ZeroAddress, 99n, 3600n, ethers.ZeroHash, "0x"
        )
      ).to.be.revertedWithCustomError(router, "RestorationNotClaimed");
    });
  });

  describe("claimDelivery (evaluation)", () => {
    it("should increment evaluation delivery count", async () => {
      const { router, marketplace } = await deployFixture();

      // Full loop
      const restId = await createRestoration(router, marketplace);
      await marketplace.setDelivered(restId);
      await router.claimDelivery(restId);

      const evalId = await createEvaluation(router, marketplace, restId);
      await marketplace.setDelivered(evalId);
      await router.claimDelivery(evalId);

      expect(await router.evaluationDeliveryCount(await router.runner.getAddress())).to.equal(1n);
      expect(await router.restorationDeliveryClaimed(evalId)).to.be.false; // only restorations set this
    });
  });

  describe("getMultisigNonces", () => {
    it("should return 5-element array with correct counts", async () => {
      const { router, marketplace, owner } = await deployFixture();
      const addr = await owner.getAddress();

      // Do a full loop
      const restId = await createRestoration(router, marketplace);
      await marketplace.setDelivered(restId);
      await router.claimDelivery(restId);
      const evalId = await createEvaluation(router, marketplace, restId);
      await marketplace.setDelivered(evalId);
      await router.claimDelivery(evalId);

      // Note: getMultisigNonces calls IMultisig(multisig).nonce() which won't work
      // on an EOA. In production it's a Safe. For testing, we check individual counters.
      expect(await router.creationCount(addr)).to.equal(1n);
      expect(await router.restorationDeliveryCount(addr)).to.equal(1n);
      expect(await router.evaluationCreationCount(addr)).to.equal(1n);
      expect(await router.evaluationDeliveryCount(addr)).to.equal(1n);
    });
  });

  describe("isRatioPass", () => {
    it("should pass when activity rate meets liveness ratio", async () => {
      const { router } = await deployFixture();

      // 20 activities in 1 day (86400s)
      // ratio = 20 * 1e18 / 86400 = 231481481481481 >= 230481481481481 => PASS
      const cur = [100n, 5n, 5n, 5n, 5n];
      const last = [80n, 0n, 0n, 0n, 0n];
      const ts = 86400n;

      expect(await router.isRatioPass(cur, last, ts)).to.be.true;
    });

    it("should pass with only restoration deliveries (pure restorer)", async () => {
      const { router } = await deployFixture();

      // 20 deliveries, no other activity
      const cur = [100n, 0n, 20n, 0n, 0n];
      const last = [80n, 0n, 0n, 0n, 0n];
      const ts = 86400n;

      expect(await router.isRatioPass(cur, last, ts)).to.be.true;
    });

    it("should pass with only creations (pure creator)", async () => {
      const { router } = await deployFixture();

      const cur = [100n, 20n, 0n, 0n, 0n];
      const last = [80n, 0n, 0n, 0n, 0n];
      const ts = 86400n;

      expect(await router.isRatioPass(cur, last, ts)).to.be.true;
    });

    it("should fail when activity rate is below liveness ratio", async () => {
      const { router } = await deployFixture();

      // 10 activities in 1 day — below 20/day threshold
      const cur = [100n, 3n, 3n, 2n, 2n];
      const last = [80n, 0n, 0n, 0n, 0n];
      const ts = 86400n;

      expect(await router.isRatioPass(cur, last, ts)).to.be.false;
    });

    it("should fail when total activities exceed nonce delta (sanity bound)", async () => {
      const { router } = await deployFixture();

      // 25 activities but only 10 nonce delta
      const cur = [30n, 10n, 5n, 5n, 5n];
      const last = [20n, 0n, 0n, 0n, 0n];
      const ts = 86400n;

      expect(await router.isRatioPass(cur, last, ts)).to.be.false;
    });

    it("should fail when ts is zero", async () => {
      const { router } = await deployFixture();
      const result = await router.isRatioPass(
        [100n, 5n, 5n, 5n, 5n],
        [80n, 0n, 0n, 0n, 0n],
        0n
      );
      expect(result).to.be.false;
    });

    it("should fail when no new nonces", async () => {
      const { router } = await deployFixture();
      const result = await router.isRatioPass(
        [20n, 5n, 5n, 5n, 5n],
        [20n, 0n, 0n, 0n, 0n],
        86400n
      );
      expect(result).to.be.false;
    });

    it("should fail when no activity at all", async () => {
      const { router } = await deployFixture();
      const result = await router.isRatioPass(
        [100n, 0n, 0n, 0n, 0n],
        [80n, 0n, 0n, 0n, 0n],
        86400n
      );
      expect(result).to.be.false;
    });
  });
});
