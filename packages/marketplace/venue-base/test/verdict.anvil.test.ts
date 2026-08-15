// SPDX-License-Identifier: MIT

import { randomBytes } from "node:crypto";
import {
  JINN_ROUTER_V3_ABI,
  MECH_DELIVER_TO_MARKETPLACE_ABI,
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
import { anvilAvailable, withForkVenue, type ForkVenueDeployment } from "../../testing/src/venue-fork.js";

const DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const hasAnvil = await anvilAvailable();

function randomDigest(): Hex {
  return `0x${randomBytes(32).toString("hex")}` as Hex;
}

async function postFixtureTask(deployment: ForkVenueDeployment): Promise<bigint> {
  const account = privateKeyToAccount(DEV_KEY);
  const publicClient = createPublicClient({ transport: http(deployment.rpcUrl) });
  const wallet = createWalletClient({ account, transport: http(deployment.rpcUrl) });
  const rate = parseEther("0.0001");
  const hash = await wallet.writeContract({
    address: deployment.chain.jinnRouter,
    abi: JINN_ROUTER_V3_ABI,
    functionName: "createTask",
    args: [randomDigest(), randomDigest(), { maxClaims: 2, allowSolverSelfEvaluation: true }, rate, rate, 60n],
    value: rate * 2n * 2n,
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
      abi: MECH_DELIVER_TO_MARKETPLACE_ABI,
      functionName: "deliverToMarketplace",
      args: [[requestId], [toHex(deliveryBytes)]],
    }),
  });
  return deliveryBytes;
}

describe.runIf(hasAnvil)("verdict ports against a forked chain", () => {
  test("opens, delivers, settles, and canonically reconciles a verdict", async () => {
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
          verifySettlementGrade: async () => { throw new Error("not exercised by verdict anvil test"); },
          isAuthorizedMechOrigin: (address) => address.toLowerCase() === deployment.mech.toLowerCase(),
          observations: async () => [],
        });
        try {
          const verdict = venue.verdict;
          if (verdict === undefined) throw new Error("today venue unexpectedly has no V3 verdict ports");
          const taskId = await postFixtureTask(deployment);
          const claim = await venue.claim.claimTask({ taskId, priorityMech: deployment.mech });
          const solutionBytes = await deliverSolutionFixture(deployment, claim.requestId!);
          await venue.settlement.claimSolutionDelivery({
            requestId: claim.requestId!,
            solutionDigest: keccakEvidenceHash(solutionBytes) as Hex,
          });

          const opened = await verdict.openVerdictAttempt({
            operationId: "anvil:open",
            taskId,
            attemptIndex: claim.attemptIndex,
            evaluationTaskCidDigest: randomDigest(),
          });
          const verdictDeliveryDigest = randomDigest();
          const delivered = await verdict.deliverVerdictToMarketplace({
            operationId: "anvil:deliver",
            requestId: opened.requestId,
            deliveryDigest: verdictDeliveryDigest,
          });
          const settled = await verdict.claimVerdictDelivery({
            operationId: "anvil:settle",
            requestId: opened.requestId,
            verdictDigest: verdictDeliveryDigest,
            verdictCode: VerdictCode.Fail,
          });

          expect(settled.status).toBe("settled");
          if (settled.status === "rejected") throw new Error("verdict settlement was unexpectedly rejected");
          await expect(verdict.readVerdictSettlement({
            requestId: opened.requestId,
            fromBlock: opened.transaction.blockNumber,
          }))
            .resolves.toMatchObject({
              requestId: opened.requestId,
              transaction: settled.transaction,
            });
          expect(delivered.transaction.blockNumber).toBeGreaterThanOrEqual(opened.transaction.blockNumber);
          await expect(verdict.readCanonicalVerdictAttempt({
            taskId,
            attemptIndex: claim.attemptIndex,
            fromBlock: opened.transaction.blockNumber,
          }))
            .resolves.toMatchObject({ requestId: opened.requestId, verdictIndex: 0 });
        } finally {
          venue.close();
        }
      },
    });
  }, 180_000);
});
