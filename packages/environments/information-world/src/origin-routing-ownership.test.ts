// CE1 owns composition-record validation and CE3 owns origin-collision assessment. This
// test-only contract protects that ownership boundary without creating a second resolver here.
import { describe, expect, test } from "vitest";
import {
  CHAIN_ENVIRONMENT_KIND,
  CRYPTO_ENVIRONMENT_KIND,
  CryptoEnvironmentRecordSchema,
} from "@jinn-network/chain-environment-record";
import { assessOriginRouting } from "@jinn-network/chain-environment-verification";

import { INFORMATION_WORLD_KIND } from "./identifiers.js";

const CE6_ORIGIN = "https://information.example.test";

describe("origin routing ownership", () => {
  test("CE1 accepts a declared route to a CE6 kind world", () => {
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
        originRouting: [{ origin: CE6_ORIGIN, worldId: "information", precedence: 0 }],
        missPolicy: { mode: "declared-response", status: 404 },
        endpointAllowlist: [CE6_ORIGIN],
        requestBudget: { maxRequests: 1, maxResponseBytes: 1 },
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.composition.originRouting).toEqual([
      { origin: CE6_ORIGIN, worldId: "information", precedence: 0 },
    ]);
  });

  test("CE3 treats distinct precedence as an explicit, non-colliding route", () => {
    expect(assessOriginRouting([
      { origin: CE6_ORIGIN, world: "world-a", precedence: 0 },
      { origin: CE6_ORIGIN, world: "world-b", precedence: 1 },
    ])).toEqual([]);
  });

  test("CE3 reports every same-precedence claimant in code-unit order", () => {
    expect(assessOriginRouting([
      { origin: CE6_ORIGIN, world: "world-b", precedence: 0 },
      { origin: CE6_ORIGIN, world: "world-a", precedence: 0 },
    ])).toEqual([{
      origin: CE6_ORIGIN,
      worlds: ["world-a", "world-b"],
    }]);
  });
});
