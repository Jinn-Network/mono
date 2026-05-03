/**
 * Tests for `scripts/deploy-jinn-mvi-l2.ts`.
 *
 * Covers:
 *   - chainId gate (Hardhat + Base Sepolia allowed by default; others
 *     require JINN_MVI_ALLOW_CHAIN).
 *   - Happy-path deploy on Hardhat with mock wiring; reads back
 *     emitter.checker / .serviceRegistry and asserts they
 *     match the constructor args.
 *   - Storage-slot assembly gate fires inside the constructor; we
 *     deploy the real `TaskClaimEmitter` so the gate runs.
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
    it("deploys TaskClaimEmitter and round-trips immutable wiring", async function () {
      const [deployer] = await ethers.getSigners();

      // Spin up the Task-native mocks the emitter expects. Real-world
      // wiring points at the V3 activity checker from the TaskCoordinator
      // deploy artifact; the mocks share the same
      // interface so we exercise the assembly slot gate end-to-end.
      const Checker = await ethers.getContractFactory("MockTaskActivityCheckerSnapshot");
      const checker = await Checker.deploy();
      await checker.waitForDeployment();
      const Registry = await ethers.getContractFactory("MockServiceRegistryForEmitter");
      const registry = await Registry.deploy();
      await registry.waitForDeployment();

      const wiring = {
        checker: await checker.getAddress(),
        registry: await registry.getAddress(),
      };
      const result = await deployJinnMviL2(deployer, wiring);

      expect(result.emitter).to.match(/^0x[0-9a-fA-F]{40}$/);
      expect(result.wiring.checker).to.equal(wiring.checker);
      expect(result.wiring.registry).to.equal(wiring.registry);

      const emitter = await ethers.getContractAt(
        "src/jinn/cross-chain/TaskClaimEmitter.sol:TaskClaimEmitter",
        result.emitter,
      );
      expect(await emitter.checker()).to.equal(wiring.checker);
      expect(await emitter.serviceRegistry()).to.equal(wiring.registry);

      // The emitter is immediately usable: emit a claim through the
      // mock registry so we know the storage-slot gate did not block
      // the deploy.
      const operatorMultisig = ethers.Wallet.createRandom().address;
      await registry.setMultisig(7n, operatorMultisig);
      await checker.setTaskCreationWeight(operatorMultisig, 11n);
      await checker.setSolutionDeliveryWeight(operatorMultisig, 22n);
      await checker.setVerdictDeliveryWeight(operatorMultisig, 3n);
      await emitter.emitClaim(7n);
      expect(await emitter.nextClaimId()).to.equal(1n);
    });
  });
});
