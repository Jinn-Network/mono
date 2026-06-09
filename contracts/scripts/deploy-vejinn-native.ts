/**
 * Rung 2 (issue #1135): deploy veJINN (veOLAS) against the NATIVE JINN ERC-20
 * precompile and prove one lock escrows native JINN via approve + createLock.
 *
 * No JINN.sol is deployed — the token is the native x/erc20 coin at the fixed
 * precompile address. The script is also the acceptance gate: it asserts the
 * five rung-2 conditions and exits non-zero on any failure.
 *
 * Run: LOCAL_RPC_URL=http://127.0.0.1:8545 LOCAL_CHAIN_ID=262144 \
 *      LOCAL_PRIVATE_KEY=<dev0 key> \
 *      yarn hardhat run scripts/deploy-vejinn-native.ts --network localhost
 */
import { network } from "hardhat";
import { Contract, Wallet } from "ethers";
import { isRunEntry } from "./lib/run-entry.js";

// Native JINN surfaced to the EVM as a standard ERC-20 (rung-1 x/erc20 token pair).
const NATIVE_JINN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

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
  const ONE_YEAR = 365n * 24n * 60n * 60n; // createLock arg is a DURATION (veOLAS:433)

  console.log("== rung-2 acceptance ==");

  // Fresh ephemeral locker each run (keeps the gate idempotent — veOLAS forbids
  // a second createLock on an existing lock). dev0 funds it with native JINN,
  // which covers both the lock amount and the locker's gas (same coin).
  const locker = Wallet.createRandom().connect(ethers.provider);
  const me = locker.address;
  await (
    await deployer.sendTransaction({ to: me, value: amount * 3n })
  ).wait();
  const jinn = new Contract(NATIVE_JINN, ERC20_ABI, locker);

  // 1. deploy veJINN pointed at the native JINN precompile
  const VeOLAS = await ethers.getContractFactory(
    "src/vendor/governance/veOLAS.sol:veOLAS",
  );
  const veJinnDeployed = await VeOLAS.deploy(
    NATIVE_JINN,
    "Voting Escrow JINN",
    "veJINN",
  );
  await veJinnDeployed.waitForDeployment();
  const veAddr = await veJinnDeployed.getAddress();
  const veJinn = veJinnDeployed.connect(locker); // locker is the one who locks
  const tokenAddr: string = await veJinn.token();
  assert(
    tokenAddr.toLowerCase() === NATIVE_JINN.toLowerCase(),
    `1. veJINN deployed at ${veAddr}, token() = native JINN`,
  );

  // 5 (run first, while the locker has no lock yet). Fidelity: with allowance
  // SHORT of the amount, createLock MUST revert. If it does not, the precompile
  // returned false instead of reverting and veOLAS's unchecked transferFrom
  // would mint ve-balance without escrow — a hard stop, not a pass.
  await (await jinn.approve(veAddr, amount / 2n)).wait();
  let reverted = false;
  try {
    await (await veJinn.createLock(amount, ONE_YEAR)).wait();
  } catch {
    reverted = true;
  }
  const lockedAfterShort = (await veJinn.mapLockedBalances(me))[0] as bigint;
  assert(
    reverted && lockedAfterShort === 0n,
    "5. createLock reverts when allowance < amount (precompile enforces allowance for a contract spender)",
  );

  // 2 + 3. real lock: approve full, createLock, prove escrow on both sides
  const lockerBefore = (await jinn.balanceOf(me)) as bigint;
  const veBefore = (await jinn.balanceOf(veAddr)) as bigint;
  await (await jinn.approve(veAddr, amount)).wait();
  await (await veJinn.createLock(amount, ONE_YEAR)).wait();
  const lockerAfter = (await jinn.balanceOf(me)) as bigint;
  const veAfter = (await jinn.balanceOf(veAddr)) as bigint;
  assert(
    veAfter - veBefore === amount,
    `2. createLock escrowed ${amount} into veJINN (veJINN JINN balance +${veAfter - veBefore})`,
  );
  assert(
    lockerBefore - lockerAfter >= amount, // >= because the locker also pays gas in native JINN
    `3. locker's native JINN balance fell by >= ${amount} (delta ${lockerBefore - lockerAfter})`,
  );

  // 4. veJINN lock state reflects the lock
  const [lockedAmount, endTime] = await veJinn.mapLockedBalances(me);
  const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  const veBal = (await veJinn.balanceOf(me)) as bigint;
  assert(
    (lockedAmount as bigint) === amount &&
      (endTime as bigint) > now &&
      veBal > 0n,
    `4. lock state: locked=${lockedAmount}, endTime>${now}=${
      (endTime as bigint) > now
    }, veBalance=${veBal}`,
  );

  console.log(`== veJINN ${veAddr} — all rung-2 assertions passed ==`);
}

if (isRunEntry(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
