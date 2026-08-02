import { computeRawCodecCid } from "@jinn-network/marketplace-binding";
import { describe, expect, it } from "vitest";
import { mapFinalizedSolutionDeliveryObservation } from "../../src/evaluator/opportunities.js";

const identity = {
  safeAddress: "0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa",
  agentEoa: "0xBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbb",
  agentIri: "https://agents.example/jinn/operator-1",
};
const deliveryBytes = new TextEncoder().encode("solution delivery fixture");
const advertisedDelivery = computeRawCodecCid(deliveryBytes);

function finalizedSolutionClaimed(operator: string) {
  return {
    source: "https://operator.example/.well-known/jinn-source",
    canonical: true,
    event: {
      event: "SolutionDeliveryClaimed",
      facts: {
        taskId: 7n,
        attemptIndex: 1,
        requestId: `0x${"cd".repeat(32)}`,
        operator,
      },
      derivation: {
        chainId: 84532,
        blockHash: `0x${"ee".repeat(32)}`,
        txHash: `0x${"ef".repeat(32)}`,
        logIndex: 4,
        finalityTier: "finalized",
      },
      projection: {
        deliveryCorrespondence: { sha256Digest: advertisedDelivery.sha256Digest },
      },
    },
  } as never;
}

describe("mapFinalizedSolutionDeliveryObservation", () => {
  it("creates a reconciliation-safe opportunity with source, canonical, finality, and advertised Delivery identities", () => {
    const result = mapFinalizedSolutionDeliveryObservation(finalizedSolutionClaimed(
      "0xCCccCCccCCccCCccCCccCCccCCccCCccCCccCCcc",
    ), identity);

    expect(result).toEqual({
      kind: "opportunity",
      opportunity: expect.objectContaining({
        source: "https://operator.example/.well-known/jinn-source",
        canonical: true,
        finality: "finalized",
        taskId: 7n,
        attemptIndex: 1,
        deliveryCid: advertisedDelivery.cid,
        advertisedDeliveryDigest: advertisedDelivery.sha256Digest,
        blockHash: `0x${"ee".repeat(32)}`,
        transactionHash: `0x${"ef".repeat(32)}`,
        logIndex: 4,
      }),
    });
  });

  it("refuses the operator's own solution before any material resolution", () => {
    expect(mapFinalizedSolutionDeliveryObservation(finalizedSolutionClaimed(identity.safeAddress), identity))
      .toEqual({ kind: "skipped", reason: "own-solution-safe", taskId: 7n, attemptIndex: 1 });
  });

  it("does not produce an opportunity before finality", () => {
    const event = finalizedSolutionClaimed("0xCCccCCccCCccCCccCCccCCccCCccCCccCCccCCcc") as {
      event: { derivation: { finalityTier: string } };
    };
    event.event.derivation.finalityTier = "safe";

    expect(mapFinalizedSolutionDeliveryObservation(event as never, identity))
      .toEqual({ kind: "ignored", reason: "not-finalized" });
  });
});
