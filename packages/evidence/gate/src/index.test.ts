import { describe, expect, test } from "vitest";

import * as root from "./index.js";

describe("the public entrypoint", () => {
  test("exports the record kind, the rail interface, the ports, and the gate", () => {
    for (const named of [
      "DELIVERY_STATEMENT_RECORD_KIND",
      "GATE_REFUSAL_CODES",
      "GateConfigurationError",
      "RAIL_SETTLEMENTS",
      "RAIL_TRUST_MODELS",
      "assertConformingRailAdapter",
      "createInMemoryChallengeStore",
      "createInMemoryOfferSource",
      "createInMemorySubjectSource",
      "createRepositorySubjectSource",
      "createRetrievalGate",
      "parseDeliveryStatementEnvelope",
      "sealDeliveryStatement",
      "systemClock",
    ]) {
      expect(named in root, `${named} must be exported`).toBe(true);
    }
  });

  test("never re-exports the testing region, which would put vitest in a production tree", () => {
    for (const testOnly of [
      "createFixtureSigner",
      "createTestRailAdapter",
      "describeRailAdapterConformance",
      "sealTestOffer",
      "signTestPayerProof",
    ]) {
      expect(testOnly in root, `${testOnly} must not be exported from the root`).toBe(false);
    }
  });
});
