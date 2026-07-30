import { expect } from "chai";
import { network } from "hardhat";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync } from "node:fs";

/**
 * Hardhat adapter for the generic revised-contract conformance driver in
 * `@jinn-network/marketplace-testing`. Requires that package's dist to be built.
 */
describe("marketplace-revision revised-contract-conformance adapter", function () {
  this.timeout(120_000);

  let ethers: Awaited<ReturnType<typeof network.connect>>["ethers"];
  let provider: Awaited<ReturnType<typeof network.connect>>["provider"];

  const TOKEN_PAYMENT_TYPE =
    "0x3679d66ef546e66ce9057c4a052f317b135bc8e8c509638f7966edfd4fcf45e9";
  const RELEASE_MIN_HOLD = 60n;
  const RESPONSE_TIMEOUT = 3600n;

  before(async () => {
    ({ ethers, provider } = await network.connect());
  });

  async function loadDriver() {
    const dist = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../packages/marketplace/testing/dist/revised-contract-conformance.js",
    );
    if (!existsSync(dist)) {
      throw new Error(
        `marketplace-testing dist missing at ${dist}; run yarn build in packages/marketplace/testing first`,
      );
    }
    return import(pathToFileURL(dist).href);
  }

  async function increaseTime(seconds: number | bigint) {
    await provider.send("evm_increaseTime", [Number(seconds)]);
    await provider.send("evm_mine", []);
  }

  async function deployKit() {
    const [owner, creator, solver, evaluator] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("TestERC20");
    const olas = await Token.deploy("OLAS", "OLAS");
    await olas.waitForDeployment();
    const Marketplace = await ethers.getContractFactory("MockTokenMarketplace");
    const marketplace = await Marketplace.deploy();
    await marketplace.waitForDeployment();
    const Tracker = await ethers.getContractFactory("MockTokenBalanceTracker");
    const tracker = await Tracker.deploy(await marketplace.getAddress(), await olas.getAddress());
    await tracker.waitForDeployment();
    await marketplace.setPaymentTypeBalanceTracker(TOKEN_PAYMENT_TYPE, await tracker.getAddress());

    const Coordinator = await ethers.getContractFactory("TaskCoordinatorV4");
    const Router = await ethers.getContractFactory("JinnRouterV4");
    const coordinator = await Coordinator.deploy();
    const router = await Router.deploy();
    await coordinator.waitForDeployment();
    await router.waitForDeployment();
    await coordinator.initialize(await owner.getAddress(), await router.getAddress(), RELEASE_MIN_HOLD, 0);
    await router.initialize(
      await owner.getAddress(),
      await marketplace.getAddress(),
      await coordinator.getAddress(),
      ethers.ZeroAddress,
      await olas.getAddress(),
      TOKEN_PAYMENT_TYPE,
      await tracker.getAddress(),
    );

    const Mech = await ethers.getContractFactory("MockTokenMech");
    const solverMech = await Mech.deploy(100n, TOKEN_PAYMENT_TYPE, await solver.getAddress(), await marketplace.getAddress());
    const evaluatorMech = await Mech.deploy(
      20n,
      TOKEN_PAYMENT_TYPE,
      await evaluator.getAddress(),
      await marketplace.getAddress(),
    );
    await solverMech.waitForDeployment();
    await evaluatorMech.waitForDeployment();
    await marketplace.registerMech(await solverMech.getAddress(), await owner.getAddress());
    await marketplace.registerMech(await evaluatorMech.getAddress(), await owner.getAddress());

    const RequestData = await ethers.getContractFactory("MarketplaceRequestDataView");
    const requestDataView = await RequestData.deploy();
    await requestDataView.waitForDeployment();

    const Batch = await ethers.getContractFactory("AtomicSettlementBatch");
    const batch = await Batch.deploy();
    await batch.waitForDeployment();

    return {
      owner,
      creator,
      solver,
      evaluator,
      olas,
      marketplace,
      tracker,
      coordinator,
      router,
      solverMech,
      evaluatorMech,
      requestDataView,
      batch,
    };
  }

  function policy() {
    const now = BigInt(Math.floor(Date.now() / 1000)) + 10_000n;
    return {
      maxTotal: 1,
      maxConcurrent: 1,
      submissionDeadline: now + 86_400n,
      closeAt: 0n,
      responseTimeout: RESPONSE_TIMEOUT,
      minVerdicts: 1,
      requireDistinctEvaluator: true,
    };
  }

  async function createTask(ctx: Awaited<ReturnType<typeof deployKit>>, solutionRate = 100n, verdictRate = 20n) {
    const p = policy();
    const amount = solutionRate * BigInt(p.maxTotal) + verdictRate * BigInt(p.maxTotal) * BigInt(p.minVerdicts);
    await ctx.olas.mint(await ctx.creator.getAddress(), amount);
    await ctx.olas.connect(ctx.creator).approve(await ctx.router.getAddress(), amount);
    await ctx.router
      .connect(ctx.creator)
      .createTask(ethers.id(`t-${Math.random()}`), ethers.id("s"), p, solutionRate, verdictRate);
    return Number(await ctx.coordinator.nextTaskId()) - 1;
  }

  it("invokes generic driver against deployed V4/mocks", async function () {
    const driver = await loadDriver();
    const ctx = await deployKit();

    const port = {
      async roundTripRequestData(input: any) {
        if (input.leg === "solution") {
          const encoded = await ctx.requestDataView.encodeSolution(
            input.taskId,
            input.attemptIndex,
            input.deliveryDigest,
          );
          const decoded = await ctx.requestDataView.decode(encoded);
          return {
            domain: decoded.domain,
            version: Number(decoded.version),
            legKind: Number(decoded.legKind),
            taskId: decoded.taskId,
            attemptIndex: Number(decoded.attemptIndex),
            verdictIndex: Number(decoded.verdictIndex),
            deliveryDigest: decoded.deliveryDigest,
            verdictCode: Number(decoded.verdictCode),
          };
        }
        const encoded = await ctx.requestDataView.encodeVerdict(
          input.taskId,
          input.attemptIndex,
          input.verdictIndex,
          input.deliveryDigest,
          input.verdictCode,
        );
        const decoded = await ctx.requestDataView.decode(encoded);
        return {
          domain: decoded.domain,
          version: Number(decoded.version),
          legKind: Number(decoded.legKind),
          taskId: decoded.taskId,
          attemptIndex: Number(decoded.attemptIndex),
          verdictIndex: Number(decoded.verdictIndex),
          deliveryDigest: decoded.deliveryDigest,
          verdictCode: Number(decoded.verdictCode),
        };
      },

      async claimWithoutRequestIdArg() {
        const sol = ctx.router.interface.getFunction("claimSolutionDelivery");
        const verd = ctx.router.interface.getFunction("claimVerdictDelivery");
        return { solutionArity: sol.inputs.length, verdictArity: verd.inputs.length };
      },

      async preparationAndEip1271() {
        const taskId = await createTask(ctx);
        await ctx.router.connect(ctx.solver).claimTask(taskId, await ctx.solverMech.getAddress());
        const digest = ethers.id("prep-eip");
        const requestData = await ctx.requestDataView.encodeSolution(taskId, 0, digest);
        const nonce = await ctx.marketplace.mapNonces(await ctx.router.getAddress());
        const mech = await ctx.solverMech.getAddress();
        const unpreparedSig = await ctx.router.encodeAuthSignature(
          1,
          taskId,
          0,
          0,
          mech,
          requestData,
          100n,
          nonce,
        );
        let unpreparedRejected = false;
        try {
          await ctx.solverMech
            .connect(ctx.solver)
            .deliverMarketplaceWithSignatures(
              await ctx.router.getAddress(),
              [{ requestData, signature: unpreparedSig, deliveryData: "0x" }],
              [100n],
              "0x",
            );
        } catch {
          unpreparedRejected = true;
        }
        await ctx.router.connect(ctx.solver).prepareSolutionDelivery(taskId, 0, digest);
        const prep = await ctx.router.solutionPreparations(taskId, 0);
        const sig = await ctx.router.encodeAuthSignature(
          1,
          taskId,
          0,
          0,
          mech,
          requestData,
          100n,
          prep.preparedNonce,
        );
        await ctx.solverMech
          .connect(ctx.solver)
          .deliverMarketplaceWithSignatures(
            await ctx.router.getAddress(),
            [{ requestData, signature: sig, deliveryData: "0x" }],
            [100n],
            "0x",
          );
        return {
          prepared: prep.prepared as boolean,
          unpreparedRejected,
          preparedDelivered: true,
        };
      },

      async conservationAttackRefusal() {
        const kit = await deployKit();
        const taskA = await createTask(kit);
        const taskB = await createTask(kit);
        const amountB =
          100n * 1n + 20n * 1n * 1n;
        await kit.router.connect(kit.solver).claimTask(taskA, await kit.solverMech.getAddress());
        const digest = ethers.id("cons-a");
        await kit.router.connect(kit.solver).prepareSolutionDelivery(taskA, 0, digest);
        const requestData = await kit.requestDataView.encodeSolution(taskA, 0, digest);
        const prep = await kit.router.solutionPreparations(taskA, 0);
        const sig = await kit.router.encodeAuthSignature(
          1,
          taskA,
          0,
          0,
          await kit.solverMech.getAddress(),
          requestData,
          100n,
          prep.preparedNonce,
        );
        await kit.solverMech
          .connect(kit.solver)
          .deliverMarketplaceWithSignatures(
            await kit.router.getAddress(),
            [{ requestData, signature: sig, deliveryData: "0x" }],
            [100n],
            "0x",
          );

        await increaseTime(RELEASE_MIN_HOLD);
        let taskAReservedStuck = false;
        try {
          await kit.router.connect(kit.solver).releaseAttempt(taskA, 0);
        } catch {
          taskAReservedStuck = true;
        }
        const paymentA = await kit.router.taskPayments(taskA);
        taskAReservedStuck = taskAReservedStuck && paymentA.solutionReserved === 100n;

        const before = await kit.olas.balanceOf(await kit.creator.getAddress());
        await kit.router.connect(kit.creator).closeTask(taskB);
        const after = await kit.olas.balanceOf(await kit.creator.getAddress());
        const taskBFullyRefunded = after - before === amountB;

        // Undelivered prepare releases
        const kit2 = await deployKit();
        const taskC = await createTask(kit2);
        await kit2.router.connect(kit2.solver).claimTask(taskC, await kit2.solverMech.getAddress());
        await kit2.router.connect(kit2.solver).prepareSolutionDelivery(taskC, 0, ethers.id("undelivered"));
        await increaseTime(RELEASE_MIN_HOLD);
        await kit2.router.connect(kit2.solver).releaseAttempt(taskC, 0);
        const pC = await kit2.router.taskPayments(taskC);
        const undeliveredPrepareReleases = pC.solutionReserved === 0n && pC.solutionBudgetRemaining === 100n;

        return { taskAReservedStuck, taskBFullyRefunded, undeliveredPrepareReleases };
      },

      async atomicRollback() {
        const kit = await deployKit();
        await provider.send("hardhat_setBalance", [await kit.batch.getAddress(), "0x1000000000000000000"]);
        // Rebuild mech with batch as operator
        const Mech = await ethers.getContractFactory("MockTokenMech");
        const opMech = await Mech.deploy(
          100n,
          TOKEN_PAYMENT_TYPE,
          await kit.batch.getAddress(),
          await kit.marketplace.getAddress(),
        );
        await opMech.waitForDeployment();
        await kit.marketplace.registerMech(await opMech.getAddress(), await kit.owner.getAddress());
        const opSigner = await ethers.getImpersonatedSigner(await kit.batch.getAddress());
        const taskId = await createTask(kit);
        await kit.router.connect(opSigner).claimTask(taskId, await opMech.getAddress());

        const digest = ethers.id("atomic");
        const prepare = kit.router.interface.encodeFunctionData("prepareSolutionDelivery", [taskId, 0, digest]);
        const nonce = await kit.marketplace.mapNonces(await kit.router.getAddress());
        const requestData = await kit.requestDataView.encodeSolution(taskId, 0, digest);
        const signature = await kit.router.encodeAuthSignature(
          1,
          taskId,
          0,
          0,
          await opMech.getAddress(),
          requestData,
          100n,
          nonce,
        );
        const deliver = opMech.interface.encodeFunctionData("deliverMarketplaceWithSignatures", [
          await kit.router.getAddress(),
          [{ requestData, signature, deliveryData: "0x01" }],
          [100n],
          "0x",
        ]);
        const badClaim = kit.router.interface.encodeFunctionData("claimSolutionDelivery", [
          await opMech.getAddress(),
          requestData,
          100n,
          ethers.ZeroHash,
          nonce,
        ]);
        const trackerBefore = await kit.olas.balanceOf(await kit.tracker.getAddress());
        let rolledBack = false;
        try {
          await kit.batch
            .connect(kit.solver)
            .execute3(
              await kit.router.getAddress(),
              prepare,
              await opMech.getAddress(),
              deliver,
              await kit.router.getAddress(),
              badClaim,
            );
        } catch {
          rolledBack =
            (await kit.olas.balanceOf(await kit.tracker.getAddress())) === trackerBefore &&
            (await kit.marketplace.mapNonces(await kit.router.getAddress())) === nonce;
        }
        const goodClaim = kit.router.interface.encodeFunctionData("claimSolutionDelivery", [
          await opMech.getAddress(),
          requestData,
          100n,
          TOKEN_PAYMENT_TYPE,
          nonce,
        ]);
        await kit.batch
          .connect(kit.solver)
          .execute3(
            await kit.router.getAddress(),
            prepare,
            await opMech.getAddress(),
            deliver,
            await kit.router.getAddress(),
            goodClaim,
          );
        const happyPathOk =
          (await kit.olas.balanceOf(await kit.tracker.getAddress())) === trackerBefore + 100n;
        return { rolledBack, happyPathOk };
      },

      async verdictCodeBinding() {
        const kit = await deployKit();
        const taskId = await createTask(kit);
        const solutionDigest = ethers.id("sol-bind");
        await kit.router.connect(kit.solver).claimTask(taskId, await kit.solverMech.getAddress());
        await kit.router.connect(kit.solver).prepareSolutionDelivery(taskId, 0, solutionDigest);
        let requestData = await kit.requestDataView.encodeSolution(taskId, 0, solutionDigest);
        let prep: any = await kit.router.solutionPreparations(taskId, 0);
        let sig = await kit.router.encodeAuthSignature(
          1,
          taskId,
          0,
          0,
          await kit.solverMech.getAddress(),
          requestData,
          100n,
          prep.preparedNonce,
        );
        await kit.solverMech
          .connect(kit.solver)
          .deliverMarketplaceWithSignatures(
            await kit.router.getAddress(),
            [{ requestData, signature: sig, deliveryData: "0x" }],
            [100n],
            "0x",
          );
        await kit.router
          .connect(kit.solver)
          .claimSolutionDelivery(
            await kit.solverMech.getAddress(),
            requestData,
            100n,
            TOKEN_PAYMENT_TYPE,
            prep.preparedNonce,
          );

        const preparedCode = 3;
        const verdictDigest = ethers.id("verdict-bind");
        await kit.router.connect(kit.evaluator).claimEvaluation(taskId, 0, await kit.evaluatorMech.getAddress());
        await kit.router
          .connect(kit.evaluator)
          .prepareVerdictDelivery(taskId, 0, 0, verdictDigest, preparedCode);
        prep = await kit.router.verdictPreparations(taskId, 0, 0);

        const tampered = await kit.requestDataView.encodeVerdict(taskId, 0, 0, verdictDigest, 2);
        let tamperRejected = false;
        try {
          await kit.router
            .connect(kit.evaluator)
            .claimVerdictDelivery(
              await kit.evaluatorMech.getAddress(),
              tampered,
              20n,
              TOKEN_PAYMENT_TYPE,
              prep.preparedNonce,
            );
        } catch {
          tamperRejected = true;
        }

        requestData = await kit.requestDataView.encodeVerdict(taskId, 0, 0, verdictDigest, preparedCode);
        sig = await kit.router.encodeAuthSignature(
          2,
          taskId,
          0,
          0,
          await kit.evaluatorMech.getAddress(),
          requestData,
          20n,
          prep.preparedNonce,
        );
        await kit.evaluatorMech
          .connect(kit.evaluator)
          .deliverMarketplaceWithSignatures(
            await kit.router.getAddress(),
            [{ requestData, signature: sig, deliveryData: "0x" }],
            [20n],
            "0x",
          );
        await kit.router
          .connect(kit.evaluator)
          .claimVerdictDelivery(
            await kit.evaluatorMech.getAddress(),
            requestData,
            20n,
            TOKEN_PAYMENT_TYPE,
            prep.preparedNonce,
          );
        const verdict = await kit.coordinator.getVerdict(taskId, 0, 0);
        return {
          preparedCode,
          claimedCode: Number(verdict.verdictCode),
          tamperRejected,
        };
      },

      async forfeitOccupancyClearance() {
        const [owner, creator, solver] = await ethers.getSigners();
        const Token = await ethers.getContractFactory("TestERC20");
        const olas = await Token.deploy("OLAS", "OLAS");
        await olas.waitForDeployment();
        const Marketplace = await ethers.getContractFactory("MockTokenMarketplace");
        const marketplace = await Marketplace.deploy();
        await marketplace.waitForDeployment();
        const Tracker = await ethers.getContractFactory("MockTokenBalanceTracker");
        const tracker = await Tracker.deploy(await marketplace.getAddress(), await olas.getAddress());
        await tracker.waitForDeployment();
        await marketplace.setPaymentTypeBalanceTracker(TOKEN_PAYMENT_TYPE, await tracker.getAddress());
        const Activity = await ethers.getContractFactory("MockTaskActivityChecker");
        const activity = await Activity.deploy();
        await activity.waitForDeployment();
        const Coordinator = await ethers.getContractFactory("TaskCoordinatorV4");
        const Router = await ethers.getContractFactory("JinnRouterV4");
        const coordinator = await Coordinator.deploy();
        const router = await Router.deploy();
        await coordinator.waitForDeployment();
        await router.waitForDeployment();
        await coordinator.initialize(await owner.getAddress(), await router.getAddress(), RELEASE_MIN_HOLD, 1);
        await router.initialize(
          await owner.getAddress(),
          await marketplace.getAddress(),
          await coordinator.getAddress(),
          await activity.getAddress(),
          await olas.getAddress(),
          TOKEN_PAYMENT_TYPE,
          await tracker.getAddress(),
        );
        const Mech = await ethers.getContractFactory("MockTokenMech");
        const solverMech = await Mech.deploy(100n, TOKEN_PAYMENT_TYPE, await solver.getAddress(), await marketplace.getAddress());
        await solverMech.waitForDeployment();
        await marketplace.registerMech(await solverMech.getAddress(), await owner.getAddress());
        const RequestData = await ethers.getContractFactory("MarketplaceRequestDataView");
        const requestDataView = await RequestData.deploy();
        await requestDataView.waitForDeployment();

        const p = policy();
        const amount = 100n * 2n + 20n * 2n * 1n;
        await olas.mint(await creator.getAddress(), amount);
        await olas.connect(creator).approve(await router.getAddress(), amount);
        await router.connect(creator).createTask(ethers.id("forfeit-occ"), ethers.id("s"), {
          ...p,
          maxTotal: 2,
          maxConcurrent: 1,
        }, 100n, 20n);
        const taskId = Number(await coordinator.nextTaskId()) - 1;
        await router.connect(solver).claimTask(taskId, await solverMech.getAddress());
        const digest = ethers.id("forfeit-occ-sol");
        await router.connect(solver).prepareSolutionDelivery(taskId, 0, digest);
        const requestData = await requestDataView.encodeSolution(taskId, 0, digest);
        const prep = await router.solutionPreparations(taskId, 0);
        const sig = await router.encodeAuthSignature(
          1,
          taskId,
          0,
          0,
          await solverMech.getAddress(),
          requestData,
          100n,
          prep.preparedNonce,
        );
        await solverMech
          .connect(solver)
          .deliverMarketplaceWithSignatures(
            await router.getAddress(),
            [{ requestData, signature: sig, deliveryData: "0x01" }],
            [100n],
            "0x",
          );
        const activityBefore = await activity.solutionDeliveryWeight(await solver.getAddress());
        await router.connect(solver).forfeitDeliveredReservation(taskId, 0, 0, 1);
        const occupancyCleared = (await coordinator.getTask(taskId)).liveOccupancy === 0n;
        const operatorCapCleared = (await coordinator.operatorLiveClaims(await solver.getAddress())) === 0n;
        const noActivityCredit =
          (await activity.solutionDeliveryWeight(await solver.getAddress())) === activityBefore;
        const payment = await router.taskPayments(taskId);
        const spentOutPreserved = payment.solutionSpentOut === 100n && payment.solutionReserved === 0n;
        await router.connect(solver).claimTask(taskId, await solverMech.getAddress());
        const replacementProceeds = (await coordinator.getAttempt(taskId, 1)).status === 1n;
        return {
          occupancyCleared,
          operatorCapCleared,
          noActivityCredit,
          spentOutPreserved,
          replacementProceeds,
        };
      },
    };

    const report = await driver.runRevisedContractConformance(port);
    expect(report.requestDataRoundTrip).to.equal(true);
    expect(report.claimWithoutRequestId).to.equal(true);
    expect(report.preparationEip1271).to.equal(true);
    expect(report.conservationAttackRefusal).to.equal(true);
    expect(report.atomicRollback).to.equal(true);
    expect(report.verdictCodeBinding).to.equal(true);
    expect(report.forfeitOccupancyClearance).to.equal(true);
  });
});
