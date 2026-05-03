import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("JinnRouterV3", function () {
  const TASK_CID = ethers.keccak256(ethers.toUtf8Bytes("task-cid"));
  const EVAL_TASK_CID = ethers.keccak256(ethers.toUtf8Bytes("evaluation-task-cid"));
  const SOLVER_TYPE = ethers.keccak256(ethers.toUtf8Bytes("prediction.v1"));
  const SOLUTION_DIGEST = ethers.keccak256(ethers.toUtf8Bytes("solution-envelope"));
  const VERDICT_DIGEST = ethers.keccak256(ethers.toUtf8Bytes("verdict-envelope"));
  const NATIVE_PAYMENT_TYPE = "0xba699a34be8fe0e7725e93dcbce1701b0211a8ca61330aaeb8a05bf2ec7abed1";

  async function policy(maxClaims = 2, maxClaimsPerOperator = 1, ttl = 300, requiredVerdicts = 1) {
    const now = await time.latest();
    return {
      claimWindowStart: now,
      claimWindowEnd: now + 600,
      submissionDeadline: now + 1800,
      claimLeaseTtlSeconds: ttl,
      maxClaims,
      maxClaimsPerOperator,
      policyHook: ethers.ZeroAddress,
      evaluationPolicy: {
        requiredVerdicts,
        passThreshold: 1,
        evaluationDeadline: now + 2400,
        maxVerdictsPerEvaluator: 1,
        disallowSolverSelfEvaluation: true,
      },
    };
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
    const value = solutionRate * BigInt(p.maxClaims) + verdictRate * BigInt(p.maxClaims) * BigInt(p.evaluationPolicy.requiredVerdicts || 1);
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
    const p = await policy(2, 1);
    const value = solutionRate * 2n + verdictRate * 2n;

    await expect(
      router.connect(creator).createTask(TASK_CID, SOLVER_TYPE, p, solutionRate, verdictRate, 3600, { value })
    ).to.emit(router, "TaskCreated").withArgs(
      await creator.getAddress(),
      1,
      SOLVER_TYPE,
      TASK_CID,
      2,
      1,
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

  it("creates a lazy Solution request on claim and decrements only Solution budget", async function () {
    const { router, coordinator, marketplace, creator, solver, solverMech, solutionRate, verdictRate } = await deploy();
    await createTask(router, creator, await policy(2, 1), solutionRate, verdictRate);

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
    await createTask(router, creator, await policy(1, 1), solutionRate, verdictRate);

    const solution = await claimSolution(router, solver, 1, solverMech);
    await marketplace.markDelivered(solution.requestId, await solverMech.getAddress());

    await expect(router.connect(solver).claimSolutionDelivery(solution.requestId, SOLUTION_DIGEST))
      .to.emit(router, "SolutionDeliveryClaimed")
      .withArgs(await solver.getAddress(), solution.requestId, 1, 0);

    expect(await router.solutionDeliveryClaimed(solution.requestId)).to.equal(true);
    expect(await activity.solutionDeliveryWeight(await solver.getAddress())).to.equal(ethers.parseEther("1"));
    expect(await activity.lastSolutionDigest(await solver.getAddress())).to.equal(SOLUTION_DIGEST);

    const verdict = await claimVerdict(router, evaluator, 1, 0, evaluatorMech);
    await marketplace.markDelivered(verdict.requestId, await evaluatorMech.getAddress());

    await expect(router.connect(evaluator).claimVerdictDelivery(verdict.requestId, VERDICT_DIGEST, 1))
      .to.emit(router, "VerdictDeliveryClaimed")
      .withArgs(await evaluator.getAddress(), verdict.requestId, 1, 0, 0, 1);

    expect(await activity.verdictDeliveryWeight(await evaluator.getAddress())).to.equal(ethers.parseEther("1"));
    expect(await activity.taskCreationWeight(await creator.getAddress())).to.equal(ethers.parseEther("1"));
    expect(await activity.taskCreationFinalized(1)).to.equal(true);

    const attempt = await coordinator.getAttempt(1, 0);
    expect(attempt.status).to.equal(3);
    expect(attempt.finalization).to.equal(2);
    expect(attempt.solutionCidDigest).to.equal(SOLUTION_DIGEST);
  });

  it("rejects solver self-evaluation and duplicate over-quorum evaluator claims", async function () {
    const { router, marketplace, creator, solver, evaluator, solverMech, evaluatorMech, solutionRate, verdictRate } = await deploy();
    await createTask(router, creator, await policy(1, 1), solutionRate, verdictRate);
    const solution = await claimSolution(router, solver, 1, solverMech);
    await marketplace.markDelivered(solution.requestId, await solverMech.getAddress());
    await router.connect(solver).claimSolutionDelivery(solution.requestId, SOLUTION_DIGEST);

    await expect(
      router.connect(solver).claimEvaluation(1, 0, await solverMech.getAddress(), EVAL_TASK_CID)
    ).to.be.revertedWithCustomError(await ethers.getContractAt("TaskCoordinator", await router.taskCoordinator()), "TCSolverSelfEvaluation");

    await claimVerdict(router, evaluator, 1, 0, evaluatorMech);
    await expect(
      router.connect(evaluator).claimEvaluation(1, 0, await evaluatorMech.getAddress(), EVAL_TASK_CID)
    ).to.be.revertedWithCustomError(await ethers.getContractAt("TaskCoordinator", await router.taskCoordinator()), "TCMaxVerdictsReached");
  });

  it("refunds unused split budget when each refund path is eligible", async function () {
    const { router, creator, solver, solverMech, solutionRate, verdictRate } = await deploy();
    const p = await policy(2, 1);
    await createTask(router, creator, p, solutionRate, verdictRate);
    await claimSolution(router, solver, 1, solverMech);
    await time.increase(2401);

    await expect(router.connect(creator).refundUnusedTaskBudget(1))
      .to.changeEtherBalances([router, creator], [-(solutionRate + verdictRate * 2n), solutionRate + verdictRate * 2n]);

    const payment = await router.taskPayments(1);
    expect(payment.solutionBudgetRemaining).to.equal(0);
    expect(payment.verdictBudgetRemaining).to.equal(0);
    expect(payment.solutionBudgetRefunded).to.equal(true);
    expect(payment.verdictBudgetRefunded).to.equal(true);
  });
});
