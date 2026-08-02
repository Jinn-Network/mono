// SPDX-License-Identifier: MIT

import { randomBytes } from "node:crypto";
import {
  JINN_ROUTER_V3_ABI,
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
const MOCK_MECH_DELIVER_ABI = [{
  type: "function",
  name: "deliverToMarketplace",
  stateMutability: "nonpayable",
  inputs: [
    { name: "requestIds", type: "bytes32[]" },
    { name: "datas", type: "bytes[]" },
  ],
  outputs: [{ name: "deliveredRequests", type: "bool[]" }],
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
      abi: MOCK_MECH_DELIVER_ABI,
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
          const taskId = await postFixtureTask(deployment);
          const claim = await venue.claim.claimTask({ taskId, priorityMech: deployment.mech });
          const solutionBytes = await deliverSolutionFixture(deployment, claim.requestId!);
          await venue.settlement.claimSolutionDelivery({
            requestId: claim.requestId!,
            solutionDigest: keccakEvidenceHash(solutionBytes) as Hex,
          });

          const opened = await venue.verdict.openVerdictAttempt({
            operationId: "anvil:open",
            taskId,
            attemptIndex: claim.attemptIndex,
            evaluationTaskCidDigest: randomDigest(),
          });
          await venue.verdict.deliverVerdictToMarketplace({
            operationId: "anvil:deliver",
            requestId: opened.requestId,
            deliveryDigest: randomDigest(),
          });
          const settled = await venue.verdict.claimVerdictDelivery({
            operationId: "anvil:settle",
            requestId: opened.requestId,
            verdictDigest: randomDigest(),
            verdictCode: VerdictCode.Fail,
          });

          expect(settled.status).toBe("settled");
          expect(await venue.verdict.readVerdictSettlement({ requestId: opened.requestId }))
            .toEqual({ settled: true });
          await expect(venue.verdict.readCanonicalVerdictAttempt({ taskId, attemptIndex: claim.attemptIndex }))
            .resolves.toMatchObject({ requestId: opened.requestId, verdictIndex: 0 });
        } finally {
          venue.close();
        }
      },
    });
  }, 180_000);
});
