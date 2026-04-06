const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * Test DeliveryActivityChecker against a Base mainnet fork.
 *
 * Run with:  cd contracts && npx hardhat test --network hardhat
 *
 * Requires hardhat.config.ts to have forking enabled:
 *   forking: { url: "https://mainnet.base.org", enabled: true }
 */

const MECH_MARKETPLACE = "0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020";

// Liveness ratio: 60 deliveries/day = 60 / 86400 * 1e18 ≈ 694444444444444
const LIVENESS_RATIO = 694444444444444n;

// Real multisigs with known delivery counts on Base mainnet
const MULTISIG_WITH_DELIVERIES = "0xa4a5157146c6012ed5cd9bf4b5844a0e6e08d2e1"; // 30 deliveries
const MULTISIG_WITH_REQUESTS = "0xb8b7a89760a4430c3f69eee7ba5d2b985d593d92"; // 21 deliveries, 671 requests

describe("DeliveryActivityChecker", function () {
  this.timeout(60000);

  async function deployChecker() {
    const factory = await ethers.getContractFactory("DeliveryActivityChecker");
    const checker = await factory.deploy(MECH_MARKETPLACE, LIVENESS_RATIO);
    await checker.waitForDeployment();
    return checker;
  }

  describe("Deployment", () => {
    it("should set immutable state correctly", async () => {
      const checker = await deployChecker();
      expect(await checker.mechMarketplace()).to.equal(MECH_MARKETPLACE);
      expect(await checker.livenessRatio()).to.equal(LIVENESS_RATIO);
    });

    it("should revert on zero marketplace address", async () => {
      const factory = await ethers.getContractFactory("DeliveryActivityChecker");
      await expect(
        factory.deploy(ethers.ZeroAddress, LIVENESS_RATIO)
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });

    it("should revert on zero liveness ratio", async () => {
      const factory = await ethers.getContractFactory("DeliveryActivityChecker");
      await expect(
        factory.deploy(MECH_MARKETPLACE, 0)
      ).to.be.revertedWithCustomError(factory, "ZeroValue");
    });
  });

  describe("getMultisigNonces (forked mainnet)", () => {
    it("should return delivery count > 0 for active multisig", async () => {
      const checker = await deployChecker();
      const nonces = await checker.getMultisigNonces(MULTISIG_WITH_DELIVERIES);

      // nonces[0] = multisig nonce (Safe tx count)
      // nonces[1] = mapDeliveryCounts from MechMarketplace
      expect(nonces.length).to.equal(2);
      expect(nonces[0]).to.be.gt(0n, "multisig nonce should be > 0");
      expect(nonces[1]).to.be.gt(0n, "delivery count should be > 0");

      console.log(`    Multisig ${MULTISIG_WITH_DELIVERIES}:`);
      console.log(`      nonce: ${nonces[0]}, deliveries: ${nonces[1]}`);
    });

    it("should return delivery count for second multisig", async () => {
      const checker = await deployChecker();
      const nonces = await checker.getMultisigNonces(MULTISIG_WITH_REQUESTS);

      expect(nonces[1]).to.be.gt(0n, "delivery count should be > 0");

      console.log(`    Multisig ${MULTISIG_WITH_REQUESTS}:`);
      console.log(`      nonce: ${nonces[0]}, deliveries: ${nonces[1]}`);
    });
  });

  describe("isRatioPass", () => {
    it("should pass when delivery rate meets liveness ratio", async () => {
      const checker = await deployChecker();

      // Simulate: 70 deliveries in 1 day (86400 seconds) — above 60/day threshold
      const curNonces = [100n, 80n]; // [nonce, deliveryCount]
      const lastNonces = [20n, 10n]; // [prevNonce, prevDeliveryCount]
      const ts = 86400n; // 1 day

      // diffDeliveries = 70, diffNonces = 80 => 70 <= 80 OK
      // ratio = 70 * 1e18 / 86400 = 810185185185185 >= 694444444444444 => PASS
      const result = await checker.isRatioPass(curNonces, lastNonces, ts);
      expect(result).to.be.true;
    });

    it("should fail when delivery rate is below liveness ratio", async () => {
      const checker = await deployChecker();

      // Simulate: 50 deliveries in 1 day — below 60/day threshold
      const curNonces = [100n, 60n];
      const lastNonces = [20n, 10n];
      const ts = 86400n;

      // diffDeliveries = 50, ratio = 50 * 1e18 / 86400 = 578703703703703 < 694444444444444 => FAIL
      const result = await checker.isRatioPass(curNonces, lastNonces, ts);
      expect(result).to.be.false;
    });

    it("should fail when delivery count exceeds nonce count", async () => {
      const checker = await deployChecker();

      // Anomalous: more deliveries than nonces (sanity bound)
      const curNonces = [30n, 100n];
      const lastNonces = [20n, 10n];
      const ts = 86400n;

      // diffDeliveries = 90, diffNonces = 10 => 90 > 10 => FAIL
      const result = await checker.isRatioPass(curNonces, lastNonces, ts);
      expect(result).to.be.false;
    });

    it("should fail when ts is zero", async () => {
      const checker = await deployChecker();
      const result = await checker.isRatioPass([100n, 80n], [20n, 10n], 0n);
      expect(result).to.be.false;
    });

    it("should fail when no new deliveries", async () => {
      const checker = await deployChecker();
      // curNonces[1] == lastNonces[1] => no new deliveries
      const result = await checker.isRatioPass([100n, 10n], [20n, 10n], 86400n);
      expect(result).to.be.false;
    });

    it("should fail when no new nonces", async () => {
      const checker = await deployChecker();
      // curNonces[0] == lastNonces[0] => no new nonces
      const result = await checker.isRatioPass([20n, 80n], [20n, 10n], 86400n);
      expect(result).to.be.false;
    });
  });
});
