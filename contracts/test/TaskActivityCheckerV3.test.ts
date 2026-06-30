import { expect } from "chai";
import { network } from "hardhat";

describe("TaskActivityCheckerV3", function () {
  let ethers: Awaited<ReturnType<typeof network.connect>>["ethers"];
  before(async () => {
    ({ ethers } = await network.connect());
  });

  async function deploy() {
    const [owner, router, operator, evaluator, creator] = await ethers.getSigners();
    const Checker = await ethers.getContractFactory("TaskActivityCheckerV3");
    const checker = await Checker.deploy();
    await checker.waitForDeployment();
    await checker.initialize(
      ethers.parseEther("0.001"),
      await owner.getAddress(),
      64,
      0,
      20,
    );
    await checker.connect(owner).setAuthorizedRouter(await router.getAddress());

    const Safe = await ethers.getContractFactory("MockSafeWithNonce");
    const safe = await Safe.deploy();
    await safe.waitForDeployment();

    return { checker, owner, router, operator, evaluator, creator, safe };
  }

  it("records flat full-weight Solution delivery (anti-farming decay removed)", async function () {
    const { checker, router, operator } = await deploy();
    const solutionDigest = ethers.keccak256(ethers.toUtf8Bytes("same-solution"));

    await expect(checker.connect(router).recordSolutionDelivery(await operator.getAddress(), solutionDigest))
      .to.emit(checker, "SolutionDeliveryRecorded")
      .withArgs(await operator.getAddress(), solutionDigest, ethers.parseEther("1"));

    expect(await checker.solutionDeliveryWeight(await operator.getAddress())).to.equal(ethers.parseEther("1"));
    expect(await checker.eligibleActivityWeight(await operator.getAddress())).to.equal(ethers.parseEther("1"));

    // No novelty/similarity decay anymore: a repeated digest credits full weight again.
    await checker.connect(router).recordSolutionDelivery(await operator.getAddress(), solutionDigest);
    expect(await checker.solutionDeliveryWeight(await operator.getAddress())).to.equal(ethers.parseEther("2"));
    expect(await checker.eligibleActivityWeight(await operator.getAddress())).to.equal(ethers.parseEther("2"));
  });

  it("records Verdict delivery at full weight", async function () {
    const { checker, router, evaluator } = await deploy();
    const verdictDigest = ethers.keccak256(ethers.toUtf8Bytes("verdict"));

    await checker.connect(router).recordVerdictDelivery(await evaluator.getAddress(), verdictDigest);
    await checker.connect(router).recordVerdictDelivery(await evaluator.getAddress(), verdictDigest);

    expect(await checker.verdictDeliveryWeight(await evaluator.getAddress())).to.equal(ethers.parseEther("2"));
    expect(await checker.eligibleActivityWeight(await evaluator.getAddress())).to.equal(ethers.parseEther("2"));
  });

  it("records Task creation finalization once per Task", async function () {
    const { checker, router, creator } = await deploy();

    await checker.connect(router).recordTaskCreationFinalized(await creator.getAddress(), 1, ethers.parseEther("1"));
    expect(await checker.taskCreationWeight(await creator.getAddress())).to.equal(ethers.parseEther("1"));
    expect(await checker.eligibleActivityWeight(await creator.getAddress())).to.equal(ethers.parseEther("1"));

    await expect(
      checker.connect(router).recordTaskCreationFinalized(await creator.getAddress(), 1, ethers.parseEther("1"))
    ).to.be.revertedWithCustomError(checker, "TACTaskAlreadyCredited");
  });

  it("namespaces Task-creation credit per router (no cross-coordinator taskId collision)", async function () {
    const { checker, owner, router, creator } = await deploy();
    const routerB = (await ethers.getSigners())[5];

    // Router A finalizes taskId 1.
    await checker.connect(router).recordTaskCreationFinalized(await creator.getAddress(), 1, ethers.parseEther("1"));

    // The checker proxy is shared and persists across coordinator/router redeploys, but a
    // fresh coordinator restarts taskIds at 1. Re-point the shared checker to router B and
    // finalize taskId 1 again — this must NOT revert, because the dedup key is
    // keccak256(router, taskId), so (B,1) does not collide with the already-credited (A,1).
    // (A direct call that reverts would fail the test; the weight assertion below confirms success.)
    await checker.connect(owner).setAuthorizedRouter(await routerB.getAddress());
    await checker.connect(routerB).recordTaskCreationFinalized(await creator.getAddress(), 1, ethers.parseEther("1"));

    // Creator credited once per router (2e18 total) — proves the per-router keys are distinct.
    expect(await checker.taskCreationWeight(await creator.getAddress())).to.equal(ethers.parseEther("2"));
  });

  it("returns Safe nonce plus Task-native eligible activity weight", async function () {
    const { checker, router, safe } = await deploy();
    const safeAddress = await safe.getAddress();
    await safe.incrementNonce();
    await checker.connect(router).recordVerdictDelivery(safeAddress, ethers.keccak256(ethers.toUtf8Bytes("verdict")));

    const nonces = await checker.getMultisigNonces(safeAddress);
    expect(nonces[0]).to.equal(1);
    expect(nonces[1]).to.equal(ethers.parseEther("1"));
  });

  it("rejects non-router writers", async function () {
    const { checker, operator } = await deploy();
    await expect(
      checker.recordSolutionDelivery(await operator.getAddress(), ethers.keccak256(ethers.toUtf8Bytes("solution")))
    ).to.be.revertedWithCustomError(checker, "TACUnauthorizedRouter");
  });
});
