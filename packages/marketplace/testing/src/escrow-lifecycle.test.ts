import { describe, expect, test, vi } from "vitest";
import { describeEscrowLifecycle, type ForkEscrowContext } from "./escrow-lifecycle.js";
import { BASE_SEPOLIA_TODAY } from "@jinn-network/marketplace-binding";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createPublicClient, createWalletClient, decodeEventLog, http, parseEther, type Abi, type Address, type Hex } from "viem";
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
    if (!ready) { anvil.kill(); throw new Error("Anvil/Base-Sepolia fork prerequisite unavailable; fixture did not run"); }
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
        post: async () => { const before = await publicClient.getBalance({ address: account.address }); const receipt = await write(router, routerA.abi, "createTask", [`0x${"1".repeat(64)}`, `0x${"2".repeat(64)}`, { maxClaims: 2, allowSolverSelfEvaluation: true }, parseEther("0.0001"), parseEther("0.0001"), 60n], parseEther("0.0004")); const created = receipt.logs.map((log) => { try { return decodeEventLog({ abi: routerA.abi, data: log.data, topics: log.topics }); } catch { return undefined; } }).find((event) => event?.eventName === "TaskCreated") as { args?: { taskId?: bigint } } | undefined; if (created?.args?.taskId === undefined) throw new Error("TaskCreated was absent"); taskId = created.args.taskId; return { taskId, creatorBalanceBefore: before, creatorBalanceAfterPost: await publicClient.getBalance({ address: account.address }) }; },
        claim: async () => { const before = (await publicClient.readContract({ address: router, abi: routerA.abi, functionName: "taskPayments", args: [taskId] }) as { solutionBudgetRemaining: bigint }).solutionBudgetRemaining; await write(router, routerA.abi, "claimTask", [taskId, mech]); const after = (await publicClient.readContract({ address: router, abi: routerA.abi, functionName: "taskPayments", args: [taskId] }) as { solutionBudgetRemaining: bigint }).solutionBudgetRemaining; const decoded = await publicClient.readContract({ address: coordinator, abi: coordinatorA.abi, functionName: "getAttempt", args: [taskId, 0] }) as { requestId: Hex }; requestId = decoded.requestId; return { requestId, solutionBudgetBefore: before, solutionBudgetAfter: after }; },
        deliver: async () => { await write(mech, mechA.abi, "deliverToMarketplace", [[requestId], ["0x736f6c7574696f6e"]]); },
        settle: async () => { await write(router, routerA.abi, "claimSolutionDelivery", [requestId, `0x${"3".repeat(64)}`]); await expect(write(router, routerA.abi, "claimSolutionDelivery", [requestId, `0x${"3".repeat(64)}`])).rejects.toThrow(); return { raceLost: false }; },
        verdict: async () => { await write(router, routerA.abi, "claimEvaluation", [taskId, 0, mech, `0x${"4".repeat(64)}`]); const result = await publicClient.readContract({ address: coordinator, abi: coordinatorA.abi, functionName: "getVerdict", args: [taskId, 0, 0] }) as { requestId: Hex }; verdictRequestId = result.requestId; await write(mech, mechA.abi, "deliverToMarketplace", [[verdictRequestId], ["0x76657264696374"]]); await write(router, routerA.abi, "claimVerdictDelivery", [verdictRequestId, `0x${"5".repeat(64)}`, 1]); },
        refund: async () => { const before = await publicClient.readContract({ address: router, abi: routerA.abi, functionName: "taskPayments", args: [taskId] }) as readonly unknown[]; await write(router, routerA.abi, "refundUnusedTaskBudget", [taskId]); const after = await publicClient.readContract({ address: router, abi: routerA.abi, functionName: "taskPayments", args: [taskId] }) as readonly unknown[]; expect(after[6]).toBe(0n); expect(after[7]).toBe(0n); expect(after[8]).toBe(true); expect(after[9]).toBe(true); return { refunded: (before[6] as bigint) + (before[7] as bigint) }; },
      };
      await describeEscrowLifecycle({ ...BASE_SEPOLIA_TODAY, generation: "today", jinnRouter: router, taskCoordinator: coordinator, mechMarketplace: marketplace, activityChecker: activity }, ctx, "today");
    } finally { anvil.kill(); }
  }, 60_000);

  test("drives a mined losing settlement through the real race-loss lifecycle without verdict or refund writes", async () => {
    const port = 10_200 + (process.pid % 500);
    const url = `http://127.0.0.1:${port}`;
    const anvil = spawn("anvil", [
      "--fork-url",
      process.env.JINN_MARKETPLACE_FORK_RPC_URL ?? "https://base-sepolia.publicnode.com",
      "--port",
      String(port),
      "--silent",
    ]);
    const ready = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 12_000);
      const poll = setInterval(async () => {
        try {
          await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}',
          });
          clearInterval(poll);
          clearTimeout(timer);
          resolve(true);
        } catch {}
      }, 150);
    });
    if (!ready) {
      anvil.kill();
      throw new Error("Anvil/Base-Sepolia fork prerequisite unavailable; fixture did not run");
    }

    try {
      const account = privateKeyToAccount(DEV_KEY);
      const publicClient = createPublicClient({ transport: http(url) });
      const wallet = createWalletClient({ account, transport: http(url) });
      const deploy = async (
        value: { abi: Abi; bytecode: Hex },
        args: readonly unknown[] = [],
      ) => {
        const hash = await wallet.deployContract({
          ...value,
          args,
          account,
          chain: null,
        } as never);
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        return receipt.contractAddress as Address;
      };
      const [coordinatorA, routerA, marketplaceA, activityA, mechA] = await Promise.all([
        artifact("src/tasks/TaskCoordinator.sol/TaskCoordinator.json"),
        artifact("src/staking/JinnRouterV3.sol/JinnRouterV3.json"),
        artifact("src/stubs/TaskCoordinatorTestMocks.sol/MockTaskMarketplace.json"),
        artifact("src/stubs/TaskCoordinatorTestMocks.sol/MockTaskActivityChecker.json"),
        artifact("src/stubs/TaskCoordinatorTestMocks.sol/MockTaskMechWithDelivery.json"),
      ]);
      const coordinator = await deploy(coordinatorA);
      const marketplace = await deploy(marketplaceA);
      const activity = await deploy(activityA);
      const router = await deploy(routerA);
      const write = async (
        address: Address,
        abi: Abi,
        functionName: string,
        args: readonly unknown[] = [],
        value?: bigint,
      ) => {
        const hash = await wallet.writeContract({
          address,
          abi,
          functionName,
          args,
          value,
          account,
        } as never);
        return publicClient.waitForTransactionReceipt({ hash });
      };
      await write(coordinator, coordinatorA.abi, "initialize", [account.address, router]);
      await write(router, routerA.abi, "initialize", [
        account.address,
        marketplace,
        coordinator,
        activity,
      ]);
      const mech = await deploy(mechA, [
        parseEther("0.0001"),
        NATIVE_PAYMENT,
        account.address,
        marketplace,
      ]);

      let taskId = 0n;
      let requestId = `0x${"0".repeat(64)}` as Hex;
      let paymentBeforeTerminal: readonly unknown[] | undefined;
      const verdict = vi.fn(async () => {
        await write(router, routerA.abi, "claimEvaluation", [
          taskId,
          0,
          mech,
          `0x${"8".repeat(64)}`,
        ]);
      });
      const refund = vi.fn(async () => {
        const before = await publicClient.readContract({
          address: router,
          abi: routerA.abi,
          functionName: "taskPayments",
          args: [taskId],
        }) as readonly unknown[];
        await write(router, routerA.abi, "refundUnusedTaskBudget", [taskId]);
        const after = await publicClient.readContract({
          address: router,
          abi: routerA.abi,
          functionName: "taskPayments",
          args: [taskId],
        }) as readonly unknown[];
        return {
          refunded:
            (before[6] as bigint) +
            (before[7] as bigint) -
            (after[6] as bigint) -
            (after[7] as bigint),
        };
      });
      const context: ForkEscrowContext = {
        post: async () => {
          const creatorBalanceBefore = await publicClient.getBalance({
            address: account.address,
          });
          const receipt = await write(
            router,
            routerA.abi,
            "createTask",
            [
              `0x${"6".repeat(64)}`,
              `0x${"7".repeat(64)}`,
              { maxClaims: 2, allowSolverSelfEvaluation: true },
              parseEther("0.0001"),
              parseEther("0.0001"),
              60n,
            ],
            parseEther("0.0004"),
          );
          const created = receipt.logs
            .map((log) => {
              try {
                return decodeEventLog({
                  abi: routerA.abi,
                  data: log.data,
                  topics: log.topics,
                });
              } catch {
                return undefined;
              }
            })
            .find((event) => event?.eventName === "TaskCreated") as
            | { args?: { taskId?: bigint } }
            | undefined;
          if (created?.args?.taskId === undefined) throw new Error("TaskCreated was absent");
          taskId = created.args.taskId;
          return {
            taskId,
            creatorBalanceBefore,
            creatorBalanceAfterPost: await publicClient.getBalance({
              address: account.address,
            }),
          };
        },
        claim: async () => {
          const before = await publicClient.readContract({
            address: router,
            abi: routerA.abi,
            functionName: "taskPayments",
            args: [taskId],
          }) as { solutionBudgetRemaining: bigint };
          await write(router, routerA.abi, "claimTask", [taskId, mech]);
          const after = await publicClient.readContract({
            address: router,
            abi: routerA.abi,
            functionName: "taskPayments",
            args: [taskId],
          }) as { solutionBudgetRemaining: bigint };
          const attempt = await publicClient.readContract({
            address: coordinator,
            abi: coordinatorA.abi,
            functionName: "getAttempt",
            args: [taskId, 0],
          }) as { requestId: Hex };
          requestId = attempt.requestId;
          return {
            requestId,
            solutionBudgetBefore: before.solutionBudgetRemaining,
            solutionBudgetAfter: after.solutionBudgetRemaining,
          };
        },
        deliver: async () => {
          await write(
            mech,
            mechA.abi,
            "deliverToMarketplace",
            [[requestId], ["0x726163652d6c6f7373"]],
          );
        },
        settle: async () => {
          expect(await publicClient.readContract({
            address: router,
            abi: routerA.abi,
            functionName: "claimed",
            args: [requestId],
          })).toBe(false);
          paymentBeforeTerminal = await publicClient.readContract({
            address: router,
            abi: routerA.abi,
            functionName: "taskPayments",
            args: [taskId],
          }) as readonly unknown[];

          await write(
            router,
            routerA.abi,
            "claimSolutionDelivery",
            [requestId, `0x${"9".repeat(64)}`],
          );
          expect(await publicClient.readContract({
            address: router,
            abi: routerA.abi,
            functionName: "claimed",
            args: [requestId],
          })).toBe(true);
          expect(await publicClient.readContract({
            address: router,
            abi: routerA.abi,
            functionName: "solutionDeliveryClaimed",
            args: [requestId],
          })).toBe(true);

          const losingHash = await wallet.writeContract({
            address: router,
            abi: routerA.abi,
            functionName: "claimSolutionDelivery",
            args: [requestId, `0x${"a".repeat(64)}`],
            gas: 1_000_000n,
            account,
          } as never);
          const losingReceipt = await publicClient.waitForTransactionReceipt({
            hash: losingHash,
          });
          expect(losingReceipt.status).toBe("reverted");
          expect(await publicClient.readContract({
            address: router,
            abi: routerA.abi,
            functionName: "claimed",
            args: [requestId],
          })).toBe(true);
          const attempt = await publicClient.readContract({
            address: coordinator,
            abi: coordinatorA.abi,
            functionName: "getAttempt",
            args: [taskId, 0],
          }) as { solutionCidDigest: Hex; status: number };
          expect(attempt.solutionCidDigest).toBe(`0x${"9".repeat(64)}`);
          expect(attempt.status).toBe(3);
          return { raceLost: true };
        },
        verdict,
        refund,
      };

      await describeEscrowLifecycle(
        {
          ...BASE_SEPOLIA_TODAY,
          generation: "today",
          jinnRouter: router,
          taskCoordinator: coordinator,
          mechMarketplace: marketplace,
          activityChecker: activity,
        },
        context,
        "today",
      );

      const paymentAfter = await publicClient.readContract({
        address: router,
        abi: routerA.abi,
        functionName: "taskPayments",
        args: [taskId],
      }) as readonly unknown[];
      const attemptAfter = await publicClient.readContract({
        address: coordinator,
        abi: coordinatorA.abi,
        functionName: "getAttempt",
        args: [taskId, 0],
      }) as { verdictCount: number };
      expect(verdict).not.toHaveBeenCalled();
      expect(refund).not.toHaveBeenCalled();
      expect(paymentBeforeTerminal).toBeDefined();
      expect(paymentAfter.slice(6, 10)).toEqual(paymentBeforeTerminal?.slice(6, 10));
      expect(attemptAfter.verdictCount).toBe(0);
    } finally {
      anvil.kill();
    }
  }, 60_000);
});
