// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import {
  defineEvaluatorRegistration,
  validateEvaluatorRegistrationSet,
  type EvaluatorRegistration,
  type InterruptionBehavior,
} from "./registration.js";

const method = {
  name: "deterministic evaluator method",
  digest: {
    sha256: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  },
  uri: "https://spec.jinn.network/software/evaluation-harness/deterministic-v1",
};

function registration(
  interruptionBehavior: InterruptionBehavior,
): EvaluatorRegistration {
  return defineEvaluatorRegistration({
    registrationId: `deterministic-${interruptionBehavior}`,
    adapter: {
      async evaluate() {
        return {
          detailedOutcome: {},
          verdict: "inconclusive",
          evaluatedAt: "2026-07-29T10:00:00.000Z",
          limitations: ["control fixture"],
        };
      },
    },
    evaluationMethod: method,
    specificationCompatibility: (specification) =>
      specification.family === "deterministic-process",
    evaluatorIdentity: {
      id: "did:key:z6MkhzYwRj8TvZEp41ApnVVDN5a5hBCk8tQYp4w7vGkVn5F8",
    },
    signer: { handle: "evaluator-agent-key" },
    outcomeValidator: (value) => value,
    interruptionBehavior,
  });
}

describe("EvaluatorRegistration", () => {
  test.each([
    "repeatable",
    "recoverable",
    "nonrepeatable",
  ] satisfies readonly InterruptionBehavior[])(
    "declares %s interruption behavior",
    (behavior) => {
      const value = registration(behavior);
      expect(value.interruptionBehavior).toBe(behavior);
      expect(value.evaluationMethod).toEqual(method);
      expect(value.signer).toEqual({ handle: "evaluator-agent-key" });
      expect(Object.isFrozen(value)).toBe(true);
    },
  );

  test("rejects a registration without a stable id", () => {
    expect(() => defineEvaluatorRegistration({
      ...registration("repeatable"),
      registrationId: " ",
    })).toThrow("registrationId must be non-empty");
  });

  test("rejects a signer path rather than treating it as a secret handle", () => {
    expect(() => defineEvaluatorRegistration({
      ...registration("repeatable"),
      signer: { handle: "../evaluator-agent-key.pem" },
    })).toThrow("portable logical handle");
  });

  test("rejects an invalid recovery behavior before a Task can select it", () => {
    expect(() => defineEvaluatorRegistration({
      ...registration("repeatable"),
      interruptionBehavior: "invented" as InterruptionBehavior,
    })).toThrow("interruptionBehavior is invalid");
  });

  test("does not permit an adapter to own fixed authority fields", () => {
    const value = registration("repeatable");
    expect(Object.keys(value.adapter)).toEqual(["evaluate"]);
    expect(value.evaluationMethod).toBe(method);
    expect(value.evaluatorIdentity.id).toBe(
      "did:key:z6MkhzYwRj8TvZEp41ApnVVDN5a5hBCk8tQYp4w7vGkVn5F8",
    );
    expect(value.signer.handle).toBe("evaluator-agent-key");
  });

  test("rejects duplicate deployment registrations before any Attempt can select one", () => {
    const value = registration("repeatable");
    expect(() => validateEvaluatorRegistrationSet([value, value])).toThrow("unique");
  });
});
