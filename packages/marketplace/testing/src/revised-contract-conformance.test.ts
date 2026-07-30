import { describe, expect, test } from "vitest";
import { keccak256, toBytes } from "viem";
import {
  REVISED_DOMAIN_HASH,
  REVISED_LEG_SOLUTION,
  REVISED_LEG_VERDICT,
  REVISED_REQUEST_DATA_VERSION,
  REVISED_SOLUTION_VERDICT_SENTINEL,
  assertRevisedRequestDataShape,
  decodeRevisedRequestData,
  encodeRevisedSolutionRequestData,
  encodeRevisedVerdictRequestData,
  runRevisedContractConformance,
  type RevisedContractConformancePort,
} from "./revised-contract-conformance.js";

describe("revised-contract-conformance surface", () => {
  test("encodes and decodes v2 requestData with verdictCode binding", () => {
    const digest = keccak256(toBytes("d"));
    const solution = encodeRevisedSolutionRequestData({
      taskId: 7n,
      attemptIndex: 3,
      deliveryDigest: digest,
    });
    const decodedSol = decodeRevisedRequestData(solution);
    expect(decodedSol.domain).toBe(REVISED_DOMAIN_HASH);
    expect(decodedSol.version).toBe(REVISED_REQUEST_DATA_VERSION);
    expect(decodedSol.legKind).toBe(REVISED_LEG_SOLUTION);
    expect(decodedSol.verdictCode).toBe(0);

    const verdict = encodeRevisedVerdictRequestData({
      taskId: 7n,
      attemptIndex: 3,
      verdictIndex: 1,
      deliveryDigest: digest,
      verdictCode: 2,
    });
    const decodedV = decodeRevisedRequestData(verdict);
    expect(decodedV.legKind).toBe(REVISED_LEG_VERDICT);
    expect(decodedV.verdictCode).toBe(2);
    expect(decodedV.verdictIndex).toBe(1);
  });

  test("rejects invalid requestData shapes", () => {
    expect(() =>
      assertRevisedRequestDataShape({
        domain: REVISED_DOMAIN_HASH,
        version: REVISED_REQUEST_DATA_VERSION,
        legKind: REVISED_LEG_SOLUTION,
        taskId: 1n,
        attemptIndex: 0,
        verdictIndex: 1,
        deliveryDigest: `0x${"22".repeat(32)}`,
        verdictCode: 0,
      }),
    ).toThrow(/sentinel/);

    expect(() =>
      assertRevisedRequestDataShape({
        domain: REVISED_DOMAIN_HASH,
        version: REVISED_REQUEST_DATA_VERSION,
        legKind: REVISED_LEG_SOLUTION,
        taskId: 1n,
        attemptIndex: 0,
        verdictIndex: REVISED_SOLUTION_VERDICT_SENTINEL,
        deliveryDigest: `0x${"22".repeat(32)}`,
        verdictCode: 0,
      }),
    ).not.toThrow();

    expect(() =>
      encodeRevisedVerdictRequestData({
        taskId: 1n,
        attemptIndex: 0,
        verdictIndex: 0,
        deliveryDigest: `0x${"22".repeat(32)}`,
        verdictCode: 0,
      }),
    ).toThrow(/verdictCode/);
  });

  test("runRevisedContractConformance drives every required proof via the port", async () => {
    const digest = keccak256(toBytes("conformance-digest"));
    const port: RevisedContractConformancePort = {
      async roundTripRequestData(input) {
        if (input.leg === "solution") {
          return decodeRevisedRequestData(
            encodeRevisedSolutionRequestData({
              taskId: input.taskId,
              attemptIndex: input.attemptIndex,
              deliveryDigest: input.deliveryDigest,
            }),
          );
        }
        return decodeRevisedRequestData(
          encodeRevisedVerdictRequestData({
            taskId: input.taskId,
            attemptIndex: input.attemptIndex,
            verdictIndex: input.verdictIndex,
            deliveryDigest: input.deliveryDigest,
            verdictCode: input.verdictCode,
          }),
        );
      },
      async claimWithoutRequestIdArg() {
        return { solutionArity: 5, verdictArity: 5 };
      },
      async preparationAndEip1271() {
        return { prepared: true, unpreparedRejected: true, preparedDelivered: true };
      },
      async conservationAttackRefusal() {
        return {
          taskAReservedStuck: true,
          taskBFullyRefunded: true,
          undeliveredPrepareReleases: true,
        };
      },
      async atomicRollback() {
        return { rolledBack: true, happyPathOk: true };
      },
      async verdictCodeBinding() {
        return { preparedCode: 3, claimedCode: 3, tamperRejected: true };
      },
      async forfeitOccupancyClearance() {
        return {
          occupancyCleared: true,
          operatorCapCleared: true,
          noActivityCredit: true,
          spentOutPreserved: true,
          replacementProceeds: true,
        };
      },
    };

    const report = await runRevisedContractConformance(port);
    expect(report.requestDataRoundTrip).toBe(true);
    expect(report.verdictCodeBinding).toBe(true);
    expect(report.forfeitOccupancyClearance).toBe(true);
    expect(digest.startsWith("0x")).toBe(true);
  });
});
