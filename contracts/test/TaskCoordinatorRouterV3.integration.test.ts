import { expect } from "chai";
import { network } from "hardhat";

describe("TaskCoordinator + JinnRouterV3 integration", function () {
  let ethers: Awaited<ReturnType<typeof network.connect>>["ethers"];
  let networkHelpers: Awaited<ReturnType<typeof network.connect>>["networkHelpers"];

  let TASK_CID: string;
  let EVAL_TASK_CID: string;
  let SOLVER_TYPE: string;
  let SOLUTION_A: string;
  let SOLUTION_B: string;
  let VERDICT_A: string;
  let VERDICT_B: string;
  const NATIVE_PAYMENT_TYPE = "0xba699a34be8fe0e7725e93dcbce1701b0211a8ca61330aaeb8a05bf2ec7abed1";
  let ONE: bigint;
  const SERVICE_ID = 48n;
  let OPERATOR_RATIO: bigint;
  let DAO_RATIO: bigint;
  const JINN_FQN = "src/jinn/token/JINN.sol:JINN";
  const DISTRIBUTOR_FQN = "src/jinn/distribution/JinnDistributor.sol:JinnDistributor";
  const MOCK_MESSENGER_FQN = "src/jinn/cross-chain/MockMessenger.sol:MockMessenger";

  before(async () => {
    ({ ethers, networkHelpers } = await network.connect());
    TASK_CID = ethers.keccak256(ethers.toUtf8Bytes("prediction-v1-task"));
    EVAL_TASK_CID = ethers.keccak256(ethers.toUtf8Bytes("prediction-v1-evaluation-task"));
    SOLVER_TYPE = ethers.keccak256(ethers.toUtf8Bytes("prediction.v1"));
    SOLUTION_A = ethers.keccak256(ethers.toUtf8Bytes("solution-a"));
    SOLUTION_B = ethers.keccak256(ethers.toUtf8Bytes("solution-b"));
    VERDICT_A = ethers.keccak256(ethers.toUtf8Bytes("verdict-a"));
    VERDICT_B = ethers.keccak256(ethers.toUtf8Bytes("verdict-b"));
    ONE = ethers.parseEther("1");
    OPERATOR_RATIO = (ONE * 75n) / 100n;
    DAO_RATIO = (ONE * 25n) / 100n;
  });

  async function policy(maxClaims = 2, maxClaimsPerOperator = 1, ttl = 300) {
    const now = await networkHelpers.time.latest();
    return {
      claimWindowStart: now,
      claimWindowEnd: now + 600,
      submissionDeadline: now + 1800,
      claimLeaseTtlSeconds: ttl,
      maxClaims,
      maxClaimsPerOperator,
      policyHook: ethers.ZeroAddress,
      evaluationPolicy: {
        requiredVerdicts: 1,
        passThreshold: 1,
        evaluationDeadline: now + 2400,
        maxVerdictsPerEvaluator: 2,
        disallowSolverSelfEvaluation: true,
      },
    };
  }

  function expectedSnapshotHash(args: {
    claimId: bigint;
    serviceId: bigint;
    taskCreationWeight: bigint;
    solutionDeliveryWeight: bigint;
    verdictDeliveryWeight: bigint;
    multisig: string;
  }): string {
    return ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint256", "uint256", "uint256", "uint256", "address"],
        [
          args.claimId,
          args.serviceId,
          args.taskCreationWeight,
          args.solutionDeliveryWeight,
          args.verdictDeliveryWeight,
          args.multisig,
        ],
      ),
    );
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

    const p = await policy(2, 1);
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
    await expect(
      router.connect(operatorA).claimTask(1, await mechA.getAddress()),
    ).to.be.revertedWithCustomError(coordinator, "TCOperatorClaimLimitReached");
    const second = await claimAndReadSolutionRequest(router, operatorB, 1, mechB);

    await marketplace.markDelivered(first.requestId, await mechA.getAddress());
    await marketplace.markDelivered(second.requestId, await mechB.getAddress());
    await router.connect(operatorA).claimSolutionDelivery(first.requestId, SOLUTION_A);
    await router.connect(operatorB).claimSolutionDelivery(second.requestId, SOLUTION_B);

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
    expect(task.taskCreationCredited).to.equal(true);

    const attemptA = await coordinator.getAttempt(1, 0);
    const attemptB = await coordinator.getAttempt(1, 1);
    expect(attemptA.solutionCidDigest).to.equal(SOLUTION_A);
    expect(attemptB.solutionCidDigest).to.equal(SOLUTION_B);
    expect(attemptA.finalization).to.equal(2);
    expect(attemptB.finalization).to.equal(2);

    expect(await activity.solutionDeliveryWeight(await operatorA.getAddress())).to.equal(ethers.parseEther("1"));
    expect(await activity.solutionDeliveryWeight(await operatorB.getAddress())).to.equal(ethers.parseEther("1"));
    expect(await activity.verdictDeliveryWeight(await evaluator.getAddress())).to.equal(ethers.parseEther("2"));
    expect(await activity.taskCreationWeight(await creator.getAddress())).to.equal(ethers.parseEther("1"));
    expect(await activity.taskCreationFinalized(1)).to.equal(true);
    expect((await router.taskPayments(1)).solutionBudgetRemaining).to.equal(0);
    expect((await router.taskPayments(1)).verdictBudgetRemaining).to.equal(0);
  });

  it("mints JINN from TaskCoordinatorRouterV3 activity via TaskClaimEmitter and MockMessenger", async function () {
    const {
      coordinator,
      router,
      marketplace,
      activity,
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
    } = await deploy(ethers.parseEther("0.01"), ethers.parseEther("0.005"), "v3");

    const p = await policy(2, 1);
    await router.connect(operatorA).createTask(
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

    await marketplace.markDelivered(first.requestId, await mechA.getAddress());
    await marketplace.markDelivered(second.requestId, await mechB.getAddress());
    await router.connect(operatorA).claimSolutionDelivery(first.requestId, SOLUTION_A);
    await router.connect(operatorB).claimSolutionDelivery(second.requestId, SOLUTION_B);

    const verdictA = await claimAndReadVerdictRequest(router, evaluator, 1, first.attemptIndex, evaluatorMech);
    const verdictB = await claimAndReadVerdictRequest(router, operatorA, 1, second.attemptIndex, operatorAVerdictMech);

    await marketplace.markDelivered(verdictA.requestId, await evaluatorMech.getAddress());
    await marketplace.markDelivered(verdictB.requestId, await operatorAVerdictMech.getAddress());
    await router.connect(evaluator).claimVerdictDelivery(verdictA.requestId, VERDICT_A, 1);
    await router.connect(operatorA).claimVerdictDelivery(verdictB.requestId, VERDICT_B, 1);

    expect(await activity.taskCreationWeight(await operatorA.getAddress())).to.equal(ONE);
    expect(await activity.solutionDeliveryWeight(await operatorA.getAddress())).to.equal(ONE);
    expect(await activity.verdictDeliveryWeight(await operatorA.getAddress())).to.equal(ONE);

    const Registry = await ethers.getContractFactory("MockServiceRegistryForEmitter");
    const registry = await Registry.deploy();
    await registry.waitForDeployment();
    await registry.setMultisig(SERVICE_ID, await operatorA.getAddress());

    const Emitter = await ethers.getContractFactory("TaskClaimEmitter");
    const emitter = await Emitter.deploy(await activity.getAddress(), await registry.getAddress());
    await emitter.waitForDeployment();

    const MockMessenger = await ethers.getContractFactory(MOCK_MESSENGER_FQN);
    const messenger = await MockMessenger.deploy(await operatorA.getAddress());
    await messenger.waitForDeployment();

    const Jinn = await ethers.getContractFactory(JINN_FQN);
    const jinn = await Jinn.deploy("Jinn", "JINN", await operatorA.getAddress());
    await jinn.waitForDeployment();

    const Distributor = await ethers.getContractFactory(DISTRIBUTOR_FQN);
    const distributor = await Distributor.deploy(
      await operatorA.getAddress(),
      await jinn.getAddress(),
      await dao.getAddress(),
      await messenger.getAddress(),
      OPERATOR_RATIO,
      DAO_RATIO,
      1n,
      1n,
      1n,
    );
    await distributor.waitForDeployment();
    await jinn.connect(operatorA).setMinter(await distributor.getAddress());

    const emitTx = await emitter.connect(operatorA).emitClaim(SERVICE_ID);
    const receipt = await emitTx.wait();
    const ticket = receipt!.logs
      .map((log: unknown) => {
        try { return emitter.interface.parseLog(log); } catch { return null; }
      })
      .find((log: null | { name: string }) => log?.name === "ClaimTicket")!;

    const claimId = ticket.args.claimId as bigint;
    const taskCreationWeight = ticket.args.taskCreationWeight as bigint;
    const solutionDeliveryWeight = ticket.args.solutionDeliveryWeight as bigint;
    const verdictDeliveryWeight = ticket.args.verdictDeliveryWeight as bigint;
    const multisig = ticket.args.multisig as string;

    expect(claimId).to.equal(1n);
    expect(ticket.args.serviceId).to.equal(SERVICE_ID);
    expect(taskCreationWeight).to.equal(ONE);
    expect(solutionDeliveryWeight).to.equal(ONE);
    expect(verdictDeliveryWeight).to.equal(ONE);
    expect(multisig).to.equal(await operatorA.getAddress());

    const snapshotHash = expectedSnapshotHash({
      claimId,
      serviceId: SERVICE_ID,
      taskCreationWeight,
      solutionDeliveryWeight,
      verdictDeliveryWeight,
      multisig,
    });
    expect(await emitter.claimSnapshotHashes(claimId)).to.equal(snapshotHash);

    await messenger.connect(operatorA).setFixture(claimId, {
      serviceId: SERVICE_ID,
      taskCreationWeight,
      solutionDeliveryWeight,
      verdictDeliveryWeight,
      multisig,
    });

    const proof = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [claimId]);
    const operatorMinted = (3n * ONE * OPERATOR_RATIO) / ONE;
    const daoMinted = (3n * ONE * DAO_RATIO) / ONE;

    await expect(distributor.connect(evaluator).claim(proof))
      .to.emit(distributor, "Claimed")
      .withArgs(SERVICE_ID, await operatorA.getAddress(), operatorMinted, daoMinted, operatorMinted, daoMinted);

    expect(await jinn.balanceOf(await operatorA.getAddress())).to.equal(operatorMinted);
    expect(await jinn.balanceOf(await dao.getAddress())).to.equal(daoMinted);
    expect(await distributor.totalClaimedOperator(SERVICE_ID)).to.equal(operatorMinted);
    expect(await distributor.totalClaimedDao(SERVICE_ID)).to.equal(daoMinted);

    const task = await coordinator.getTask(1);
    expect(task.finalizedAttemptCount).to.equal(2);
    expect(task.taskCreationCredited).to.equal(true);
  });
});
