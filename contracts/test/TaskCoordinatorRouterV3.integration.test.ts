import { expect } from "chai";
import { network } from "hardhat";

describe("TaskCoordinator + JinnRouterV3 integration", function () {
  let ethers: Awaited<ReturnType<typeof network.connect>>["ethers"];

  let TASK_CID: string;
  let EVAL_TASK_CID: string;
  let SOLVER_TYPE: string;
  let SOLUTION_A: string;
  let SOLUTION_B: string;
  let VERDICT_A: string;
  let VERDICT_B: string;
  const NATIVE_PAYMENT_TYPE = "0xba699a34be8fe0e7725e93dcbce1701b0211a8ca61330aaeb8a05bf2ec7abed1";
  let ONE: bigint;

  before(async () => {
    ({ ethers } = await network.connect());
    TASK_CID = ethers.keccak256(ethers.toUtf8Bytes("prediction-v1-task"));
    EVAL_TASK_CID = ethers.keccak256(ethers.toUtf8Bytes("prediction-v1-evaluation-task"));
    SOLVER_TYPE = ethers.keccak256(ethers.toUtf8Bytes("prediction.v1"));
    SOLUTION_A = ethers.keccak256(ethers.toUtf8Bytes("solution-a"));
    SOLUTION_B = ethers.keccak256(ethers.toUtf8Bytes("solution-b"));
    VERDICT_A = ethers.keccak256(ethers.toUtf8Bytes("verdict-a"));
    VERDICT_B = ethers.keccak256(ethers.toUtf8Bytes("verdict-b"));
    ONE = ethers.parseEther("1");
  });

  function policy(maxClaims = 2, allowSolverSelfEvaluation = false) {
    return { maxClaims, allowSolverSelfEvaluation };
  }

  async function deploy(
    solutionRate = ethers.parseEther("0.01"),
    verdictRate = ethers.parseEther("0.005"),
    activityKind: "mock" | "v3" = "mock",
  ) {
    const [owner, creator, operatorA, operatorB, evaluator, dao] = await ethers.getSigners();

    const Coordinator = await ethers.getContractFactory("TaskCoordinator");
    const coordinator = await Coordinator.deploy();
    await coordinator.waitForDeployment();

    const Marketplace = await ethers.getContractFactory("MockTaskMarketplace");
    const marketplace = await Marketplace.deploy();
    await marketplace.waitForDeployment();

    let activity: any;
    if (activityKind === "v3") {
      const Activity = await ethers.getContractFactory("TaskActivityCheckerV3");
      activity = await Activity.deploy();
      await activity.waitForDeployment();
      await activity.initialize(ethers.parseEther("0.001"), await owner.getAddress(), 64, 0, 20);
    } else {
      const Activity = await ethers.getContractFactory("MockTaskActivityChecker");
      activity = await Activity.deploy();
      await activity.waitForDeployment();
    }

    const Router = await ethers.getContractFactory("JinnRouterV3");
    const router = await Router.deploy();
    await router.waitForDeployment();

    await coordinator.initialize(await owner.getAddress(), await router.getAddress());
    await router.initialize(
      await owner.getAddress(),
      await marketplace.getAddress(),
      await coordinator.getAddress(),
      await activity.getAddress(),
    );
    if (activityKind === "v3") {
      await activity.connect(owner).setAuthorizedRouter(await router.getAddress());
    }

    const Mech = await ethers.getContractFactory("MockTaskMech");
    const mechA = await Mech.deploy(solutionRate, NATIVE_PAYMENT_TYPE, await operatorA.getAddress());
    await mechA.waitForDeployment();
    const mechB = await Mech.deploy(solutionRate, NATIVE_PAYMENT_TYPE, await operatorB.getAddress());
    await mechB.waitForDeployment();
    const operatorAVerdictMech = await Mech.deploy(verdictRate, NATIVE_PAYMENT_TYPE, await operatorA.getAddress());
    await operatorAVerdictMech.waitForDeployment();
    const evaluatorMech = await Mech.deploy(verdictRate, NATIVE_PAYMENT_TYPE, await evaluator.getAddress());
    await evaluatorMech.waitForDeployment();

    return {
      coordinator,
      router,
      marketplace,
      activity,
      creator,
      operatorA,
      operatorB,
      evaluator,
      dao,
      mechA,
      mechB,
      operatorAVerdictMech,
      evaluatorMech,
      solutionRate,
      verdictRate,
    };
  }

  async function claimAndReadSolutionRequest(router: any, operator: any, taskId: number, mech: any) {
    const tx = await router.connect(operator).claimTask(taskId, await mech.getAddress());
    const receipt = await tx.wait();
    const event = receipt!.logs
      .map((log: unknown) => {
        try { return router.interface.parseLog(log); } catch { return null; }
      })
      .find((log: null | { name: string }) => log?.name === "TaskAttemptCreated")!;
    return {
      requestId: event.args.requestId as string,
      attemptIndex: Number(event.args.attemptIndex),
    };
  }

  async function claimAndReadVerdictRequest(router: any, evaluator: any, taskId: number, attemptIndex: number, mech: any) {
    const tx = await router.connect(evaluator).claimEvaluation(taskId, attemptIndex, await mech.getAddress(), EVAL_TASK_CID);
    const receipt = await tx.wait();
    const event = receipt!.logs
      .map((log: unknown) => {
        try { return router.interface.parseLog(log); } catch { return null; }
      })
      .find((log: null | { name: string }) => log?.name === "EvaluationAttemptCreated")!;
    return {
      requestId: event.args.requestId as string,
      verdictIndex: Number(event.args.verdictIndex),
    };
  }

  it("groups two solved attempts and one Verdict each under a single Task", async function () {
    const {
      coordinator,
      router,
      marketplace,
      activity,
      creator,
      operatorA,
      operatorB,
      evaluator,
      mechA,
      mechB,
      evaluatorMech,
      solutionRate,
      verdictRate,
    } = await deploy();

    const p = policy(2);
    await router.connect(creator).createTask(
      TASK_CID,
      SOLVER_TYPE,
      p,
      solutionRate,
      verdictRate,
      3600,
      { value: solutionRate * 2n + verdictRate * 2n },
    );

    const first = await claimAndReadSolutionRequest(router, operatorA, 1, mechA);
    const second = await claimAndReadSolutionRequest(router, operatorB, 1, mechB);

    // maxClaims is 2 and both slots consumed the full per-attempt solution rate, so the Solution
    // budget is exhausted. A third claim is rejected by the router's budget guard (which runs
    // before the coordinator's maxClaims gate).
    await expect(
      router.connect(operatorA).claimTask(1, await mechA.getAddress()),
    ).to.be.revertedWithCustomError(router, "RouterInsufficientTaskBudget");

    await marketplace.markDelivered(first.requestId, await mechA.getAddress());
    await marketplace.markDelivered(second.requestId, await mechB.getAddress());
    await router.connect(operatorA).claimSolutionDelivery(first.requestId, SOLUTION_A);
    await router.connect(operatorB).claimSolutionDelivery(second.requestId, SOLUTION_B);

    // Tokenless-OLAS loop-completion gate: the solver's activity is NOT credited at
    // solution-delivery time — it is credited on the first verdict (loop completion).
    // After delivery but before any verdict, solver activity weight must still be zero.
    expect(await activity.solutionDeliveryWeight(await operatorA.getAddress())).to.equal(0n);
    expect(await activity.solutionDeliveryWeight(await operatorB.getAddress())).to.equal(0n);

    const verdictA = await claimAndReadVerdictRequest(router, evaluator, 1, first.attemptIndex, evaluatorMech);
    const verdictB = await claimAndReadVerdictRequest(router, evaluator, 1, second.attemptIndex, evaluatorMech);

    await marketplace.markDelivered(verdictA.requestId, await evaluatorMech.getAddress());
    await marketplace.markDelivered(verdictB.requestId, await evaluatorMech.getAddress());
    await router.connect(evaluator).claimVerdictDelivery(verdictA.requestId, VERDICT_A, 1);
    await router.connect(evaluator).claimVerdictDelivery(verdictB.requestId, VERDICT_B, 1);

    const task = await coordinator.getTask(1);
    expect(task.claimCount).to.equal(2);
    expect(task.submittedCount).to.equal(2);
    expect(task.finalizedAttemptCount).to.equal(2);
    expect(task.creatorCredited).to.equal(true);

    const attemptA = await coordinator.getAttempt(1, 0);
    const attemptB = await coordinator.getAttempt(1, 1);
    expect(attemptA.solutionCidDigest).to.equal(SOLUTION_A);
    expect(attemptB.solutionCidDigest).to.equal(SOLUTION_B);
    expect(attemptA.status).to.equal(4); // Finalized
    expect(attemptB.status).to.equal(4); // Finalized

    expect(await activity.solutionDeliveryWeight(await operatorA.getAddress())).to.equal(ONE);
    expect(await activity.solutionDeliveryWeight(await operatorB.getAddress())).to.equal(ONE);
    expect(await activity.verdictDeliveryWeight(await evaluator.getAddress())).to.equal(ethers.parseEther("2"));
    // Creator is credited exactly once across both finalized attempts.
    expect(await activity.taskCreationWeight(await creator.getAddress())).to.equal(ONE);
    expect(await activity.taskCreationFinalized(1)).to.equal(true);
    expect((await router.taskPayments(1)).solutionBudgetRemaining).to.equal(0);
    expect((await router.taskPayments(1)).verdictBudgetRemaining).to.equal(0);
  });
});
