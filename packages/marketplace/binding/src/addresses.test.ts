import { describe, expect, test } from "vitest";
import { BASE_SEPOLIA_TODAY } from "./addresses.js";

// Preflight-confirmed today-mode substrate facts (plan Preflight; matches
// contracts/deployment-task-coordinator-router-v3-baseSepolia.json).
describe("BASE_SEPOLIA_TODAY", () => {
  test("carries the deployed today-mode addresses, chain id, and generation tag", () => {
    expect(BASE_SEPOLIA_TODAY).toEqual({
      chainId: 84532,
      taskCoordinator: "0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98",
      jinnRouter: "0x6f47863Ac4120A5a97Af224a5e30C3Ec2c9eA247",
      mechMarketplace: "0xD3233FdAaB51E9775f6bFCE8242B02C181D7c0e7",
      activityChecker: "0x0e1B5f264F4FAdcFAA950fb00c58d9A39C040f70",
      generation: "today",
    });
  });
});
