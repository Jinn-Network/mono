import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

describe("TaskCoordinator", function () {
  const TASK_CID = ethers.keccak256(ethers.toUtf8Bytes("task-cid"));
  const SOLVER_TYPE = ethers.keccak256(ethers.toUtf8Bytes("prediction.v1"));
  const REQUEST_ID = ethers.keccak256(ethers.toUtf8Bytes("solution-request-1"));
  const VERDICT_REQUEST_ID = ethers.keccak256(ethers.toUtf8Bytes("verdict-request-1"));
  const SOLUTION_CID = ethers.keccak256(ethers.toUtf8Bytes("solution-1"));
  const VERDICT_CID = ethers.keccak256(ethers.toUtf8Bytes("verdict-1"));

  async function deploy() {
    const [owner, router, creator, operator, evaluator, other] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("TaskCoordinator");
    const coordinator = await Factory.deploy();
    await coordinator.waitForDeployment();
    await (await coordinator.initialize(await owner.getAddress(), await router.getAddress())).wait();
    return { coordinator, owner, router, creator, operator, evaluator, other };
  }

  async function makePolicy(maxClaims = 1, maxClaimsPerOperator = 1, requiredVerdicts = 1) {
    const now = await time.latest();
    return {
      claimWindowStart: now,
      claimWindowEnd: now + 600,
      submissionDeadline: now + 1800,
      claimLeaseTtlSeconds: 300,
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

  async function createSubmittedAttempt(coordinator: any, router: any, creator: string, operator: string) {
    await coordinator.connect(router).createTask(creator, TASK_CID, SOLVER_TYPE, await makePolicy());
    await coordinator.connect(router).claimTask(1, operator);
    await coordinator.connect(router).registerAttemptRequest(1, 0, REQUEST_ID);
    await coordinator.connect(router).recordSubmission(REQUEST_ID, operator, SOLUTION_CID, ethers.parseEther("1"));
  }

  it("creates a Task and defaults zero evaluation policy values", async function () {
    const { coordinator, router, creator } = await deploy();
    const now = await time.latest();
    const policy = {
      claimWindowStart: now,
      claimWindowEnd: now + 600,
      submissionDeadline: now + 1800,
      claimLeaseTtlSeconds: 300,
      maxClaims: 25,
      maxClaimsPerOperator: 1,
      policyHook: ethers.ZeroAddress,
      evaluationPolicy: {
        requiredVerdicts: 0,
        passThreshold: 0,
        evaluationDeadline: 0,
        maxVerdictsPerEvaluator: 0,
        disallowSolverSelfEvaluation: false,
      },
    };

    await expect(
      coordinator.connect(router).createTask(await creator.getAddress(), TASK_CID, SOLVER_TYPE, policy)
    ).to.emit(coordinator, "TaskCreated").withArgs(
      1,
      await creator.getAddress(),
      SOLVER_TYPE,
      TASK_CID,
      25,
      1,
      policy.claimWindowStart,
      policy.claimWindowEnd,
      policy.submissionDeadline,
      policy.submissionDeadline
    );

    const record = await coordinator.getTask(1);
    expect(record.creator).to.equal(await creator.getAddress());
    expect(record.policy.evaluationPolicy.requiredVerdicts).to.equal(1);
    expect(record.policy.evaluationPolicy.passThreshold).to.equal(1);
    expect(record.policy.evaluationPolicy.maxVerdictsPerEvaluator).to.equal(1);
    expect(record.policy.evaluationPolicy.disallowSolverSelfEvaluation).to.equal(true);
  });

  it("claims an exclusive Task once", async function () {
    const { coordinator, router, creator, operator, other } = await deploy();
    await coordinator.connect(router).createTask(await creator.getAddress(), TASK_CID, SOLVER_TYPE, await makePolicy(1, 1));

    await expect(coordinator.connect(router).claimTask(1, await operator.getAddress()))
      .to.emit(coordinator, "TaskClaimed")
      .withArgs(1, 0, await operator.getAddress(), anyValue);

    const attempt = await coordinator.getAttempt(1, 0);
    expect(attempt.operator).to.equal(await operator.getAddress());

    await expect(
      coordinator.connect(router).claimTask(1, await other.getAddress())
    ).to.be.revertedWithCustomError(coordinator, "TCMaxClaimsReached");
  });

  it("claims a parallel Task up to maxClaims and rejects duplicate operator claims", async function () {
    const { coordinator, router, creator, operator, other } = await deploy();
    await coordinator.connect(router).createTask(await creator.getAddress(), TASK_CID, SOLVER_TYPE, await makePolicy(2, 1));

    await coordinator.connect(router).claimTask(1, await operator.getAddress());
    await expect(
      coordinator.connect(router).claimTask(1, await operator.getAddress())
    ).to.be.revertedWithCustomError(coordinator, "TCOperatorClaimLimitReached");

    await coordinator.connect(router).claimTask(1, await other.getAddress());
    const record = await coordinator.getTask(1);
    expect(record.claimCount).to.equal(2);
  });

  it("registers a Solution request and records a submitted attempt", async function () {
    const { coordinator, router, creator, operator } = await deploy();
    await coordinator.connect(router).createTask(await creator.getAddress(), TASK_CID, SOLVER_TYPE, await makePolicy());
    await coordinator.connect(router).claimTask(1, await operator.getAddress());

    await expect(coordinator.connect(router).registerAttemptRequest(1, 0, REQUEST_ID))
      .to.emit(coordinator, "TaskAttemptRequestRegistered")
      .withArgs(1, 0, REQUEST_ID);

    await expect(coordinator.connect(router).recordSubmission(REQUEST_ID, await operator.getAddress(), SOLUTION_CID, 7))
      .to.emit(coordinator, "TaskSubmitted")
      .withArgs(1, 0, await operator.getAddress(), REQUEST_ID, SOLUTION_CID, 7);

    const attempt = await coordinator.getAttempt(1, 0);
    expect(attempt.solutionCidDigest).to.equal(SOLUTION_CID);
    expect(attempt.solutionWeight).to.equal(7);
    expect(attempt.status).to.equal(3);
    expect(attempt.finalization).to.equal(1);
  });

  it("rejects solution submissions after the claim lease expires", async function () {
    const { coordinator, router, creator, operator } = await deploy();
    const policy = await makePolicy();
    policy.claimLeaseTtlSeconds = 30;
    await coordinator.connect(router).createTask(await creator.getAddress(), TASK_CID, SOLVER_TYPE, policy);
    await coordinator.connect(router).claimTask(1, await operator.getAddress());
    await coordinator.connect(router).registerAttemptRequest(1, 0, REQUEST_ID);
    await time.increase(31);

    await expect(
      coordinator.connect(router).recordSubmission(REQUEST_ID, await operator.getAddress(), SOLUTION_CID, 7)
    ).to.be.revertedWithCustomError(coordinator, "TCAttemptClaimExpired");
  });

  it("claims and records a Verdict, finalizing the attempt and locking creator credit once", async function () {
    const { coordinator, router, creator, operator, evaluator, other } = await deploy();
    await createSubmittedAttempt(coordinator, router, await creator.getAddress(), await operator.getAddress());

    await expect(coordinator.connect(router).claimEvaluation(1, 0, await evaluator.getAddress()))
      .to.emit(coordinator, "EvaluationClaimed")
      .withArgs(1, 0, 0, await evaluator.getAddress(), anyValue);

    await coordinator.connect(router).registerVerdictRequest(1, 0, 0, VERDICT_REQUEST_ID);

    const tx = await coordinator.connect(router).recordVerdict(
      VERDICT_REQUEST_ID,
      await evaluator.getAddress(),
      VERDICT_CID,
      1
    );
    await expect(tx).to.emit(coordinator, "AttemptFinalized").withArgs(1, 0, true, 1, 1);
    await expect(tx).to.emit(coordinator, "TaskCreationCreditLocked").withArgs(
      1,
      await creator.getAddress(),
      ethers.parseEther("1")
    );

    const task = await coordinator.getTask(1);
    const attempt = await coordinator.getAttempt(1, 0);
    expect(task.taskCreationCredited).to.equal(true);
    expect(task.finalizedAttemptCount).to.equal(1);
    expect(attempt.finalization).to.equal(2);

    await expect(
      coordinator.connect(router).claimEvaluation(1, 0, await other.getAddress())
    ).to.be.revertedWithCustomError(coordinator, "TCAttemptAlreadyFinalized");
  });

  it("rejects solver self-evaluation and duplicate evaluator claims", async function () {
    const { coordinator, router, creator, operator, evaluator } = await deploy();
    await createSubmittedAttempt(coordinator, router, await creator.getAddress(), await operator.getAddress());

    await expect(
      coordinator.connect(router).claimEvaluation(1, 0, await operator.getAddress())
    ).to.be.revertedWithCustomError(coordinator, "TCSolverSelfEvaluation");

    await coordinator.connect(router).claimEvaluation(1, 0, await evaluator.getAddress());
    await expect(
      coordinator.connect(router).claimEvaluation(1, 0, await evaluator.getAddress())
    ).to.be.revertedWithCustomError(coordinator, "TCMaxVerdictsReached");
  });

  it("rejects verdict submissions after the evaluator claim lease expires", async function () {
    const { coordinator, router, creator, operator, evaluator } = await deploy();
    const policy = await makePolicy();
    policy.claimLeaseTtlSeconds = 30;
    await coordinator.connect(router).createTask(await creator.getAddress(), TASK_CID, SOLVER_TYPE, policy);
    await coordinator.connect(router).claimTask(1, await operator.getAddress());
    await coordinator.connect(router).registerAttemptRequest(1, 0, REQUEST_ID);
    await coordinator.connect(router).recordSubmission(REQUEST_ID, await operator.getAddress(), SOLUTION_CID, 7);
    await coordinator.connect(router).claimEvaluation(1, 0, await evaluator.getAddress());
    await coordinator.connect(router).registerVerdictRequest(1, 0, 0, VERDICT_REQUEST_ID);
    await time.increase(31);

    await expect(
      coordinator.connect(router).recordVerdict(
        VERDICT_REQUEST_ID,
        await evaluator.getAddress(),
        VERDICT_CID,
        1
      )
    ).to.be.revertedWithCustomError(coordinator, "TCVerdictClaimExpired");
  });

  it("rejects claims outside the claim window", async function () {
    const { coordinator, router, creator, operator } = await deploy();
    const now = await time.latest();
    const policy = await makePolicy();
    policy.claimWindowStart = now + 100;
    policy.claimWindowEnd = now + 200;
    policy.submissionDeadline = now + 300;
    policy.evaluationPolicy.evaluationDeadline = now + 400;

    await coordinator.connect(router).createTask(await creator.getAddress(), TASK_CID, SOLVER_TYPE, policy);

    await expect(
      coordinator.connect(router).claimTask(1, await operator.getAddress())
    ).to.be.revertedWithCustomError(coordinator, "TCClaimWindowClosed");
  });

  it("expires no-show attempts without reopening the cap", async function () {
    const { coordinator, router, creator, operator, other } = await deploy();
    const policy = await makePolicy(1, 1);
    policy.claimLeaseTtlSeconds = 30;
    await coordinator.connect(router).createTask(await creator.getAddress(), TASK_CID, SOLVER_TYPE, policy);
    await coordinator.connect(router).claimTask(1, await operator.getAddress());
    await time.increase(31);

    await expect(coordinator.expireAttempt(1, 0))
      .to.emit(coordinator, "TaskAttemptExpired")
      .withArgs(1, 0, await operator.getAddress());

    await expect(
      coordinator.connect(router).claimTask(1, await other.getAddress())
    ).to.be.revertedWithCustomError(coordinator, "TCMaxClaimsReached");
  });
});
