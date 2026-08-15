// SPDX-License-Identifier: Apache-2.0
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, test, vi } from "vitest";

import type { CapabilityContext } from "../capability.js";
import type { RankedCandidate } from "../relevance/search.js";
import type { IndexStats } from "../relevance/index.js";
import { createMcpCapability } from "./capability.js";
import { TOOL_NAMES } from "./identifiers.js";

/** A started capability whose index reports exactly these stats. */
async function started(stats: IndexStats) {
  const [, serverTransport] = InMemoryTransport.createLinkedPair();
  const capability = createMcpCapability({
    role: "tools",
    version: "0.1.0",
    transport: serverTransport,
    resolve: () =>
      ({
        index: { databasePath: ":memory:", search: async () => [], stats: () => stats, close: () => {} },
        retrieval: { fetchRecord: async () => ({ status: "failed", failure: { code: "NO_LOCATION", stage: "location" } }) },
        classifier: { classify: async () => ({ excluded: false }) },
        admission: { admit: async (c: readonly RankedCandidate[]) => c },
        health: async () => ({ ok: true, version: "0.1.0", checks: [] }),
      }) as never,
  });
  await capability.start?.(context());
  return capability;
}

function context(overrides: Partial<CapabilityContext> = {}): CapabilityContext {
  return {
    config: { homeDirectory: "/tmp/jinn-home", indexPath: "/tmp/jinn-home/index.sqlite" },
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    ...overrides,
  } as unknown as CapabilityContext;
}

describe("mcp capability", () => {
  test("is named so the composition root can find it", () => {
    const capability = createMcpCapability({ role: "tools", version: "0.1.0", resolve: () => ({}) as never });
    expect(capability.name).toBe("mcp");
  });

  test("start binds the transport and does not open the archive", async () => {
    const openArchive = vi.fn();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const capability = createMcpCapability({
      role: "tools",
      version: "0.1.0",
      transport: serverTransport,
      resolve: () =>
        ({
          index: { databasePath: ":memory:", search: async () => [], close: () => {} },
          retrieval: { fetchRecord: async () => ({ status: "failed", failure: { code: "NO_LOCATION", stage: "location" } }) },
          classifier: { classify: async () => ({ excluded: false }) },
          admission: { admit: async (c: readonly RankedCandidate[]) => c },
          health: async () => ({ ok: true, version: "0.1.0", checks: [] }),
          openArchive,
        }) as never,
    });
    await capability.start?.(context());
    const client = new Client({ name: "t", version: "0" });
    await client.connect(clientTransport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(TOOL_NAMES.corpusSearch);
    expect(openArchive).not.toHaveBeenCalled();
    await capability.stop?.();
  });

  test("stop closes the server and is idempotent", async () => {
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const capability = createMcpCapability({
      role: "tools",
      version: "0.1.0",
      transport: serverTransport,
      resolve: () =>
        ({
          index: { databasePath: ":memory:", search: async () => [], close: () => {} },
          retrieval: { fetchRecord: async () => ({ status: "failed", failure: { code: "NO_LOCATION", stage: "location" } }) },
          classifier: { classify: async () => ({ excluded: false }) },
          admission: { admit: async (c: readonly RankedCandidate[]) => c },
          health: async () => ({ ok: true, version: "0.1.0", checks: [] }),
        }) as never,
    });
    await capability.start?.(context());
    await capability.stop?.();
    await expect(capability.stop?.()).resolves.toBeUndefined();
  });

  test("contributes no checks before start, when it holds no index handle", async () => {
    const capability = createMcpCapability({ role: "tools", version: "0.1.0", resolve: () => ({}) as never });
    expect(await capability.healthChecks?.()).toEqual([]);
  });

  test("a populated index is green and reports its counts", async () => {
    const capability = await started({
      local: 12, public: 40, lastIndexedAt: "2026-07-30T10:00:00Z", excludedByTrust: 0,
    });
    const [check] = (await capability.healthChecks?.()) ?? [];
    expect(check).toMatchObject({ name: "corpus-index", ok: true, remedy: null });
    expect(check!.detail).toContain("12 local, 40 public");
  });

  test("a fresh install is green, not a red row with a no-op remedy", async () => {
    const capability = await started({ local: 0, public: 0, excludedByTrust: 0 });
    const [check] = (await capability.healthChecks?.()) ?? [];
    expect(check).toMatchObject({ name: "corpus-index", ok: true, remedy: null });
    expect(check!.detail).toContain("nothing indexed yet");
  });

  test("an index emptied after being written is red with a remedy that works", async () => {
    const capability = await started({
      local: 0, public: 0, lastIndexedAt: "2026-07-29T09:00:00Z", excludedByTrust: 0,
    });
    const [check] = (await capability.healthChecks?.()) ?? [];
    expect(check!.ok).toBe(false);
    expect(check!.remedy).toContain("reindex");
    // Red says the index is empty; it does not diagnose a cause it cannot know.
    // A privacy-preserving eviction reaches this arm too, and nothing is broken.
    expect(check!.detail).toContain("is now empty");
  });

  test("a trust-filtered empty index defers instead of proposing a rebuild", async () => {
    const capability = await started({
      local: 0, public: 0, lastIndexedAt: "2026-07-29T09:00:00Z", excludedByTrust: 7,
    });
    const [check] = (await capability.healthChecks?.()) ?? [];
    expect(check!.ok).toBe(true);
    expect(check!.remedy).toBeNull();
    expect(check!.detail).toContain("excluded by trust policy");
    expect(check!.detail).toContain("corpus-trust-policy");
  });

  test("the trust arm never proposes a remedy that cannot remedy", async () => {
    const capability = await started({
      local: 0, public: 0, lastIndexedAt: "2026-07-29T09:00:00Z", excludedByTrust: 1,
    });
    const [check] = (await capability.healthChecks?.()) ?? [];
    expect(check!.detail).not.toContain("reindex");
  });

  test("green never claims the indexed records are currently trusted", async () => {
    // A policy that expires without a rebuild leaves this row green while the
    // index still serves records the policy would no longer admit. That is the
    // intended behaviour - the mirror is a cache, and corpus-trust-policy is
    // independently red - but the row must not word itself as a currency claim.
    const capability = await started({
      local: 12, public: 40, lastIndexedAt: "2026-07-30T10:00:00Z", excludedByTrust: 0,
    });
    const [check] = (await capability.healthChecks?.()) ?? [];
    expect(check!.ok).toBe(true);
    expect(check!.detail).not.toContain("trusted");
    expect(check!.detail).not.toContain("verified");
  });

  test("the counts reach the detail on green as well as red", async () => {
    const capability = await started({
      local: 3, public: 0, lastIndexedAt: "2026-07-30T10:00:00Z", excludedByTrust: 0,
    });
    const [check] = (await capability.healthChecks?.()) ?? [];
    expect(check!.ok).toBe(true);
    expect(check!.detail).toContain("3 local, 0 public");
  });
});
