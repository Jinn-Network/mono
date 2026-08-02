// CE1 accepts generic record-kind URIs and intentionally does not import CE6. This test-only
// integration pin proves CE1 accepts a complete composite that refers to CE6 by this package's
// public kind constant, preventing a compatible-looking but unusable CE6 kind from shipping.
import { describe, expect, test } from "vitest";
import {
  CHAIN_ENVIRONMENT_KIND,
  CRYPTO_ENVIRONMENT_KIND,
  CryptoEnvironmentRecordSchema,
} from "@jinn-network/chain-environment-record";

import { INFORMATION_WORLD_KIND } from "./identifiers.js";

describe("composite kind compatibility", () => {
  test("CE1 parses a composite that references this information-world kind", () => {
    const parsed = CryptoEnvironmentRecordSchema.safeParse({
      kind: CRYPTO_ENVIRONMENT_KIND,
      chainWorld: {
        kind: CHAIN_ENVIRONMENT_KIND,
        record: { name: "chain", digest: { sha256: "1".repeat(64) } },
      },
      informationWorlds: [
        {
          id: "information",
          kind: INFORMATION_WORLD_KIND,
          record: { name: "information", digest: { sha256: "2".repeat(64) } },
        },
      ],
      serviceRuntimes: [],
      composition: {
        originRouting: [
          {
            origin: "https://information.example.test",
            worldId: "information",
            precedence: 0,
          },
        ],
        missPolicy: { mode: "declared-response", status: 404 },
        endpointAllowlist: ["https://information.example.test"],
        requestBudget: { maxRequests: 1, maxResponseBytes: 1 },
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.composition.originRouting).toEqual([
      {
        origin: "https://information.example.test",
        worldId: "information",
        precedence: 0,
      },
    ]);
    expect(parsed.data.composition.endpointAllowlist).toEqual([
      "https://information.example.test",
    ]);
  });
});
