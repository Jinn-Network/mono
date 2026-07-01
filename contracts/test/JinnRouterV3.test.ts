import { expect } from "chai";
import { network } from "hardhat";

describe("JinnRouterV3", function () {
  let ethers: Awaited<ReturnType<typeof network.connect>>["ethers"];

  let TASK_CID: string;
  let EVAL_TASK_CID: string;
  let SOLVER_TYPE: string;
  let SOLUTION_DIGEST: string;
  let VERDICT_DIGEST: string;
  const NATIVE_PAYMENT_TYPE = "0xba699a34be8fe0e7725e93dcbce1701b0211a8ca61330aaeb8a05bf2ec7abed1";

  before(async () => {
    ({ ethers } = await network.connect());
    TASK_CID = ethers.keccak256(ethers.toUtf8Bytes("task-cid"));
    EVAL_TASK_CID = ethers.keccak256(ethers.toUtf8Bytes("evaluation-task-cid"));
    SOLVER_TYPE = ethers.keccak256(ethers.toUtf8Bytes("prediction.v1"));
    SOLUTION_DIGEST = ethers.keccak256(ethers.toUtf8Bytes("solution-envelope"));
    VERDICT_DIGEST = ethers.keccak256(ethers.toUtf8Bytes("verdict-envelope"));
  });

  function policy(maxClaims = 2, allowSolverSelfEvaluation = false) {
    return { maxClaims, allowSolverSelfEvaluation };
  }

  async function deploy(solutionRate = ethers.parseEther("0.01"), verdictRate = ethers.parseEther("0.005")) {
    const [owner, creator, solver, evaluator, otherEvaluator] = await ethers.getSigners();

    const Coordinator = await ethers.getContractFactory("TaskCoordinator");
    const coordinator = await Coordinator.deploy();
    await coordinator.waitForDeployment();

    const Marketplace = await ethers.getContractFactory("MockTaskMarketplace");
    const marketplace = await Marketplace.deploy();
    await marketplace.waitForDeployment();

    const Activity = await ethers.getContractFactory("MockTaskActivityChecker");
    const activity = await Activity.deploy();
    await activity.waitForDeployment();

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

    const Mech = await ethers.getContractFactory("MockTaskMech");
    const solverMech = await Mech.deploy(solutionRate, NATIVE_PAYMENT_TYPE, await solver.getAddress());
    await solverMech.waitForDeployment();
    const evaluatorMech = await Mech.deploy(verdictRate, NATIVE_PAYMENT_TYPE, await evaluator.getAddress());
    await evaluatorMech.waitForDeployment();
    const otherEvaluatorMech = await Mech.deploy(verdictRate, NATIVE_PAYMENT_TYPE, await otherEvaluator.getAddress());
    await otherEvaluatorMech.waitForDeployment();

    return {
      coordinator,
      router,
      marketplace,
      activity,
      owner,
      creator,
      solver,
      evaluator,
      otherEvaluator,
      solverMech,
      evaluatorMech,
      otherEvaluatorMech,
      solutionRate,
      verdictRate,
    };
  }

  async function createTask(router: any, creator: any, p: any, solutionRate: bigint, verdictRate: bigint) {
    const value = solutionRate * BigInt(p.maxClaims) + verdictRate * BigInt(p.maxClaims);
    await router.connect(creator).createTask(TASK_CID, SOLVER_TYPE, p, solutionRate, verdictRate, 3600, { value });
    return value;
  }

  async function claimSolution(router: any, solver: any, taskId: number, solverMech: any) {
    const tx = await router.connect(solver).claimTask(taskId, await solverMech.getAddress());
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

  async function claimVerdict(router: any, evaluator: any, taskId: number, attemptIndex: number, evaluatorMech: any) {
    const tx = await router.connect(evaluator).claimEvaluation(taskId, attemptIndex, await evaluatorMech.getAddress(), EVAL_TASK_CID);
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

  it("creates a Task with split Solution and Verdict budgets", async function () {
    const { router, coordinator, creator, solutionRate, verdictRate } = await deploy();
    const p = policy(2);
    const value = solutionRate * 2n + verdictRate * 2n;

    await expect(
      router.connect(creator).createTask(TASK_CID, SOLVER_TYPE, p, solutionRate, verdictRate, 3600, { value })
    ).to.emit(router, "TaskCreated").withArgs(
      await creator.getAddress(),
      1,
      SOLVER_TYPE,
      TASK_CID,
      2,
      solutionRate * 2n,
      verdictRate * 2n
    );

    const payment = await router.taskPayments(1);
    expect(payment.solutionBudgetRemaining).to.equal(solutionRate * 2n);
    expect(payment.verdictBudgetRemaining).to.equal(verdictRate * 2n);

    const task = await coordinator.getTask(1);
    expect(task.creator).to.equal(await creator.getAddress());
    expect(task.claimCount).to.equal(0);
  });

  it("rejects a Task whose msg.value does not match the split budget", async function () {
    const { router, creator, solutionRate, verdictRate } = await deploy();
    const p = policy(2);
    const wrong = solutionRate * 2n; // missing the verdict budget

    await expect(
      router.connect(creator).createTask(TASK_CID, SOLVER_TYPE, p, solutionRate, verdictRate, 3600, { value: wrong })
    ).to.be.revertedWithCustomError(router, "RouterInsufficientTaskBudget");
  });

  it("creates a lazy Solution request on claim and decrements only Solution budget", async function () {
    const { router, coordinator, marketplace, creator, solver, solverMech, solutionRate, verdictRate } = await deploy();
    await createTask(router, creator, policy(2), solutionRate, verdictRate);

    const claim = await claimSolution(router, solver, 1, solverMech);
    const payment = await router.taskPayments(1);
    expect(payment.solutionBudgetRemaining).to.equal(solutionRate);
    expect(payment.verdictBudgetRemaining).to.equal(verdictRate * 2n);

    const attempt = await coordinator.getAttempt(1, 0);
    expect(attempt.requestId).to.equal(claim.requestId);

    const info = await marketplace.mapRequestIdInfos(claim.requestId);
    expect(info.requester).to.equal(await router.getAddress());
    expect(info.priorityMech).to.equal(await solverMech.getAddress());
  });

  it("records Solution delivery, evaluator request, Verdict delivery, finalization, and creator credit", async function () {
    const {
      router,
      coordinator,
      marketplace,
      activity,
      creator,
      solver,
      evaluator,
      solverMech,
      evaluatorMech,
      solutionRate,
      verdictRate,
    } = await deploy();
    await createTask(router, creator, policy(1), solutionRate, verdictRate);

    const solution = await claimSolution(router, solver, 1, solverMech);
    await marketplace.markDelivered(solution.requestId, await solverMech.getAddress());

    await expect(router.connect(solver).claimSolutionDelivery(solution.requestId, SOLUTION_DIGEST))
      .to.emit(router, "SolutionDeliveryClaimed")
      .withArgs(await solver.getAddress(), solution.requestId, 1, 0);

    expect(await router.solutionDeliveryClaimed(solution.requestId)).to.equal(true);
    // Tokenless-OLAS loop-completion gate: solver activity is credited on the first
    // verdict (loop completion), NOT at solution-delivery — so it is still zero here.
    expect(await activity.solutionDeliveryWeight(await solver.getAddress())).to.equal(0n);

    const verdict = await claimVerdict(router, evaluator, 1, 0, evaluatorMech);
    await marketplace.markDelivered(verdict.requestId, await evaluatorMech.getAddress());

    await expect(router.connect(evaluator).claimVerdictDelivery(verdict.requestId, VERDICT_DIGEST, 1))
      .to.emit(router, "VerdictDeliveryClaimed")
      .withArgs(await evaluator.getAddress(), verdict.requestId, 1, 0, 0, 1);

    // The solver's activity is credited now (on the verdict), with the stored solution digest.
    expect(await activity.solutionDeliveryWeight(await solver.getAddress())).to.equal(ethers.parseEther("1"));
    expect(await activity.lastSolutionDigest(await solver.getAddress())).to.equal(SOLUTION_DIGEST);
    expect(await activity.verdictDeliveryWeight(await evaluator.getAddress())).to.equal(ethers.parseEther("1"));
    expect(await activity.taskCreationWeight(await creator.getAddress())).to.equal(ethers.parseEther("1"));
    expect(await activity.taskCreationFinalized(1)).to.equal(true);

    const attempt = await coordinator.getAttempt(1, 0);
    expect(attempt.status).to.equal(4); // Finalized
    expect(attempt.solutionCidDigest).to.equal(SOLUTION_DIGEST);
  });

  it("rejects solver self-evaluation when the policy disallows it (default)", async function () {
    const { router, marketplace, creator, solver, solverMech, solutionRate, verdictRate } = await deploy();
    await createTask(router, creator, policy(1), solutionRate, verdictRate);
    const solution = await claimSolution(router, solver, 1, solverMech);
    await marketplace.markDelivered(solution.requestId, await solverMech.getAddress());
    await router.connect(solver).claimSolutionDelivery(solution.requestId, SOLUTION_DIGEST);

    await expect(
      router.connect(solver).claimEvaluation(1, 0, await solverMech.getAddress(), EVAL_TASK_CID)
    ).to.be.revertedWithCustomError(await ethers.getContractAt("TaskCoordinator", await router.taskCoordinator()), "TCSolverSelfEvaluation");
  });

  it("refunds the unused split budget at the creator's discretion", async function () {
    const { router, creator, solver, solverMech, solutionRate, verdictRate } = await deploy();
    const p = policy(2);
    await createTask(router, creator, p, solutionRate, verdictRate);
    // Claim one of two solution slots, leaving one unclaimed solution slot and all verdict budget.
    await claimSolution(router, solver, 1, solverMech);

    await expect(router.connect(creator).refundUnusedTaskBudget(1))
      .to.changeEtherBalances(ethers, [router, creator], [-(solutionRate + verdictRate * 2n), solutionRate + verdictRate * 2n]);

    const payment = await router.taskPayments(1);
    expect(payment.solutionBudgetRemaining).to.equal(0);
    expect(payment.verdictBudgetRemaining).to.equal(0);
    expect(payment.solutionBudgetRefunded).to.equal(true);
    expect(payment.verdictBudgetRefunded).to.equal(true);

    // A second refund is a no-op and reverts (nothing left to refund).
    await expect(
      router.connect(creator).refundUnusedTaskBudget(1)
    ).to.be.revertedWithCustomError(router, "RouterTaskNotRefundable");
  });
});
