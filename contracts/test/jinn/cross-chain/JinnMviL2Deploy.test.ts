/**
 * Tests for `scripts/deploy-jinn-mvi-l2.ts`.
 *
 * Covers:
 *   - chainId gate (Hardhat + Base Sepolia allowed by default; others
 *     require JINN_MVI_ALLOW_CHAIN).
 *   - Happy-path deploy on Hardhat with mock wiring; reads back
 *     emitter.checker / .router / .serviceRegistry and asserts they
 *     match the constructor args.
 *   - Storage-slot assembly gate fires inside the constructor; we
 *     deploy the real `JinnClaimEmitter` so the gate runs.
 */

import { expect } from "chai";
import { ethers } from "hardhat";

import {
  CHAIN_ID_HARDHAT,
  CHAIN_ID_BASE_SEPOLIA,
  CHAIN_ID_BASE_MAINNET,
  JINN_MVI_L2_ALLOWED_CHAINS,
  assertChainIdAllowed,
} from "../../../scripts/lib/jinn-mvi-helpers";
import { deployJinnMviL2 } from "../../../scripts/deploy-jinn-mvi-l2";

describe("Jinn MVI L2 emitter deploy script", function () {
  this.timeout(60_000);

  describe("chainId gate", function () {
    it("allows Hardhat + Base Sepolia by default", function () {
      assertChainIdAllowed({
        chainId: CHAIN_ID_HARDHAT,
        allowed: JINN_MVI_L2_ALLOWED_CHAINS,
        scriptName: "Jinn MVI L2 emitter",
      });
      assertChainIdAllowed({
        chainId: CHAIN_ID_BASE_SEPOLIA,
        allowed: JINN_MVI_L2_ALLOWED_CHAINS,
        scriptName: "Jinn MVI L2 emitter",
      });
    });

    it("rejects Base mainnet without an explicit allow-chain override", function () {
      expect(() =>
        assertChainIdAllowed({
          chainId: CHAIN_ID_BASE_MAINNET,
          allowed: JINN_MVI_L2_ALLOWED_CHAINS,
          scriptName: "Jinn MVI L2 emitter",
        }),
      ).to.throw(`Refusing to deploy Jinn MVI L2 emitter on chainId ${CHAIN_ID_BASE_MAINNET}`);
    });

    it("opts in via JINN_MVI_ALLOW_CHAIN matching the connected chain", function () {
      assertChainIdAllowed({
        chainId: CHAIN_ID_BASE_MAINNET,
        allowed: JINN_MVI_L2_ALLOWED_CHAINS,
        scriptName: "Jinn MVI L2 emitter",
        env: { JINN_MVI_ALLOW_CHAIN: String(CHAIN_ID_BASE_MAINNET) },
      });
    });
  });

  describe("happy-path deploy", function () {
    it("deploys JinnClaimEmitter and round-trips immutable wiring", async function () {
      const [deployer] = await ethers.getSigners();

      // Spin up the V2 mocks the emitter expects. Real-world wiring
      // would point at the V2 router proxy + checker addresses from
      // the phase1b deploy artifact; the mocks share the same
      // interface so we exercise the assembly slot gate end-to-end.
      const Checker = await ethers.getContractFactory("MockCheckerV2");
      const checker = await Checker.deploy();
      await checker.waitForDeployment();
      const Router = await ethers.getContractFactory("MockRouterV2");
      const router = await Router.deploy();
      await router.waitForDeployment();
      const Registry = await ethers.getContractFactory("MockServiceRegistryForEmitter");
      const registry = await Registry.deploy();
      await registry.waitForDeployment();

      const wiring = {
        checker: await checker.getAddress(),
        router: await router.getAddress(),
        registry: await registry.getAddress(),
      };
      const result = await deployJinnMviL2(deployer, wiring);

      expect(result.emitter).to.match(/^0x[0-9a-fA-F]{40}$/);
      expect(result.wiring.checker).to.equal(wiring.checker);
      expect(result.wiring.router).to.equal(wiring.router);
      expect(result.wiring.registry).to.equal(wiring.registry);

      const emitter = await ethers.getContractAt(
        "src/jinn/cross-chain/JinnClaimEmitter.sol:JinnClaimEmitter",
        result.emitter,
      );
      expect(await emitter.checker()).to.equal(wiring.checker);
      expect(await emitter.router()).to.equal(wiring.router);
      expect(await emitter.serviceRegistry()).to.equal(wiring.registry);

      // The emitter is immediately usable: emit a claim through the
      // mock registry so we know the storage-slot gate did not block
      // the deploy.
      const operatorMultisig = ethers.Wallet.createRandom().address;
      await registry.setMultisig(7n, operatorMultisig);
      await checker.setVerifiedCreations(operatorMultisig, 11n);
      await checker.setNoveltyWeightedCounts(operatorMultisig, 22n);
      await router.setEvaluationDeliveryCount(operatorMultisig, 3n);
      await emitter.emitClaim(7n);
      expect(await emitter.nextClaimId()).to.equal(1n);
    });
  });
});
