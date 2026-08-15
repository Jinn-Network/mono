// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { createPublicClient, http } from "viem";
import { resolve } from "node:path";
import { resolveAnvilStatePath, startSnapshotAnvil } from "./anvil-state.js";
import { anvilAvailable, withForkVenue } from "./venue-fork.js";

const hasAnvil = await anvilAvailable();

test("Anvil state resolution has a committed default and accepts a local path only", () => {
  expect(resolveAnvilStatePath("   ")).toMatch(
    /client\/test\/_support\/fixtures\/anvil-base-v3-state\/state\.json$/u,
  );
  expect(resolveAnvilStatePath("fixtures/state.json")).toBe(resolve("fixtures/state.json"));
});

test("a missing committed state fails loudly without starting Anvil", async () => {
  await expect(
    startSnapshotAnvil({ statePath: resolve("fixtures/missing-state.json") }),
  ).rejects.toThrow(/committed Anvil state is unavailable/u);
});

describe.runIf(hasAnvil)("snapshot-backed Anvil venue backbone (design §6.6)", () => {
  test("deploys a today-generation venue and hands back a usable chain config", async () => {
    await withForkVenue({
      generation: "today",
      async run(deployment) {
        expect(deployment.chain.generation).toBe("today");
        expect(deployment.chain.jinnRouter).toMatch(/^0x[0-9a-fA-F]{40}$/u);
        expect(deployment.chain.taskCoordinator).toMatch(/^0x[0-9a-fA-F]{40}$/u);
        expect(deployment.stateDbPath.endsWith(".db")).toBe(true);
        const client = createPublicClient({ transport: http(deployment.rpcUrl) });
        const code = await client.getCode({ address: deployment.chain.jinnRouter });
        expect(code).not.toBe("0x");
      },
    });
  }, 90_000);

  test("tears Anvil down: the RPC port is closed after the run resolves", async () => {
    let url = "";
    await withForkVenue({
      generation: "today",
      async run(deployment) {
        url = deployment.rpcUrl;
      },
    });
    const client = createPublicClient({ transport: http(url) });
    await expect(client.getBlockNumber()).rejects.toThrow();
  }, 90_000);
});
