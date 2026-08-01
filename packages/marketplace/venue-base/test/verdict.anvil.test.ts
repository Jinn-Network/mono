// SPDX-License-Identifier: MIT

// Anvil-fork integration for the today-mode verdict port group. Reuses the marketplace-testing
// fork backbone via a relative import (no package dependency — `marketplace-testing` already
// depends on `venue-base`, so the reverse would be circular).
import { randomBytes } from "node:crypto";
import {
  JINN_ROUTER_V3_ABI,
  TASK_COORDINATOR_ABI,
  VerdictCode,
  executeSafeTransaction,
  keccakEvidenceHash,
} from "@jinn-network/marketplace-binding";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  http,
  parseEther,
  toHex,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, test } from "vitest";
import { createBaseVenue } from "../src/create-base-venue.js";
import {
  anvilAvailable,
  withForkVenue,
  type ForkVenueDeployment,
} from "../../testing/src/venue-fork.js";

const DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const MOCK_MECH_DELIVER_ABI = [
  {
    type: "function",
    name: "deliverToMarketplace",
    stateMutability: "nonpayable",
    inputs: [
      { name: "requestIds", type: "bytes32[]" },
      { name: "datas", type: "bytes[]" },
    ],
    outputs: [{ name: "deliveredRequests", type: "bool[]" }],
  },
] as const;
const CLAIMED_ABI = [{
  name: "claimed", type: "function", stateMutability: "view",
  inputs: [{ name: "requestId", type: "bytes32" }],
  outputs: [{ name: "", type: "bool" }],
}] as const;

const hasAnvil = await anvilAvailable();

function randomDigest(): Hex {
  return `0x${randomBytes(32).toString("hex")}` as Hex;
}

async function postFixtureTask(deployment: ForkVenueDeployment): Promise<bigint> {
  const account = privateKeyToAccount(DEV_KEY);
  const publicClient = createPublicClient({ transport: http(deployment.rpcUrl) });
  const wallet = createWalletClient({ account, transport: http(deployment.rpcUrl) });
  const rate = parseEther("0.0001");
  const value = rate * 2n * 2n;

  const hash = await wallet.writeContract({
    address: deployment.chain.jinnRouter,
    abi: JINN_ROUTER_V3_ABI,
    functionName: "createTask",
    args: [randomDigest(), randomDigest(), { maxClaims: 2, allowSolverSelfEvaluation: true }, rate, rate, 60n],
    value,
    account,
    chain: null,
  } as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const created = receipt.logs
    .map((log) => {
      try {
        return decodeEventLog({ abi: JINN_ROUTER_V3_ABI, data: log.data, topics: log.topics });
      } catch {
        return undefined;
      }
    })
    .find((event) => event?.eventName === "TaskCreated") as { args?: { taskId?: bigint } } | undefined;
  if (created?.args?.taskId === undefined) throw new Error("fixture task creation did not emit TaskCreated");
  return created.args.taskId;
}

async function deliverSolutionFixture(deployment: ForkVenueDeployment, requestId: Hex): Promise<Uint8Array> {
  const account = privateKeyToAccount(DEV_KEY);
  const publicClient = createPublicClient({ transport: http(deployment.rpcUrl) });
  const wallet = createWalletClient({ account, transport: http(deployment.rpcUrl) });
  const deliveryBytes = randomBytes(32);
  await executeSafeTransaction(publicClient, wallet, {
    safeAddress: deployment.safe,
    to: deployment.mech,
    value: 0n,
    data: encodeFunctionData({
      abi: MOCK_MECH_DELIVER_ABI,
      functionName: "deliverToMarketplace",
      args: [[requestId], [toHex(deliveryBytes)]],
    }),
  });
  return deliveryBytes;
}

describe.runIf(hasAnvil)("verdict ports against a forked chain", () => {
  test("opens, delivers, and settles a verdict; replay is already-settled", async () => {
    await withForkVenue({
      generation: "today",
      async run(deployment) {
        const account = privateKeyToAccount(DEV_KEY);
        const publicClient = createPublicClient({ transport: http(deployment.rpcUrl) });
        const walletClient = createWalletClient({ account, transport: http(deployment.rpcUrl) });
        const venue = createBaseVenue({
          chain: deployment.chain,
          publicClient,
          walletClient,
          safeAddress: deployment.safe,
          stateDbPath: deployment.stateDbPath,
          priorityMech: deployment.mech,
          pin: async () => {},
          verifySettlementGrade: async () => {
            throw new Error("not exercised by verdict anvil test");
          },
          isAuthorizedMechOrigin: (address) => address.toLowerCase() === deployment.mech.toLowerCase(),
          observations: async () => [],
        });
        try {
          const taskId = await postFixtureTask(deployment);
          const claim = await venue.claim.claimTask({ taskId, priorityMech: deployment.mech });
          const deliveryBytes = await deliverSolutionFixture(deployment, claim.requestId!);
          const solutionDigest = keccakEvidenceHash(deliveryBytes) as Hex;
          await venue.settlement.claimSolutionDelivery({ requestId: claim.requestId!, solutionDigest });

          const evalDigest = randomDigest();
          const canOpen = await venue.verdict.canOpenVerdictAttempt({ taskId, attemptIndex: claim.attemptIndex });
          expect(canOpen.ok).toBe(true);

          const opened = await venue.verdict.openVerdictAttempt({
            taskId,
            attemptIndex: claim.attemptIndex,
            evaluationTaskCidDigest: evalDigest,
          });
          expect(opened.requestId).toMatch(/^0x[0-9a-f]{64}$/u);
          expect(opened.verdictIndex).toBe(0);

          const verdictDigest = randomDigest();
          await venue.verdict.deliverVerdictToMarketplace({
            requestId: opened.requestId,
            deliveryDigest: verdictDigest,
          });

          const settled = await venue.verdict.claimVerdictDelivery({
            requestId: opened.requestId,
            verdictDigest,
            verdictCode: VerdictCode.Fail,
          });
          expect(settled.status).toBe("settled");

          const claimed = await publicClient.readContract({
            address: deployment.chain.jinnRouter,
            abi: CLAIMED_ABI,
            functionName: "claimed",
            args: [opened.requestId],
          });
          expect(claimed).toBe(true);

          const replay = await venue.verdict.claimVerdictDelivery({
            requestId: opened.requestId,
            verdictDigest,
            verdictCode: VerdictCode.Fail,
          });
          expect(replay.status).toBe("already-settled");
        } finally {
          venue.close();
        }
      },
    });
  }, 180_000);

  test("canOpenVerdictAttempt surfaces decoded revert names for legacy failure fixtures", async () => {
    await withForkVenue({
      generation: "today",
      async run(deployment) {
        const account = privateKeyToAccount(DEV_KEY);
        const publicClient = createPublicClient({ transport: http(deployment.rpcUrl) });
        const walletClient = createWalletClient({ account, transport: http(deployment.rpcUrl) });
        const venue = createBaseVenue({
          chain: deployment.chain,
          publicClient,
          walletClient,
          safeAddress: deployment.safe,
          stateDbPath: deployment.stateDbPath,
          priorityMech: deployment.mech,
          pin: async () => {},
          verifySettlementGrade: async () => {
            throw new Error("not exercised by verdict anvil test");
          },
          isAuthorizedMechOrigin: () => true,
          observations: async () => [],
        });
        try {
          const missingTask = await venue.verdict.canOpenVerdictAttempt({ taskId: 999_999n, attemptIndex: 0 });
          expect(missingTask.ok).toBe(false);
          if (!missingTask.ok) {
            expect(missingTask.revertName).toMatch(/RouterTaskNotFound|TCAttemptNotFound/u);
          }

          const taskId = await postFixtureTask(deployment);
          const notDelivered = await venue.verdict.canOpenVerdictAttempt({ taskId, attemptIndex: 0 });
          expect(notDelivered.ok).toBe(false);
          if (!notDelivered.ok) {
            expect(notDelivered.reason.length).toBeGreaterThan(0);
          }
        } finally {
          venue.close();
        }
      },
    });
  }, 120_000);
});
