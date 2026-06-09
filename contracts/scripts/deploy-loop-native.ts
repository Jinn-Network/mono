/**
 * Rung 3 (issue #1137): close the protocol loop on native JINN.
 *
 * Deploys veJINN + VoteWeighting + JinnRouterV3 + TaskActivityCheckerV3 against
 * the live native-JINN devnet and runs lock -> vote -> activity tick -> read back.
 * No JINN.sol (token is the native x/erc20 precompile); no mech marketplace and
 * no tokenomics stack (the tick is driven deployer-as-router, matching the spike
 * §5). The script is the acceptance gate: it asserts the rung-3 conditions and
 * exits non-zero on any failure.
 *
 * Run: LOCAL_RPC_URL=http://127.0.0.1:8545 LOCAL_CHAIN_ID=262144 \
 *      LOCAL_PRIVATE_KEY=<dev0 key> \
 *      yarn hardhat run scripts/deploy-loop-native.ts --network localhost
 */
import { network } from "hardhat";
import { Contract, Wallet, keccak256, toUtf8Bytes, zeroPadValue } from "ethers";
import { isRunEntry } from "./lib/run-entry.js";

const NATIVE_JINN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];
const STUB = "0x0000000000000000000000000000000000000001"; // non-zero placeholder
const NOMINEE_CHAIN_ID = 262144n; // the EVM chain id the nominee lives on

function assert(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    console.log(`  FAIL  ${label}`);
    throw new Error(`assertion failed: ${label}`);
  }
}

export async function main(): Promise<void> {
  const { ethers } = await network.connect();
  const [deployer] = await ethers.getSigners();
  const amount = 10n ** 18n; // 1 JINN
  const ONE_YEAR = 365n * 24n * 60n * 60n; // createLock arg is a DURATION

  console.log("== rung-3 acceptance (lock -> vote -> tick on native JINN) ==");

  // Fresh ephemeral locker each run (keeps the gate idempotent).
  const locker = Wallet.createRandom().connect(ethers.provider);
  await (await deployer.sendTransaction({ to: locker.address, value: amount * 3n })).wait();
  const jinn = new Contract(NATIVE_JINN, ERC20_ABI, locker);

  // 1. veJINN + lock (reuse rung-2 flow)
  const VeOLAS = await ethers.getContractFactory("src/vendor/governance/veOLAS.sol:veOLAS");
  const veJinn = await VeOLAS.deploy(NATIVE_JINN, "Voting Escrow JINN", "veJINN");
  await veJinn.waitForDeployment();
  const veAddr = await veJinn.getAddress();
  await (await jinn.approve(veAddr, amount)).wait();
  await (await veJinn.connect(locker).createLock(amount, ONE_YEAR)).wait();
  assert(
    ((await jinn.balanceOf(veAddr)) as bigint) === amount,
    `1. veJINN ${veAddr} holds the locked JINN (${amount})`,
  );
  assert(
    ((await veJinn.balanceOf(locker.address)) as bigint) > 0n,
    "1b. locker has ve-weight",
  );

  // 2. VoteWeighting gauge: add a nominee, vote with the locked weight
  const VW = await ethers.getContractFactory(
    "src/vendor/governance/VoteWeighting.sol:VoteWeighting",
  );
  const vw = await VW.deploy(veAddr);
  await vw.waitForDeployment();
  const target = deployer.address; // arbitrary EVM nominee (a staking target)
  const targetB32 = zeroPadValue(target, 32); // bytes32(uint256(uint160(addr)))
  await (await vw.addNomineeEVM(target, NOMINEE_CHAIN_ID)).wait();
  const WEIGHT = 10000n; // 100% of the locker's voting power
  await (await vw.connect(locker).voteForNomineeWeights(targetB32, NOMINEE_CHAIN_ID, WEIGHT)).wait();
  assert(
    ((await vw.voteUserPower(locker.address)) as bigint) === WEIGHT,
    `2. locker's vote registered on the gauge (voteUserPower == ${WEIGHT})`,
  );
  console.log(`   (nominee weight now: ${await vw.getNomineeWeight(targetB32, NOMINEE_CHAIN_ID)})`);

  // 3. router + checker deploy + initialize on the native-JINN chain
  const Checker = await ethers.getContractFactory(
    "src/staking/TaskActivityCheckerV3.sol:TaskActivityCheckerV3",
  );
  const checker = await Checker.deploy();
  await checker.waitForDeployment();
  await (await checker.initialize(1n, deployer.address, 0n, 0n, 1n)).wait();
  const Router = await ethers.getContractFactory("src/staking/JinnRouterV3.sol:JinnRouterV3");
  const router = await Router.deploy();
  await router.waitForDeployment();
  await (await router.initialize(deployer.address, STUB, STUB, await checker.getAddress())).wait();
  assert(
    ((await router.activityChecker()) as string).toLowerCase() ===
      (await checker.getAddress()).toLowerCase(),
    "3. JinnRouterV3 + TaskActivityCheckerV3 initialized on native JINN",
  );

  // 4. one activity tick via the checker's authorized-router path (deployer-as-
  // router, as the spike did) — read-back increments
  await (await checker.setAuthorizedRouter(deployer.address)).wait();
  const operator = locker.address;
  const before = (await checker.getSolutionEvidenceHashCount(operator)) as bigint;
  await (
    await checker.recordSolutionDelivery(operator, keccak256(toUtf8Bytes("rung3-solution")))
  ).wait();
  const after = (await checker.getSolutionEvidenceHashCount(operator)) as bigint;
  assert(after - before === 1n, `4. activity tick recorded through the router path (evidence +${after - before})`);

  // 5. lock + escrow still intact after the loop
  const lockedAmount = (await veJinn.mapLockedBalances(locker.address))[0] as bigint;
  assert(
    lockedAmount === amount && ((await jinn.balanceOf(veAddr)) as bigint) === amount,
    "5. ve-lock and JINN escrow intact after the loop",
  );

  console.log("== loop closed on native JINN — all rung-3 assertions passed ==");
}

if (isRunEntry(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
