import { expect } from "chai";
import { network } from "hardhat";

describe("TaskCoordinator", function () {
  let ethers: Awaited<ReturnType<typeof network.connect>>["ethers"];

  let TASK_CID: string;
  let SOLVER_TYPE: string;
  let REQUEST_ID: string;
  let VERDICT_REQUEST_ID: string;
  let SOLUTION_CID: string;
  let VERDICT_CID: string;

  before(async () => {
    ({ ethers } = await network.connect());
    TASK_CID = ethers.keccak256(ethers.toUtf8Bytes("task-cid"));
    SOLVER_TYPE = ethers.keccak256(ethers.toUtf8Bytes("prediction.v1"));
    REQUEST_ID = ethers.keccak256(ethers.toUtf8Bytes("solution-request-1"));
    VERDICT_REQUEST_ID = ethers.keccak256(ethers.toUtf8Bytes("verdict-request-1"));
    SOLUTION_CID = ethers.keccak256(ethers.toUtf8Bytes("solution-1"));
    VERDICT_CID = ethers.keccak256(ethers.toUtf8Bytes("verdict-1"));
  });

  async function deploy() {
    const [owner, router, creator, operator, evaluator, other] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("TaskCoordinator");
    const coordinator = await Factory.deploy();
    await coordinator.waitForDeployment();
    await (await coordinator.initialize(await owner.getAddress(), await router.getAddress())).wait();
    return { coordinator, owner, router, creator, operator, evaluator, other };
  }

  function makePolicy(maxClaims = 1, allowSolverSelfEvaluation = false) {
    return { maxClaims, allowSolverSelfEvaluation };
  }

  async function createSubmittedAttempt(coordinator: any, router: any, creator: string, operator: string) {
    await coordinator.connect(router).createTask(creator, TASK_CID, SOLVER_TYPE, makePolicy());
    await coordinator.connect(router).claimTask(1, operator);
    await coordinator.connect(router).registerAttemptRequest(1, 0, REQUEST_ID);
    await coordinator.connect(router).recordSubmission(REQUEST_ID, operator, SOLUTION_CID, ethers.parseEther("1"));
  }

  it("creates a Task with a launcher-funded attempt count", async function () {
    const { coordinator, router, creator } = await deploy();

    await expect(
      coordinator.connect(router).createTask(await creator.getAddress(), TASK_CID, SOLVER_TYPE, makePolicy(25))
    ).to.emit(coordinator, "TaskCreated").withArgs(
      1,
      await creator.getAddress(),
      SOLVER_TYPE,
      TASK_CID,
      25
    );

    const record = await coordinator.getTask(1);
    expect(record.creator).to.equal(await creator.getAddress());
    expect(record.taskCidDigest).to.equal(TASK_CID);
    expect(record.policy.maxClaims).to.equal(25);
    expect(record.creatorCredited).to.equal(false);
  });

  it("rejects a Task with zero maxClaims", async function () {
    const { coordinator, router, creator } = await deploy();
    await expect(
      coordinator.connect(router).createTask(await creator.getAddress(), TASK_CID, SOLVER_TYPE, makePolicy(0))
    ).to.be.revertedWithCustomError(coordinator, "TCInvalidPolicy");
  });

  it("claims an exclusive Task once and rejects claims past maxClaims", async function () {
    const { coordinator, router, creator, operator, other } = await deploy();
    await coordinator.connect(router).createTask(await creator.getAddress(), TASK_CID, SOLVER_TYPE, makePolicy(1));

    await expect(coordinator.connect(router).claimTask(1, await operator.getAddress()))
      .to.emit(coordinator, "TaskClaimed")
      .withArgs(1, 0, await operator.getAddress());

    const attempt = await coordinator.getAttempt(1, 0);
    expect(attempt.operator).to.equal(await operator.getAddress());

    await expect(
      coordinator.connect(router).claimTask(1, await other.getAddress())
    ).to.be.revertedWithCustomError(coordinator, "TCMaxClaimsReached");
  });

  it("claims a parallel Task up to maxClaims, including repeat operators", async function () {
    const { coordinator, router, creator, operator, other } = await deploy();
    await coordinator.connect(router).createTask(await creator.getAddress(), TASK_CID, SOLVER_TYPE, makePolicy(2));

    await coordinator.connect(router).claimTask(1, await operator.getAddress());
    await coordinator.connect(router).claimTask(1, await other.getAddress());
    const record = await coordinator.getTask(1);
    expect(record.claimCount).to.equal(2);

    await expect(
      coordinator.connect(router).claimTask(1, await operator.getAddress())
    ).to.be.revertedWithCustomError(coordinator, "TCMaxClaimsReached");
  });

  it("registers a Solution request and records a submitted attempt", async function () {
    const { coordinator, router, creator, operator } = await deploy();
    await coordinator.connect(router).createTask(await creator.getAddress(), TASK_CID, SOLVER_TYPE, makePolicy());
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
    expect(attempt.status).to.equal(3); // Submitted
  });

  it("claims and records a Verdict, finalizing the attempt and crediting the creator once", async function () {
    const { coordinator, router, creator, operator, evaluator, other } = await deploy();
    await createSubmittedAttempt(coordinator, router, await creator.getAddress(), await operator.getAddress());

    await expect(coordinator.connect(router).claimEvaluation(1, 0, await evaluator.getAddress()))
      .to.emit(coordinator, "EvaluationClaimed")
      .withArgs(1, 0, 0, await evaluator.getAddress());

    await coordinator.connect(router).registerVerdictRequest(1, 0, 0, VERDICT_REQUEST_ID);

    await expect(
      coordinator.connect(router).recordVerdict(VERDICT_REQUEST_ID, await evaluator.getAddress(), VERDICT_CID, 1)
    )
      .to.emit(coordinator, "VerdictDelivered")
      .withArgs(1, 0, 0, await evaluator.getAddress(), VERDICT_CID, 1);

    const task = await coordinator.getTask(1);
    const attempt = await coordinator.getAttempt(1, 0);
    expect(task.creatorCredited).to.equal(true);
    expect(task.finalizedAttemptCount).to.equal(1);
    expect(attempt.status).to.equal(4); // Finalized

    // A second evaluation claim on the finalized attempt is rejected: it is no longer Submitted.
    await expect(
      coordinator.connect(router).claimEvaluation(1, 0, await other.getAddress())
    ).to.be.revertedWithCustomError(coordinator, "TCAttemptNotSubmitted");
  });

  it("rejects solver self-evaluation when the policy disallows it (default)", async function () {
    const { coordinator, router, creator, operator } = await deploy();
    await createSubmittedAttempt(coordinator, router, await creator.getAddress(), await operator.getAddress());

    await expect(
      coordinator.connect(router).claimEvaluation(1, 0, await operator.getAddress())
    ).to.be.revertedWithCustomError(coordinator, "TCSolverSelfEvaluation");
  });

  it("allows solver self-evaluation when policy.allowSolverSelfEvaluation is true", async function () {
    const { coordinator, router, creator, operator } = await deploy();
    // allowSolverSelfEvaluation: true → the solver may evaluate their own attempt.
    await coordinator.connect(router).createTask(await creator.getAddress(), TASK_CID, SOLVER_TYPE, makePolicy(1, true));
    await coordinator.connect(router).claimTask(1, await operator.getAddress());
    await coordinator.connect(router).registerAttemptRequest(1, 0, REQUEST_ID);
    await coordinator.connect(router).recordSubmission(REQUEST_ID, await operator.getAddress(), SOLUTION_CID, ethers.parseEther("1"));

    // The solver (operator) evaluating their OWN attempt does NOT revert.
    await expect(coordinator.connect(router).claimEvaluation(1, 0, await operator.getAddress()))
      .to.emit(coordinator, "EvaluationClaimed")
      .withArgs(1, 0, 0, await operator.getAddress());

    // …and the verdict records and finalizes the attempt, crediting the creator.
    await coordinator.connect(router).registerVerdictRequest(1, 0, 0, VERDICT_REQUEST_ID);
    await expect(
      coordinator.connect(router).recordVerdict(VERDICT_REQUEST_ID, await operator.getAddress(), VERDICT_CID, 1)
    )
      .to.emit(coordinator, "VerdictDelivered")
      .withArgs(1, 0, 0, await operator.getAddress(), VERDICT_CID, 1);

    const task = await coordinator.getTask(1);
    const attempt = await coordinator.getAttempt(1, 0);
    const verdict = await coordinator.getVerdict(1, 0, 0);
    expect(task.creatorCredited).to.equal(true);
    expect(task.finalizedAttemptCount).to.equal(1);
    expect(attempt.status).to.equal(4); // Finalized
    expect(verdict.evaluator).to.equal(await operator.getAddress());
    expect(verdict.verdictCode).to.equal(1); // Pass
  });

  it("rejects evaluation before the attempt is submitted", async function () {
    const { coordinator, router, creator, operator, evaluator } = await deploy();
    await coordinator.connect(router).createTask(await creator.getAddress(), TASK_CID, SOLVER_TYPE, makePolicy());
    await coordinator.connect(router).claimTask(1, await operator.getAddress());

    await expect(
      coordinator.connect(router).claimEvaluation(1, 0, await evaluator.getAddress())
    ).to.be.revertedWithCustomError(coordinator, "TCAttemptNotSubmitted");
  });

  it("getTask returns creator then taskCidDigest as the first two fields", async function () {
    const { coordinator, router, creator } = await deploy();
    await coordinator.connect(router).createTask(await creator.getAddress(), TASK_CID, SOLVER_TYPE, makePolicy());
    const record = await coordinator.getTask(1);
    // Positional decode contract for the client ABI.
    expect(record[0]).to.equal(await creator.getAddress());
    expect(record[1]).to.equal(TASK_CID);
  });
});
