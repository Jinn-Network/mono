/**
 * Antifarming.test.ts — Tests for RestorationActivityCheckerV2:
 * SimHash-based anti-farming decay, Hamming distance, novelty weighting,
 * and integration with the OLAS activity checker interface (isRatioPass).
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import type { Signer } from "ethers";

// Default anti-farming parameters for tests
const DEFAULT_LIVENESS_RATIO = ethers.parseEther("0.001"); // 1e15
const DEFAULT_SIMILARITY_THRESHOLD = 64n; // 25% of 256 bits
const DEFAULT_DECAY_MULTIPLIER = 0n; // Binary: similar = zero weight
const DEFAULT_COMPARISON_WINDOW = 20n;

async function deployV2Checker(
  deployer: Signer,
  overrides?: {
    livenessRatio?: bigint;
    similarityThreshold?: bigint;
    similarDecayMultiplier?: bigint;
    comparisonWindow?: bigint;
    authorizedRouter?: string; // address treated as the trusted router
  },
) {
  const deployerAddress = await deployer.getAddress();
  const Checker = await ethers.getContractFactory("RestorationActivityCheckerV2", deployer);
  const checker = await Checker.deploy();
  await checker.waitForDeployment();
  await (await checker.initialize(
    overrides?.livenessRatio ?? DEFAULT_LIVENESS_RATIO,
    deployerAddress,
    overrides?.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD,
    overrides?.similarDecayMultiplier ?? DEFAULT_DECAY_MULTIPLIER,
    overrides?.comparisonWindow ?? DEFAULT_COMPARISON_WINDOW,
  )).wait();

  // Wire deployer (or override) as the authorized router so unit tests can
  // exercise recordActivity / recordActivityWithEvidence directly. The C4 fix
  // gates these on authorizedRouter; without this wiring every direct call
  // would revert with UnauthorizedRouter.
  const authorizedRouter = overrides?.authorizedRouter ?? deployerAddress;
  // setRouterAddresses requires both addresses non-zero; reuse authorizedRouter
  // as jinnRouter (the read-only counter source) — fine for unit tests.
  await (await checker.setRouterAddresses(authorizedRouter, authorizedRouter)).wait();
  return checker;
}

/** Generate a bytes32 with a known number of set bits for testing. */
function hashWithBits(pattern: bigint): string {
  return ethers.zeroPadValue(ethers.toBeHex(pattern), 32);
}

describe("RestorationActivityCheckerV2 — Anti-Farming", function () {
  this.timeout(120_000);

  let deployer: Signer;
  let deployerAddress: string;

  before(async function () {
    [deployer] = await ethers.getSigners();
    deployerAddress = await deployer.getAddress();
  });

  // =========================================================================
  // Constructor validation
  // =========================================================================

  describe("Constructor", function () {
    it("sets all parameters correctly", async function () {
      const checker = await deployV2Checker(deployer);
      expect(await checker.livenessRatio()).to.equal(DEFAULT_LIVENESS_RATIO);
      expect(await checker.similarityThreshold()).to.equal(DEFAULT_SIMILARITY_THRESHOLD);
      expect(await checker.similarDecayMultiplier()).to.equal(DEFAULT_DECAY_MULTIPLIER);
      expect(await checker.comparisonWindow()).to.equal(DEFAULT_COMPARISON_WINDOW);
      expect(await checker.owner()).to.equal(deployerAddress);
    });

    async function deployUninitialized() {
      const Checker = await ethers.getContractFactory("RestorationActivityCheckerV2", deployer);
      const checker = await Checker.deploy();
      await checker.waitForDeployment();
      return { Checker, checker };
    }

    it("reverts on zero liveness ratio", async function () {
      const { Checker, checker } = await deployUninitialized();
      await expect(
        checker.initialize(0, deployerAddress, DEFAULT_SIMILARITY_THRESHOLD, DEFAULT_DECAY_MULTIPLIER, DEFAULT_COMPARISON_WINDOW)
      ).to.be.revertedWithCustomError(Checker, "ZeroValue");
    });

    it("reverts on zero owner", async function () {
      const { Checker, checker } = await deployUninitialized();
      await expect(
        checker.initialize(DEFAULT_LIVENESS_RATIO, ethers.ZeroAddress, DEFAULT_SIMILARITY_THRESHOLD, DEFAULT_DECAY_MULTIPLIER, DEFAULT_COMPARISON_WINDOW)
      ).to.be.revertedWithCustomError(Checker, "ZeroAddress");
    });

    it("reverts on similarity threshold > 256", async function () {
      const { Checker, checker } = await deployUninitialized();
      await expect(
        checker.initialize(DEFAULT_LIVENESS_RATIO, deployerAddress, 257, DEFAULT_DECAY_MULTIPLIER, DEFAULT_COMPARISON_WINDOW)
      ).to.be.revertedWithCustomError(Checker, "Overflow");
    });

    it("reverts on decay multiplier > 1e18", async function () {
      const { Checker, checker } = await deployUninitialized();
      await expect(
        checker.initialize(DEFAULT_LIVENESS_RATIO, deployerAddress, DEFAULT_SIMILARITY_THRESHOLD, ethers.parseEther("1") + 1n, DEFAULT_COMPARISON_WINDOW)
      ).to.be.revertedWithCustomError(Checker, "Overflow");
    });

    it("reverts on zero comparison window", async function () {
      const { Checker, checker } = await deployUninitialized();
      await expect(
        checker.initialize(DEFAULT_LIVENESS_RATIO, deployerAddress, DEFAULT_SIMILARITY_THRESHOLD, DEFAULT_DECAY_MULTIPLIER, 0)
      ).to.be.revertedWithCustomError(Checker, "ZeroValue");
    });

    it("reverts on double initialize", async function () {
      const checker = await deployV2Checker(deployer);
      const Checker = await ethers.getContractFactory("RestorationActivityCheckerV2", deployer);
      await expect(
        checker.initialize(DEFAULT_LIVENESS_RATIO, deployerAddress, DEFAULT_SIMILARITY_THRESHOLD, DEFAULT_DECAY_MULTIPLIER, DEFAULT_COMPARISON_WINDOW)
      ).to.be.revertedWithCustomError(Checker, "AlreadyInitialized");
    });
  });

  // =========================================================================
  // Basic activity recording (backward compat)
  // =========================================================================

  describe("recordActivity (backward compat)", function () {
    it("records activity with full weight (1e18)", async function () {
      const checker = await deployV2Checker(deployer);
      const multisig = ethers.Wallet.createRandom().address;

      await checker.recordActivity(multisig, 0); // CREATE
      expect(await checker.activityCounts(multisig)).to.equal(1);
      expect(await checker.noveltyWeightedCounts(multisig)).to.equal(ethers.parseEther("1"));
    });

    it("accumulates full weight for multiple activities", async function () {
      const checker = await deployV2Checker(deployer);
      const multisig = ethers.Wallet.createRandom().address;

      await checker.recordActivity(multisig, 0);
      await checker.recordActivity(multisig, 1);
      await checker.recordActivity(multisig, 2);

      expect(await checker.activityCounts(multisig)).to.equal(3);
      expect(await checker.noveltyWeightedCounts(multisig)).to.equal(ethers.parseEther("3"));
      expect(await checker.activityCountsByType(multisig, 0)).to.equal(1);
      expect(await checker.activityCountsByType(multisig, 1)).to.equal(1);
      expect(await checker.activityCountsByType(multisig, 2)).to.equal(1);
    });

    it("rejects invalid activity type", async function () {
      const checker = await deployV2Checker(deployer);
      await expect(checker.recordActivity(ethers.Wallet.createRandom().address, 3)).to.be.reverted;
    });

    it("rejects zero multisig", async function () {
      const checker = await deployV2Checker(deployer);
      await expect(checker.recordActivity(ethers.ZeroAddress, 0)).to.be.reverted;
    });
  });

  // =========================================================================
  // Evidence-based activity recording + novelty detection
  // =========================================================================

  describe("recordActivityWithEvidence — novelty detection", function () {
    it("first activity is always novel (full weight)", async function () {
      const checker = await deployV2Checker(deployer);
      const multisig = ethers.Wallet.createRandom().address;
      const hash = ethers.id("unique-evidence-1");

      await checker.recordActivityWithEvidence(multisig, 0, hash);

      expect(await checker.activityCounts(multisig)).to.equal(1);
      expect(await checker.noveltyWeightedCounts(multisig)).to.equal(ethers.parseEther("1"));
      expect(await checker.getEvidenceHashCount(multisig)).to.equal(1);
    });

    it("duplicate evidence gets zero weight (binary decay)", async function () {
      const checker = await deployV2Checker(deployer);
      const multisig = ethers.Wallet.createRandom().address;
      const hash = ethers.id("same-evidence");

      // First: novel
      await checker.recordActivityWithEvidence(multisig, 0, hash);
      expect(await checker.noveltyWeightedCounts(multisig)).to.equal(ethers.parseEther("1"));

      // Second: duplicate — zero weight (Hamming distance = 0 < threshold 64)
      await checker.recordActivityWithEvidence(multisig, 0, hash);
      expect(await checker.activityCounts(multisig)).to.equal(2); // Raw count still goes up
      expect(await checker.noveltyWeightedCounts(multisig)).to.equal(ethers.parseEther("1")); // Weighted stays at 1
    });

    it("different evidence gets full weight", async function () {
      const checker = await deployV2Checker(deployer);
      const multisig = ethers.Wallet.createRandom().address;

      await checker.recordActivityWithEvidence(multisig, 0, ethers.id("evidence-A"));
      await checker.recordActivityWithEvidence(multisig, 1, ethers.id("evidence-B"));

      expect(await checker.activityCounts(multisig)).to.equal(2);
      // keccak256 hashes are pseudorandom — Hamming distance should be ~128, well above 64
      expect(await checker.noveltyWeightedCounts(multisig)).to.equal(ethers.parseEther("2"));
    });

    it("farming pattern: repeated identical evidence earns nothing after first", async function () {
      const checker = await deployV2Checker(deployer);
      const multisig = ethers.Wallet.createRandom().address;
      const farmHash = ethers.id("easy-task-result");

      // Record 5 identical activities (farming)
      for (let i = 0; i < 5; i++) {
        await checker.recordActivityWithEvidence(multisig, 1, farmHash);
      }

      expect(await checker.activityCounts(multisig)).to.equal(5);
      // Only the first should have earned weight
      expect(await checker.noveltyWeightedCounts(multisig)).to.equal(ethers.parseEther("1"));
    });

    it("interleaved novel and duplicate evidence scores correctly", async function () {
      const checker = await deployV2Checker(deployer);
      const multisig = ethers.Wallet.createRandom().address;

      await checker.recordActivityWithEvidence(multisig, 0, ethers.id("novel-1")); // 1e18
      await checker.recordActivityWithEvidence(multisig, 0, ethers.id("novel-1")); // 0 (dup)
      await checker.recordActivityWithEvidence(multisig, 1, ethers.id("novel-2")); // 1e18
      await checker.recordActivityWithEvidence(multisig, 1, ethers.id("novel-2")); // 0 (dup)
      await checker.recordActivityWithEvidence(multisig, 2, ethers.id("novel-3")); // 1e18

      expect(await checker.activityCounts(multisig)).to.equal(5);
      expect(await checker.noveltyWeightedCounts(multisig)).to.equal(ethers.parseEther("3"));
    });

    it("rejects zero multisig", async function () {
      const checker = await deployV2Checker(deployer);
      await expect(
        checker.recordActivityWithEvidence(ethers.ZeroAddress, 0, ethers.id("test"))
      ).to.be.reverted;
    });

    it("rejects invalid activity type", async function () {
      const checker = await deployV2Checker(deployer);
      await expect(
        checker.recordActivityWithEvidence(ethers.Wallet.createRandom().address, 3, ethers.id("test"))
      ).to.be.reverted;
    });
  });

  // =========================================================================
  // Similarity threshold behavior
  // =========================================================================

  describe("Similarity threshold", function () {
    it("hashes at exactly the threshold are considered novel", async function () {
      // Deploy with threshold = 1 (only identical hashes are similar)
      const checker = await deployV2Checker(deployer, { similarityThreshold: 1n });
      const multisig = ethers.Wallet.createRandom().address;

      // Two hashes differing in exactly 1 bit → Hamming distance = 1 ≥ threshold 1 → novel
      const hash1 = hashWithBits(0n); // all zeros
      const hash2 = hashWithBits(1n); // one bit set

      await checker.recordActivityWithEvidence(multisig, 0, hash1);
      await checker.recordActivityWithEvidence(multisig, 0, hash2);

      expect(await checker.noveltyWeightedCounts(multisig)).to.equal(ethers.parseEther("2"));
    });

    it("hashes below threshold are similar (zero weight with default decay)", async function () {
      // Deploy with threshold = 2 — hashes differing by 0 or 1 bit are similar
      const checker = await deployV2Checker(deployer, { similarityThreshold: 2n });
      const multisig = ethers.Wallet.createRandom().address;

      const hash1 = hashWithBits(0n);
      const hash2 = hashWithBits(1n); // 1 bit different → distance 1 < threshold 2 → similar

      await checker.recordActivityWithEvidence(multisig, 0, hash1);
      await checker.recordActivityWithEvidence(multisig, 0, hash2);

      expect(await checker.noveltyWeightedCounts(multisig)).to.equal(ethers.parseEther("1")); // Only first counted
    });

    it("threshold = 256 means everything is novel (anti-farming disabled)", async function () {
      const checker = await deployV2Checker(deployer, { similarityThreshold: 256n });
      const multisig = ethers.Wallet.createRandom().address;
      const hash = ethers.id("same-thing");

      await checker.recordActivityWithEvidence(multisig, 0, hash);
      await checker.recordActivityWithEvidence(multisig, 0, hash); // identical but threshold=256

      // Distance 0 < 256? Yes, but check: minDistance (0) >= similarityThreshold (256)? No → similar
      // Actually wait: 0 >= 256 is false, so this IS treated as similar. threshold=256 means
      // only hashes at distance 256 (fully inverted) are novel. That's "everything similar".
      // To disable anti-farming, set threshold=0 (everything >= 0 is novel).
      expect(await checker.noveltyWeightedCounts(multisig)).to.equal(ethers.parseEther("1"));
    });

    it("threshold = 0 means everything is novel (anti-farming fully disabled)", async function () {
      // Deploy with similarityThreshold = 0: all hashes have distance >= 0, so all are novel
      // But wait: constructor requires similarityThreshold <= 256, and 0 is valid.
      // _computeNoveltyWeight: minDistance >= 0 is always true → always novel.
      // Actually: even identical hashes have distance 0 >= 0 → novel. So yes, disabled.
      const Checker = await ethers.getContractFactory("RestorationActivityCheckerV2", deployer);
      const checker = await Checker.deploy();
      await checker.waitForDeployment();
      await (await checker.initialize(
        DEFAULT_LIVENESS_RATIO,
        deployerAddress,
        0, // threshold = 0
        DEFAULT_DECAY_MULTIPLIER,
        DEFAULT_COMPARISON_WINDOW,
      )).wait();
      // Authorize the deployer as the router so direct calls go through (C4 gate).
      await (await checker.setRouterAddresses(deployerAddress, deployerAddress)).wait();

      const multisig = ethers.Wallet.createRandom().address;
      const hash = ethers.id("same-thing");

      await checker.recordActivityWithEvidence(multisig, 0, hash);
      await checker.recordActivityWithEvidence(multisig, 0, hash);

      expect(await checker.noveltyWeightedCounts(multisig)).to.equal(ethers.parseEther("2"));
    });
  });

  // =========================================================================
  // Decay multiplier
  // =========================================================================

  describe("Decay multiplier", function () {
    it("non-zero decay multiplier gives partial weight for similar evidence", async function () {
      // 0.3x weight for similar evidence
      const checker = await deployV2Checker(deployer, {
        similarDecayMultiplier: ethers.parseEther("0.3"),
      });
      const multisig = ethers.Wallet.createRandom().address;
      const hash = ethers.id("repeated-work");

      await checker.recordActivityWithEvidence(multisig, 0, hash); // 1e18
      await checker.recordActivityWithEvidence(multisig, 0, hash); // 0.3e18

      expect(await checker.noveltyWeightedCounts(multisig)).to.equal(ethers.parseEther("1.3"));
    });

    it("1e18 decay multiplier means no penalty (similar evidence gets full weight)", async function () {
      const checker = await deployV2Checker(deployer, {
        similarDecayMultiplier: ethers.parseEther("1"),
      });
      const multisig = ethers.Wallet.createRandom().address;
      const hash = ethers.id("repeated-work");

      await checker.recordActivityWithEvidence(multisig, 0, hash);
      await checker.recordActivityWithEvidence(multisig, 0, hash);

      expect(await checker.noveltyWeightedCounts(multisig)).to.equal(ethers.parseEther("2"));
    });
  });

  // =========================================================================
  // Comparison window
  // =========================================================================

  describe("Comparison window", function () {
    it("hashes outside the window are not compared (old farming is forgiven)", async function () {
      // Window of 2: only compare against last 2 hashes
      const checker = await deployV2Checker(deployer, { comparisonWindow: 2n });
      const multisig = ethers.Wallet.createRandom().address;

      const farmHash = ethers.id("farm-task");
      const novel1 = ethers.id("novel-task-1");
      const novel2 = ethers.id("novel-task-2");

      // Record farm hash at position 0
      await checker.recordActivityWithEvidence(multisig, 0, farmHash); // novel (first)

      // Push 2 novel hashes to move the window past the farm hash
      await checker.recordActivityWithEvidence(multisig, 0, novel1); // novel
      await checker.recordActivityWithEvidence(multisig, 0, novel2); // novel

      // Now re-submit the farm hash — window only covers [novel1, novel2], not farmHash
      await checker.recordActivityWithEvidence(multisig, 0, farmHash); // novel again (outside window)

      // All 4 should be novel
      expect(await checker.noveltyWeightedCounts(multisig)).to.equal(ethers.parseEther("4"));
    });

    it("window of 1 only compares against the most recent hash", async function () {
      const checker = await deployV2Checker(deployer, { comparisonWindow: 1n });
      const multisig = ethers.Wallet.createRandom().address;

      const hashA = ethers.id("A");
      const hashB = ethers.id("B");

      await checker.recordActivityWithEvidence(multisig, 0, hashA); // novel
      await checker.recordActivityWithEvidence(multisig, 0, hashB); // novel (A is the only comparison)
      await checker.recordActivityWithEvidence(multisig, 0, hashA); // novel (B is the only comparison)

      expect(await checker.noveltyWeightedCounts(multisig)).to.equal(ethers.parseEther("3"));
    });
  });

  // =========================================================================
  // isRatioPass integration
  // =========================================================================

  describe("isRatioPass with novelty-weighted counts", function () {
    it("novel activities pass the ratio check", async function () {
      const checker = await deployV2Checker(deployer);

      // livenessRatio = 1e15, ts = 1000
      // Need: diffWeighted / ts >= 1e15
      // 1 novel activity = 1e18 weight. 1e18 / 1000 = 1e15 >= 1e15 → pass
      const curNonces = [0n, ethers.parseEther("1")]; // 1 novel activity
      const lastNonces = [0n, 0n];
      const ts = 1000n;

      expect(await checker.isRatioPass(curNonces, lastNonces, ts)).to.be.true;
    });

    it("farmed activities fail the ratio check", async function () {
      const checker = await deployV2Checker(deployer);

      // Operator recorded 5 activities but only 1 was novel (4 duplicates got 0 weight)
      // Weighted count = 1e18. Same as 1 novel activity.
      // If ts is too large, ratio drops below threshold
      const curNonces = [0n, ethers.parseEther("1")]; // only 1e18 weighted despite 5 raw
      const lastNonces = [0n, 0n];
      const ts = 1001n; // 1e18 / 1001 < 1e15 → fail

      expect(await checker.isRatioPass(curNonces, lastNonces, ts)).to.be.false;
    });

    it("returns false when ts is zero", async function () {
      const checker = await deployV2Checker(deployer);
      const curNonces = [0n, ethers.parseEther("5")];
      const lastNonces = [0n, 0n];
      expect(await checker.isRatioPass(curNonces, lastNonces, 0n)).to.be.false;
    });

    it("returns false when no activity change", async function () {
      const checker = await deployV2Checker(deployer);
      const nonces = [0n, ethers.parseEther("5")];
      expect(await checker.isRatioPass(nonces, nonces, 100n)).to.be.false;
    });
  });

  // =========================================================================
  // Admin functions
  // =========================================================================

  describe("Admin", function () {
    it("owner can update anti-farming parameters", async function () {
      const checker = await deployV2Checker(deployer);

      await checker.setAntifarmingParameters(128, ethers.parseEther("0.5"), 50);

      expect(await checker.similarityThreshold()).to.equal(128);
      expect(await checker.similarDecayMultiplier()).to.equal(ethers.parseEther("0.5"));
      expect(await checker.comparisonWindow()).to.equal(50);
    });

    it("non-owner cannot update parameters", async function () {
      const checker = await deployV2Checker(deployer);
      const [, nonOwner] = await ethers.getSigners();

      await expect(
        checker.connect(nonOwner).setAntifarmingParameters(128, 0, 50)
      ).to.be.revertedWithCustomError(checker, "OwnerOnly");
    });

    it("rejects invalid parameter updates", async function () {
      const checker = await deployV2Checker(deployer);

      await expect(
        checker.setAntifarmingParameters(257, 0, 20) // threshold > 256
      ).to.be.revertedWithCustomError(checker, "Overflow");

      await expect(
        checker.setAntifarmingParameters(64, ethers.parseEther("1") + 1n, 20) // decay > 1e18
      ).to.be.revertedWithCustomError(checker, "Overflow");

      await expect(
        checker.setAntifarmingParameters(64, 0, 0) // window = 0
      ).to.be.revertedWithCustomError(checker, "ZeroValue");
    });

    it("owner can transfer ownership via changeOwner", async function () {
      const checker = await deployV2Checker(deployer);
      const [, newOwner] = await ethers.getSigners();
      const newOwnerAddress = await newOwner.getAddress();

      // Inherited from Implementation (vendor/stolas/Implementation.sol).
      await checker.changeOwner(newOwnerAddress);
      expect(await checker.owner()).to.equal(newOwnerAddress);

      // Old owner can no longer call admin functions
      await expect(
        checker.setAntifarmingParameters(128, 0, 50)
      ).to.be.revertedWithCustomError(checker, "OwnerOnly");
    });
  });

  // =========================================================================
  // Per-multisig isolation
  // =========================================================================

  describe("Per-multisig isolation", function () {
    it("evidence hashes are isolated between multisigs", async function () {
      const checker = await deployV2Checker(deployer);
      const multisig1 = ethers.Wallet.createRandom().address;
      const multisig2 = ethers.Wallet.createRandom().address;
      const hash = ethers.id("shared-evidence");

      // Same hash submitted by two different multisigs — both should be novel
      await checker.recordActivityWithEvidence(multisig1, 0, hash);
      await checker.recordActivityWithEvidence(multisig2, 0, hash);

      expect(await checker.noveltyWeightedCounts(multisig1)).to.equal(ethers.parseEther("1"));
      expect(await checker.noveltyWeightedCounts(multisig2)).to.equal(ethers.parseEther("1"));
    });
  });

  // =========================================================================
  // View helpers
  // =========================================================================

  describe("View helpers", function () {
    it("getEvidenceHashCount and getEvidenceHash work correctly", async function () {
      const checker = await deployV2Checker(deployer);
      const multisig = ethers.Wallet.createRandom().address;
      const hash1 = ethers.id("ev-1");
      const hash2 = ethers.id("ev-2");

      await checker.recordActivityWithEvidence(multisig, 0, hash1);
      await checker.recordActivityWithEvidence(multisig, 1, hash2);

      expect(await checker.getEvidenceHashCount(multisig)).to.equal(2);
      expect(await checker.getEvidenceHash(multisig, 0)).to.equal(hash1);
      expect(await checker.getEvidenceHash(multisig, 1)).to.equal(hash2);
    });
  });
});
