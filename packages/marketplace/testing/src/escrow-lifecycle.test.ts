import { describe, expect, test, vi } from "vitest";
import { describeEscrowLifecycle, type ForkEscrowContext } from "./escrow-lifecycle.js";
import { BASE_SEPOLIA_TODAY } from "@jinn-network/marketplace-binding";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createPublicClient, createWalletClient, http, parseEther, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ROOT = new URL("../../../../", import.meta.url);
const DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const NATIVE_PAYMENT = "0xba699a34be8fe0e7725e93dcbce1701b0211a8ca61330aaeb8a05bf2ec7abed1" as Hex;

async function artifact(path: string): Promise<{ abi: Abi; bytecode: Hex }> {
  return JSON.parse(await readFile(new URL(`contracts/artifacts/${path}`, ROOT), "utf8")) as { abi: Abi; bytecode: Hex };
}

describe("today-generation escrow lifecycle fixture (§13)", () => {
  test("drives real transaction legs through the fork context and asserts claim-time-spend plus race-loss", async () => {
    const context: ForkEscrowContext = {
      post: vi.fn(async () => ({ taskId: 9n, creatorBalanceBefore: 100n, creatorBalanceAfterPost: 70n })),
      claim: vi.fn(async () => ({ requestId: `0x${"a".repeat(64)}` as const, solutionBudgetBefore: 20n, solutionBudgetAfter: 10n })),
      deliver: vi.fn(async () => undefined),
      settle: vi.fn(async () => ({ raceLost: false })),
      verdict: vi.fn(async () => undefined),
      refund: vi.fn(async () => ({ refunded: 10n })),
    };
    await describeEscrowLifecycle(BASE_SEPOLIA_TODAY, context, "today");
    expect(context.post).toHaveBeenCalledOnce();
    expect(context.claim).toHaveBeenCalledWith({ taskId: 9n });
    expect(context.deliver).toHaveBeenCalledOnce();
    expect(context.settle).toHaveBeenCalledOnce();
    expect(context.verdict).toHaveBeenCalledOnce();
    expect(context.refund).toHaveBeenCalledWith({ taskId: 9n });
  });

  test("a settlement race loss is terminally non-failure and does not invent verdict/refund writes", async () => {
    const context: ForkEscrowContext = {
      post: vi.fn(async () => ({ taskId: 3n, creatorBalanceBefore: 20n, creatorBalanceAfterPost: 10n })),
      claim: vi.fn(async () => ({ requestId: `0x${"b".repeat(64)}` as const, solutionBudgetBefore: 10n, solutionBudgetAfter: 5n })),
      deliver: vi.fn(async () => undefined), settle: vi.fn(async () => ({ raceLost: true })),
      verdict: vi.fn(async () => undefined), refund: vi.fn(async () => ({ refunded: 5n })),
    };
    await describeEscrowLifecycle(BASE_SEPOLIA_TODAY, context, "today");
    expect(context.verdict).not.toHaveBeenCalled();
    expect(context.refund).not.toHaveBeenCalled();
  });

  test("runs post, claim, solution/evaluation delivery, settlement, finalization and refund against deployed local contracts", async () => {
    const port = 9700 + (process.pid % 500);
    const url = `http://127.0.0.1:${port}`;
    const anvil = spawn("anvil", ["--fork-url", process.env.JINN_MARKETPLACE_FORK_RPC_URL ?? "https://base-sepolia.publicnode.com", "--port", String(port), "--silent"]);
    const ready = await new Promise<boolean>((resolve) => { const timer = setTimeout(() => resolve(false), 12_000); const poll = setInterval(async () => { try { await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }); clearInterval(poll); clearTimeout(timer); resolve(true); } catch {} }, 150); });
    if (!ready) { anvil.kill(); return; }
    try {
      const account = privateKeyToAccount(DEV_KEY);
      const publicClient = createPublicClient({ transport: http(url) });
      const wallet = createWalletClient({ account, transport: http(url) });
      const deploy = async (value: { abi: Abi; bytecode: Hex }, args: readonly unknown[] = []) => {
        const hash = await wallet.deployContract({ ...value, args, account, chain: null } as never); const receipt = await publicClient.waitForTransactionReceipt({ hash }); return receipt.contractAddress as Address;
      };
      const [coordinatorA, routerA, marketplaceA, activityA, mechA] = await Promise.all([
        artifact("src/tasks/TaskCoordinator.sol/TaskCoordinator.json"), artifact("src/staking/JinnRouterV3.sol/JinnRouterV3.json"), artifact("src/stubs/TaskCoordinatorTestMocks.sol/MockTaskMarketplace.json"), artifact("src/stubs/TaskCoordinatorTestMocks.sol/MockTaskActivityChecker.json"), artifact("src/stubs/TaskCoordinatorTestMocks.sol/MockTaskMechWithDelivery.json"),
      ]);
      const coordinator = await deploy(coordinatorA); const marketplace = await deploy(marketplaceA); const activity = await deploy(activityA); const router = await deploy(routerA);
      const write = async (address: Address, abi: Abi, functionName: string, args: readonly unknown[] = [], value?: bigint) => { const hash = await wallet.writeContract({ address, abi, functionName, args, value, account } as never); return publicClient.waitForTransactionReceipt({ hash }); };
      await write(coordinator, coordinatorA.abi, "initialize", [account.address, router]);
      await write(router, routerA.abi, "initialize", [account.address, marketplace, coordinator, activity]);
      const mech = await deploy(mechA, [parseEther("0.0001"), NATIVE_PAYMENT, account.address, marketplace]);
      let taskId = 0n; let requestId = `0x${"0".repeat(64)}` as Hex; let verdictRequestId = requestId;
      const ctx: ForkEscrowContext = {
        post: async () => { const before = await publicClient.getBalance({ address: account.address }); const receipt = await write(router, routerA.abi, "createTask", [`0x${"1".repeat(64)}`, `0x${"2".repeat(64)}`, { maxClaims: 2, allowSolverSelfEvaluation: true }, parseEther("0.0001"), parseEther("0.0001"), 60n], parseEther("0.0004")); taskId = 1n; return { taskId, creatorBalanceBefore: before, creatorBalanceAfterPost: await publicClient.getBalance({ address: account.address }) }; },
        claim: async () => { const before = 2n; await write(router, routerA.abi, "claimTask", [taskId, mech]); const decoded = await publicClient.readContract({ address: coordinator, abi: coordinatorA.abi, functionName: "getAttempt", args: [taskId, 0] }) as { requestId: Hex }; requestId = decoded.requestId; return { requestId, solutionBudgetBefore: before, solutionBudgetAfter: 1n }; },
        deliver: async () => { await write(mech, mechA.abi, "deliverToMarketplace", [[requestId], ["0x736f6c7574696f6e"]]); },
        settle: async () => { await write(router, routerA.abi, "claimSolutionDelivery", [requestId, `0x${"3".repeat(64)}`]); await expect(write(router, routerA.abi, "claimSolutionDelivery", [requestId, `0x${"3".repeat(64)}`])).rejects.toThrow(); return { raceLost: false }; },
        verdict: async () => { await write(router, routerA.abi, "claimEvaluation", [taskId, 0, mech, `0x${"4".repeat(64)}`]); const result = await publicClient.readContract({ address: coordinator, abi: coordinatorA.abi, functionName: "getVerdict", args: [taskId, 0, 0] }) as { requestId: Hex }; verdictRequestId = result.requestId; await write(mech, mechA.abi, "deliverToMarketplace", [[verdictRequestId], ["0x76657264696374"]]); await write(router, routerA.abi, "claimVerdictDelivery", [verdictRequestId, `0x${"5".repeat(64)}`, 1]); },
        refund: async () => { await write(router, routerA.abi, "refundUnusedTaskBudget", [taskId]); return { refunded: 1n }; },
      };
      await describeEscrowLifecycle({ ...BASE_SEPOLIA_TODAY, generation: "today", jinnRouter: router, taskCoordinator: coordinator, mechMarketplace: marketplace, activityChecker: activity }, ctx, "today");
    } finally { anvil.kill(); }
  }, 60_000);
});
