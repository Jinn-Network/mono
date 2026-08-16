import { describe, expect, it } from "vitest";
import { selfEvaluationSkip } from "../../src/evaluator/self-evaluation.js";

const identity = {
  safeAddress: "0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa",
  agentEoa: "0xBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbb",
  agentIri: "https://agents.example/jinn/operator-1",
};

describe("selfEvaluationSkip", () => {
  it("refuses a solution delivered by the operator's own Safe, case-insensitively", () => {
    expect(selfEvaluationSkip(identity, { operatorAddress: identity.safeAddress.toLowerCase() }))
      .toBe("own-solution-safe");
  });

  it("refuses a solution delivered by the operator's own agent EOA", () => {
    expect(selfEvaluationSkip(identity, { operatorAddress: identity.agentEoa.toUpperCase() }))
      .toBe("own-solution-eoa");
  });

  it("refuses a solution whose executor resolves to the operator's own Agent IRI", () => {
    expect(selfEvaluationSkip(identity, {
      operatorAddress: "0xCCccCCccCCccCCccCCccCCccCCccCCccCCccCCcc",
      executorAgentIri: identity.agentIri,
    })).toBe("own-solution-agent-iri");
  });

  it("does not refuse another operator's solution", () => {
    expect(selfEvaluationSkip(identity, {
      operatorAddress: "0xCCccCCccCCccCCccCCccCCccCCccCCccCCccCCcc",
      executorAgentIri: "https://agents.example/jinn/operator-2",
    })).toBeUndefined();
  });
});
