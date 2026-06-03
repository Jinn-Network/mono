/**
 * JinnDistributorDeployFlow.test.ts — Phase A5 of the Jinn v0 MVI.
 *
 * End-to-end test that exercises the deploy-jinn-mvi-l1 script's wiring on
 * the Hardhat network and proves the full handover ceremony works:
 *
 *   1. Run {deployJinnMviL1} with a mock messenger.
 *   2. Verify post-deploy invariants:
 *        - JINN.minter == JinnDistributor
 *        - JINN.owner is still the deployer (Timelock pending)
 *        - JinnDistributor.owner is still the deployer (Timelock pending)
 *        - JINN.pendingOwner == Timelock
 *        - JinnDistributor.pendingOwner == Timelock
 *        - JinnDistributor.daoTreasury == Timelock
 *   3. Simulate the first-Governor-proposal handover by impersonating the
 *      Timelock and calling {acceptOwnership} on both JINN and the
 *      distributor. Verify ownership transferred.
 *   4. Submit a JinnDistributor.claim() via the MockMessenger fixture.
 *      Verify the operator-share JINN landed on the operator multisig and
 *      the DAO-share JINN landed on the Timelock.
 *   5. Sanity-check the canonical-mode wiring path by deploying the
 *      CanonicalOpStackMessenger with placeholder addresses and confirming
 *      it shows up in the deployment artifact.
 *
 * Reference: docs/planning/2026-04-jinn-mvi-on-olas.md and
 * 2026-04-jinn-cross-chain.md for the locked initial values used here.
 */

import { expect } from "chai";
import { network } from "hardhat";

import {
  FAST_TEST_GOVERNANCE_CONFIG,
  LOCKED_DISTRIBUTOR_INITIAL_CONFIG,
  CLAIM_TICKET_TOPIC,
  CHAIN_ID_HARDHAT,
  CHAIN_ID_SEPOLIA,
  CHAIN_ID_BASE_MAINNET,
  JINN_MVI_L1_ALLOWED_CHAINS,
  assertChainIdAllowed,
  resolveJinnMviTimingProfileForChain,
} from "../../../scripts/lib/jinn-mvi-helpers.js";
import {
  deployJinnMviL1,
  resolveRenounceAdmin,
  verifyDeploy,
  type MessengerDeployParams,
} from "../../../scripts/deploy-jinn-mvi-l1.js";

type HardhatEthers = Awaited<ReturnType<typeof network.connect>>["ethers"];

const ONE = 10n ** 18n;

const JINN_FQN = "src/jinn/token/JINN.sol:JINN";
const DISTRIBUTOR_FQN = "src/jinn/distribution/JinnDistributor.sol:JinnDistributor";
const MOCK_MESSENGER_FQN = "src/jinn/cross-chain/MockMessenger.sol:MockMessenger";
const CANONICAL_MESSENGER_FQN =
  "src/jinn/cross-chain/CanonicalOpStackMessenger.sol:CanonicalOpStackMessenger";

function encodeServiceProof(ethers: HardhatEthers, serviceId: bigint): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [serviceId]);
}

/**
 * Move the deployer-held ownership of `jinn` and `distributor` to `timelock`
 * by impersonating the Timelock and calling `acceptOwnership` on both. This
 * mirrors what the first Governor proposal does on a live network.
 */
async function timelockAcceptsOwnership(
  ethers: HardhatEthers,
  jinn: any,
  distributor: any,
  timelockAddress: string,
): Promise<void> {
  await ethers.provider.send("hardhat_impersonateAccount", [timelockAddress]);
  await ethers.provider.send("hardhat_setBalance", [
    timelockAddress,
    "0x" + (10n ** 18n).toString(16),
  ]);
  const timelockSigner = await ethers.getSigner(timelockAddress);
  await jinn.connect(timelockSigner).acceptOwnership();
  await distributor.connect(timelockSigner).acceptOwnership();
  await ethers.provider.send("hardhat_stopImpersonatingAccount", [
    timelockAddress,
  ]);
}

describe("JinnDistributor deploy + handover flow (Phase A5)", function () {
  this.timeout(120_000);

  let ethers: HardhatEthers;

  before(async function () {
    ({ ethers } = await network.connect());
  });

  describe("mock messenger mode (fast-test default)", function () {
    it("post-deploy: JINN.minter is the distributor, ownership is pending Timelock", async function () {
      const [deployer] = await ethers.getSigners();

      const result = await deployJinnMviL1(ethers, deployer, FAST_TEST_GOVERNANCE_CONFIG, {
        messenger: { mode: "mock" },
        distributorConfig: { ...LOCKED_DISTRIBUTOR_INITIAL_CONFIG },
      });

      expect(result.messengerMode).to.equal("mock");

      const jinn = await ethers.getContractAt(JINN_FQN, result.jinn);
      const distributor = await ethers.getContractAt(
        DISTRIBUTOR_FQN,
        result.distributor,
      );

      // Distributor is the minter; minting is gated on JINN.minter == sender.
      expect(await jinn.minter()).to.equal(result.distributor);

      // Both ownerships are still on the deployer; Timelock is the pending
      // owner on both. This is the canonical post-deploy state and the gate
      // for the first Governor proposal.
      expect(await jinn.owner()).to.equal(deployer.address);
      expect(await jinn.pendingOwner()).to.equal(result.timelock);
      expect(await distributor.owner()).to.equal(deployer.address);
      expect(await distributor.pendingOwner()).to.equal(result.timelock);

      // Distributor's DAO-share recipient is the Timelock.
      expect(await distributor.daoTreasury()).to.equal(result.timelock);

      // Distributor wiring matches the locked initial config.
      expect(await distributor.operatorRatio()).to.equal(
        LOCKED_DISTRIBUTOR_INITIAL_CONFIG.operatorRatio,
      );
      expect(await distributor.daoRatio()).to.equal(
        LOCKED_DISTRIBUTOR_INITIAL_CONFIG.daoRatio,
      );
      expect(await distributor.wTaskCreation()).to.equal(
        LOCKED_DISTRIBUTOR_INITIAL_CONFIG.wTaskCreation,
      );
      expect(await distributor.wSolutionDelivery()).to.equal(
        LOCKED_DISTRIBUTOR_INITIAL_CONFIG.wSolutionDelivery,
      );
      expect(await distributor.wVerdictDelivery()).to.equal(
        LOCKED_DISTRIBUTOR_INITIAL_CONFIG.wVerdictDelivery,
      );
    });

    it("Timelock acceptOwnership ceremony transfers both JINN and Distributor", async function () {
      const [deployer] = await ethers.getSigners();
      const result = await deployJinnMviL1(ethers, deployer, FAST_TEST_GOVERNANCE_CONFIG, {
        messenger: { mode: "mock" },
      });

      const jinn = await ethers.getContractAt(JINN_FQN, result.jinn);
      const distributor = await ethers.getContractAt(
        DISTRIBUTOR_FQN,
        result.distributor,
      );

      await timelockAcceptsOwnership(ethers, jinn, distributor, result.timelock);

      expect(await jinn.owner()).to.equal(result.timelock);
      expect(await jinn.pendingOwner()).to.equal(ethers.ZeroAddress);
      expect(await distributor.owner()).to.equal(result.timelock);
      expect(await distributor.pendingOwner()).to.equal(ethers.ZeroAddress);
    });

    it("happy-path claim: JINN mints to operator multisig and to Timelock", async function () {
      const [deployer, operatorMultisig] = await ethers.getSigners();
      const result = await deployJinnMviL1(ethers, deployer, FAST_TEST_GOVERNANCE_CONFIG, {
        messenger: { mode: "mock" },
      });

      const jinn = await ethers.getContractAt(JINN_FQN, result.jinn);
      const distributor = await ethers.getContractAt(
        DISTRIBUTOR_FQN,
        result.distributor,
      );
      const messenger = await ethers.getContractAt(
        MOCK_MESSENGER_FQN,
        result.messenger,
      );

      // Run the Timelock acceptOwnership ceremony so the post-handover state
      // is exercised end-to-end.
      await timelockAcceptsOwnership(ethers, jinn, distributor, result.timelock);

      // Pre-claim: zero supply.
      expect(await jinn.totalSupply()).to.equal(0n);
      expect(await jinn.balanceOf(operatorMultisig.address)).to.equal(0n);
      expect(await jinn.balanceOf(result.timelock)).to.equal(0n);

      // Inject a fixture for a service whose multisig is operatorMultisig.
      // Snapshot picks small numbers so weighted is exact under the locked
      // weights {1,1,1} and the locked ratios {0.75, 0.25}.
      //
      //   weighted = 1*10 + 1*20 + 1*5 = 35
      //   entitledOperator = 35 * 0.75e18 / 1e18 = 26
      //   entitledDao      = 35 * 0.25e18 / 1e18 =  8
      const SERVICE_ID = 7n;
      await messenger.connect(deployer).setFixture(SERVICE_ID, {
        serviceId: SERVICE_ID,
        taskCreationWeight: 10n,
        solutionDeliveryWeight: 20n,
        verdictDeliveryWeight: 5n,
        multisig: operatorMultisig.address,
      });

      const weighted = 35n;
      const entitledOperator =
        (weighted * LOCKED_DISTRIBUTOR_INITIAL_CONFIG.operatorRatio) / ONE;
      const entitledDao =
        (weighted * LOCKED_DISTRIBUTOR_INITIAL_CONFIG.daoRatio) / ONE;
      expect(entitledOperator).to.equal(26n);
      expect(entitledDao).to.equal(8n);

      // Anyone can submit the proof — the recovered multisig + daoTreasury
      // are the mint recipients regardless of who pays gas.
      await expect(distributor.claim(encodeServiceProof(ethers, SERVICE_ID)))
        .to.emit(distributor, "Claimed")
        .withArgs(
          SERVICE_ID,
          operatorMultisig.address,
          entitledOperator,
          entitledDao,
          entitledOperator,
          entitledDao,
        );

      // Operator multisig got the operator share.
      expect(await jinn.balanceOf(operatorMultisig.address)).to.equal(
        entitledOperator,
      );
      // Timelock (= daoTreasury) got the DAO share.
      expect(await jinn.balanceOf(result.timelock)).to.equal(entitledDao);
      expect(await jinn.totalSupply()).to.equal(entitledOperator + entitledDao);

      // Accumulators advanced to the entitled high-water mark.
      expect(await distributor.totalClaimedOperator(SERVICE_ID)).to.equal(
        entitledOperator,
      );
      expect(await distributor.totalClaimedDao(SERVICE_ID)).to.equal(entitledDao);
    });

    it("replay protection: re-submitting the same proof is a clean no-op", async function () {
      const [deployer, operatorMultisig] = await ethers.getSigners();
      const result = await deployJinnMviL1(ethers, deployer, FAST_TEST_GOVERNANCE_CONFIG, {
        messenger: { mode: "mock" },
      });
      const jinn = await ethers.getContractAt(JINN_FQN, result.jinn);
      const distributor = await ethers.getContractAt(
        DISTRIBUTOR_FQN,
        result.distributor,
      );
      const messenger = await ethers.getContractAt(
        MOCK_MESSENGER_FQN,
        result.messenger,
      );

      const SERVICE_ID = 99n;
      await messenger.connect(deployer).setFixture(SERVICE_ID, {
        serviceId: SERVICE_ID,
        taskCreationWeight: 10n,
        solutionDeliveryWeight: 20n,
        verdictDeliveryWeight: 5n,
        multisig: operatorMultisig.address,
      });

      await distributor.claim(encodeServiceProof(ethers, SERVICE_ID));
      const supplyAfterFirst = await jinn.totalSupply();

      // Replay — accumulators are sticky, no further mint, no event.
      const tx = await distributor.claim(encodeServiceProof(ethers, SERVICE_ID));
      const receipt = await tx.wait();
      expect(await jinn.totalSupply()).to.equal(supplyAfterFirst);
      const claimedTopic = distributor.interface.getEvent("Claimed")!.topicHash;
      const hasClaimedLog = receipt!.logs.some(
        (l: any) => l.topics[0] === claimedTopic,
      );
      expect(hasClaimedLog).to.equal(false);
    });
  });

  describe("chainId guard (Fix 8)", function () {
    it("allows hardhat (31337) and sepolia (11155111) by default", function () {
      assertChainIdAllowed({
        chainId: CHAIN_ID_HARDHAT,
        allowed: JINN_MVI_L1_ALLOWED_CHAINS,
        scriptName: "test",
      });
      assertChainIdAllowed({
        chainId: CHAIN_ID_SEPOLIA,
        allowed: JINN_MVI_L1_ALLOWED_CHAINS,
        scriptName: "test",
      });
    });

    it("rejects unknown chains (e.g. Base mainnet) with an actionable message", function () {
      expect(() =>
        assertChainIdAllowed({
          chainId: CHAIN_ID_BASE_MAINNET,
          allowed: JINN_MVI_L1_ALLOWED_CHAINS,
          scriptName: "Jinn MVI L1 stack",
        }),
      ).to.throw(`Refusing to deploy Jinn MVI L1 stack on chainId ${CHAIN_ID_BASE_MAINNET}`);
    });

    it("opts in via JINN_MVI_ALLOW_CHAIN matching the connected chain", function () {
      // Override grants an explicit pass for a single chain id.
      assertChainIdAllowed({
        chainId: CHAIN_ID_BASE_MAINNET,
        allowed: JINN_MVI_L1_ALLOWED_CHAINS,
        scriptName: "test",
        env: { JINN_MVI_ALLOW_CHAIN: String(CHAIN_ID_BASE_MAINNET) },
      });
    });

    it("override does not bypass other chains", function () {
      expect(() =>
        assertChainIdAllowed({
          chainId: CHAIN_ID_BASE_MAINNET,
          allowed: JINN_MVI_L1_ALLOWED_CHAINS,
          scriptName: "test",
          env: { JINN_MVI_ALLOW_CHAIN: "999" },
        }),
      ).to.throw();
    });
  });

  describe("chainId-aware default timing profile (Fix 9)", function () {
    it("returns fast-test on Sepolia + Hardhat by default", function () {
      expect(resolveJinnMviTimingProfileForChain(CHAIN_ID_HARDHAT, {})).to.equal(
        "fast-test",
      );
      expect(resolveJinnMviTimingProfileForChain(CHAIN_ID_SEPOLIA, {})).to.equal(
        "fast-test",
      );
    });

    it("returns canonical on mainnet by default", function () {
      expect(resolveJinnMviTimingProfileForChain(1, {})).to.equal("canonical");
    });

    it("explicit JINN_MVI_TIMING_PROFILE wins on every chain", function () {
      expect(
        resolveJinnMviTimingProfileForChain(CHAIN_ID_HARDHAT, {
          JINN_MVI_TIMING_PROFILE: "canonical",
        }),
      ).to.equal("canonical");
      expect(
        resolveJinnMviTimingProfileForChain(1, {
          JINN_MVI_TIMING_PROFILE: "fast-test",
        }),
      ).to.equal("fast-test");
    });
  });

  describe("MockMessenger ownership transfer (Fix 10)", function () {
    it("transfers ownership when JINN_MVI_MOCK_MESSENGER_OWNER differs from deployer", async function () {
      const [deployer, daemonKey] = await ethers.getSigners();
      const result = await deployJinnMviL1(ethers, deployer, FAST_TEST_GOVERNANCE_CONFIG, {
        messenger: { mode: "mock" },
        mockMessengerOwner: daemonKey.address,
      });
      expect(result.messengerOwner).to.equal(daemonKey.address);

      const messenger = await ethers.getContractAt(
        MOCK_MESSENGER_FQN,
        result.messenger,
      );
      expect(await messenger.owner()).to.equal(daemonKey.address);

      // Daemon key can plant fixtures. The deployer no longer can.
      await messenger.connect(daemonKey).setFixture(99n, {
        serviceId: 99n,
        taskCreationWeight: 1n,
        solutionDeliveryWeight: 1n,
        verdictDeliveryWeight: 1n,
        multisig: deployer.address,
      });
      await expect(
        messenger.connect(deployer).setFixture(99n, {
          serviceId: 99n,
          taskCreationWeight: 1n,
          solutionDeliveryWeight: 1n,
          verdictDeliveryWeight: 1n,
          multisig: deployer.address,
        }),
      ).to.be.revertedWith("MockMessenger: not owner");
    });

    it("keeps the deployer as owner when no override is supplied", async function () {
      const [deployer] = await ethers.getSigners();
      const result = await deployJinnMviL1(ethers, deployer, FAST_TEST_GOVERNANCE_CONFIG, {
        messenger: { mode: "mock" },
      });
      expect(result.messengerOwner).to.equal(deployer.address);
    });
  });

  describe("Opt-in admin renunciation (Fix 11)", function () {
    it("default is false on Sepolia, true on mainnet, false on Hardhat", function () {
      expect(resolveRenounceAdmin(CHAIN_ID_HARDHAT, {})).to.equal(false);
      expect(resolveRenounceAdmin(CHAIN_ID_SEPOLIA, {})).to.equal(false);
      expect(resolveRenounceAdmin(1, {})).to.equal(true);
    });

    it("env var overrides chain default in either direction", function () {
      expect(
        resolveRenounceAdmin(1, { JINN_MVI_RENOUNCE_ADMIN: "false" }),
      ).to.equal(false);
      expect(
        resolveRenounceAdmin(CHAIN_ID_SEPOLIA, {
          JINN_MVI_RENOUNCE_ADMIN: "true",
        }),
      ).to.equal(true);
    });

    it("renounceAdmin=false leaves the deployer as Timelock admin", async function () {
      const [deployer] = await ethers.getSigners();
      const result = await deployJinnMviL1(ethers, deployer, FAST_TEST_GOVERNANCE_CONFIG, {
        messenger: { mode: "mock" },
        renounceAdmin: false,
      });
      expect(result.adminRenounced).to.equal(false);

      const timelock = await ethers.getContractAt(
        "@openzeppelin/contracts/governance/TimelockController.sol:TimelockController",
        result.timelock,
      );
      const adminRole = await timelock.DEFAULT_ADMIN_ROLE();
      expect(await timelock.hasRole(adminRole, deployer.address)).to.equal(true);
    });

    it("renounceAdmin=true clears the admin role from the deployer", async function () {
      const [deployer] = await ethers.getSigners();
      const result = await deployJinnMviL1(ethers, deployer, FAST_TEST_GOVERNANCE_CONFIG, {
        messenger: { mode: "mock" },
        renounceAdmin: true,
      });
      expect(result.adminRenounced).to.equal(true);

      const timelock = await ethers.getContractAt(
        "@openzeppelin/contracts/governance/TimelockController.sol:TimelockController",
        result.timelock,
      );
      const adminRole = await timelock.DEFAULT_ADMIN_ROLE();
      expect(await timelock.hasRole(adminRole, deployer.address)).to.equal(false);
    });
  });

  describe("Post-deploy sanity assertions (Fix 12)", function () {
    it("verifyDeploy passes on a clean deploy with renounceAdmin=true", async function () {
      const [deployer] = await ethers.getSigners();
      const result = await deployJinnMviL1(ethers, deployer, FAST_TEST_GOVERNANCE_CONFIG, {
        messenger: { mode: "mock" },
        renounceAdmin: true,
      });
      // Should not throw.
      await verifyDeploy(ethers, result, deployer.address, true);
    });

    it("verifyDeploy passes on a clean deploy with renounceAdmin=false", async function () {
      const [deployer] = await ethers.getSigners();
      const result = await deployJinnMviL1(ethers, deployer, FAST_TEST_GOVERNANCE_CONFIG, {
        messenger: { mode: "mock" },
        renounceAdmin: false,
      });
      await verifyDeploy(ethers, result, deployer.address, false);
    });

    it("verifyDeploy throws when renounceAdmin asserts but the role is still held", async function () {
      const [deployer] = await ethers.getSigners();
      const result = await deployJinnMviL1(ethers, deployer, FAST_TEST_GOVERNANCE_CONFIG, {
        messenger: { mode: "mock" },
        renounceAdmin: false, // role retained
      });
      // Lie to verifyDeploy: claim we renounced when we didn't.
      let threw = false;
      try {
        await verifyDeploy(ethers, result, deployer.address, true);
      } catch (e: any) {
        threw = true;
        expect(String(e.message)).to.match(/DEFAULT_ADMIN_ROLE/);
      }
      expect(threw).to.equal(true);
    });
  });

  describe("canonical messenger mode wiring", function () {
    it("deploys CanonicalOpStackMessenger with the locked ClaimTicket topic", async function () {
      const [deployer, fakePortal, fakeFactory, fakeEmitter] =
        await ethers.getSigners();

      // Use placeholder addresses — we only assert wiring, not proof
      // verification. Real verification arrives under jinn-mono-7x5.
      const params: MessengerDeployParams = {
        mode: "canonical",
        wiring: {
          optimismPortal: fakePortal.address,
          disputeGameFactory: fakeFactory.address,
          expectedEmitter: fakeEmitter.address,
          claimTicketTopic: CLAIM_TICKET_TOPIC,
        },
      };

      const result = await deployJinnMviL1(
        ethers,
        deployer,
        FAST_TEST_GOVERNANCE_CONFIG,
        { messenger: params },
      );

      expect(result.messengerMode).to.equal("canonical");

      const messenger = await ethers.getContractAt(
        CANONICAL_MESSENGER_FQN,
        result.messenger,
      );
      expect(await messenger.optimismPortal()).to.equal(fakePortal.address);
      expect(await messenger.disputeGameFactory()).to.equal(fakeFactory.address);
      expect(await messenger.expectedEmitter()).to.equal(fakeEmitter.address);
      expect(await messenger.claimTicketTopic()).to.equal(CLAIM_TICKET_TOPIC);

      // Distributor is wired to the canonical messenger.
      const distributor = await ethers.getContractAt(
        DISTRIBUTOR_FQN,
        result.distributor,
      );
      expect(await distributor.messenger()).to.equal(result.messenger);
    });
  });
});
