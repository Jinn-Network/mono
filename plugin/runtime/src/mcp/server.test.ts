// SPDX-License-Identifier: Apache-2.0
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, test } from "vitest";

import type { CaptureCapability } from "../capture/capability.js";
import type { CorpusRetrieval } from "../corpus/index.js";
import type { HealthReport } from "../health.js";
import type { AdmissionFilter } from "../relevance/admission.js";
import type { RelevanceIndex, SensitivityClassifier } from "../relevance/index.js";
import type { RuntimeLogger } from "../logger.js";
import { TOOL_NAMES } from "./identifiers.js";
import { RoleCapabilityMissingError, createMcpServer } from "./server.js";

const log: RuntimeLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const index = {
  databasePath: ":memory:",
  search: async () => [],
  close: () => {},
} as unknown as RelevanceIndex;

const retrieval = {
  fetchRecord: async () => ({ status: "failed", failure: { code: "NO_LOCATION", stage: "location" } }),
} as unknown as CorpusRetrieval;

const capture = {
  name: "capture",
  openSession: async () => ({ sessionId: "s-1", feedPath: "/tmp/jinn/s-1/feed.ndjson" }),
  sealSession: async () => ({ sealed: true, capture: { digest: "sha256:abc" } }),
  abandonSession: async () => {},
} as unknown as CaptureCapability;

const allowAllClassifier: SensitivityClassifier = {
  classify: async () => ({ excluded: false }),
};

const allowAllAdmission: AdmissionFilter = {
  admit: async (candidates) => candidates,
};

const health = async (): Promise<HealthReport> => ({ ok: true, version: "0.1.0", checks: [] });

function baseDeps(overrides: Partial<Parameters<typeof createMcpServer>[0]> = {}) {
  return {
    role: "tools" as const,
    version: "0.1.0",
    index,
    retrieval,
    classifier: allowAllClassifier,
    admission: allowAllAdmission,
    log,
    health,
    ...overrides,
  };
}

async function connect(server: ReturnType<typeof createMcpServer>): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("createMcpServer", () => {
  test("the tools role advertises exactly three tools", async () => {
    const client = await connect(createMcpServer(baseDeps({ role: "tools" })));
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual([TOOL_NAMES.corpusFetch, TOOL_NAMES.corpusSearch, TOOL_NAMES.health].sort());
  });

  test("the session role advertises the full surface", async () => {
    const client = await connect(
      createMcpServer(baseDeps({ role: "session", capture })),
    );
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain(TOOL_NAMES.pickup);
    expect(names).toContain(TOOL_NAMES.captureOpen);
    expect(names).toContain(TOOL_NAMES.captureSeal);
    expect(names).toContain(TOOL_NAMES.captureAbandon);
    expect(names).toHaveLength(7);
  });

  test("a capture tool is unreachable from the tools role even by name", async () => {
    const client = await connect(
      createMcpServer(baseDeps({ role: "tools", capture })),
    );
    const result = (await client.callTool({
      name: TOOL_NAMES.captureSeal,
      arguments: { sessionId: "s-1" },
    })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/capture_seal/);
  });

  test("the session role refuses to start without a capture capability", () => {
    expect(() => createMcpServer(baseDeps({ role: "session" }))).toThrow(RoleCapabilityMissingError);
  });

  test("corpus_search round-trips through the transport", async () => {
    const client = await connect(createMcpServer(baseDeps({ role: "tools" })));
    const result = (await client.callTool({
      name: TOOL_NAMES.corpusSearch,
      arguments: { query: "flaky vitest suite" },
    })) as { content: Array<{ type: string; text: string }> };
    expect(JSON.parse(result.content[0]!.text).count).toBe(0);
  });

  test("capture_open round-trips and returns a path, not content", async () => {
    const client = await connect(
      createMcpServer(baseDeps({ role: "session", capture })),
    );
    const result = (await client.callTool({ name: TOOL_NAMES.captureOpen, arguments: {} })) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(JSON.parse(result.content[0]!.text).feedPath).toBe("/tmp/jinn/s-1/feed.ndjson");
  });

  test("an invalid argument is rejected by the schema, not by the handler", async () => {
    const client = await connect(createMcpServer(baseDeps({ role: "tools" })));
    const result = (await client.callTool({
      name: TOOL_NAMES.corpusFetch,
      arguments: { digest: "not-a-digest" },
    })) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });
});
