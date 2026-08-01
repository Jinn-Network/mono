// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { createPublicClient, http } from "viem";
import { anvilAvailable, withForkVenue } from "./venue-fork.js";

const hasAnvil = await anvilAvailable();

describe.runIf(hasAnvil)("Anvil-fork venue backbone (design §6.6)", () => {
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

  test("tears the fork down: the RPC port is closed after the run resolves", async () => {
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
