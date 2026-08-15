// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { admitChainCandidate } from "./chain-admit.js";
import { verifyChainAdmissionReceiptV1 } from "./chain-receipt.js";
import {
  describeChainAdmissionConformance,
  goldenChainCandidate,
  goldenChainReceipt,
  scriptedChainPort,
} from "./chain-testing.js";

describeChainAdmissionConformance("in-package", {
  admitChainCandidate,
  goldenChainCandidate,
  goldenChainReceipt,
  scriptedChainPort,
  verifyChainReceipt: verifyChainAdmissionReceiptV1,
});

describe("admitChainCandidate", () => {
  it("runs do-nothing then reference, two repeats each", async () => {
    const requests: Array<{ script: { kind: string } }> = [];
    const port = async (request: { script: { kind: string } }) => {
      requests.push(request);
      return scriptedChainPort()(request as never);
    };
    const result = await admitChainCandidate(
      { issuer: "https://spec.jinn.network/agents/a", observeChain: port },
      goldenChainCandidate(),
      goldenChainReceipt().environment.compositeRecordDigest as `sha256:${string}`,
    );
    expect("receipt" in result).toBe(true);
    expect(requests.map((request) => request.script.kind)).toStrictEqual([
      "do-nothing", "do-nothing", "reference", "reference",
    ]);
  });
});
