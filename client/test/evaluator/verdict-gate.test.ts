import { describe, expect, it, vi } from "vitest";

const bindingGate = vi.hoisted(() => vi.fn());

vi.mock("@jinn-network/marketplace-binding", async (importOriginal) => ({
  ...await importOriginal<typeof import("@jinn-network/marketplace-binding")>(),
  gateVerdictObservation: bindingGate,
}));

import type { VerdictObservationGateInput, VerdictObservationGatePorts } from "@jinn-network/marketplace-binding";
import { createVerdictGate } from "../../src/evaluator/verdict-gate.js";

describe("createVerdictGate", () => {
  it("delegates the complete immutable input and trusted ports to the binding gate", async () => {
    const ports = {
      bindingResolver: {},
      witnessVerifier: {},
      dsseVerifier: {},
      admissionAgentPolicy: { accepted: [], requiredStrength: "weak" },
    } as unknown as VerdictObservationGatePorts;
    const input = { settlement: {} } as VerdictObservationGateInput;
    const expected = { decisionGrade: false, failures: [{ check: "fixture", detail: "fixture" }] };
    bindingGate.mockResolvedValue(expected);

    await expect(createVerdictGate(ports).gate(input)).resolves.toEqual(expected);
    expect(bindingGate).toHaveBeenCalledWith(input, ports);
  });
});
