// SPDX-License-Identifier: Apache-2.0
import { appendFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { TOOL_NAMES } from "./identifiers.js";
import { openSessionRuntimeForTest, openToolsRuntimeForTest } from "./testing-harness.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "jinn-c7-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function client(server: Awaited<ReturnType<typeof openSessionRuntimeForTest>>): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const connected = new Client({ name: "t", version: "0" });
  await Promise.all([server.server.connect(serverTransport), connected.connect(clientTransport)]);
  return connected;
}

function payload(result: unknown): Record<string, unknown> {
  const typed = result as { content: Array<{ text: string }> };
  return JSON.parse(typed.content[0]!.text);
}

/**
 * Session feed lines matching the C4 contract exercised in capture.integration.test.ts.
 * The plan's minimal feed (session-open / user-turn / session-close only) is valid for
 * parseSessionFeed but the integration suite's fuller shape is used here so seal assembly
 * sees the same event mix production feeds carry.
 */
async function appendFeed(feedPath: string, sessionId: string, userText: string): Promise<void> {
  const baseNano = 1_785_488_400_000_000_000n + BigInt(sessionId.length);
  const line = (value: unknown): string => JSON.stringify(value);
  const lines = [
    line({
      type: "session-open",
      v: 1,
      sessionId,
      startedAt: "2026-07-30T09:00:00Z",
      atUnixNano: String(baseNano),
      host: { name: "hermes-agent", version: "test" },
      model: { provider: "test", name: "test-model" },
      conversationId: sessionId,
    }),
    line({
      type: "environment",
      atUnixNano: String(baseNano + 1n),
      tools: ["read_file"],
      skills: [],
    }),
    line({ type: "user-turn", atUnixNano: String(baseNano + 2n), text: userText }),
    line({
      type: "session-close",
      atUnixNano: String(baseNano + 3n),
      endedAt: "2026-07-30T09:00:06Z",
      outcome: "completed",
      summary: `session ${sessionId}`,
    }),
  ];
  await appendFile(feedPath, `${lines.join("\n")}\n`, { encoding: "utf-8" });
}

describe("concurrent sessions on one home", () => {
  test("two session instances open distinct feeds with owner-only permissions", async () => {
    const [a, b] = await Promise.all([
      openSessionRuntimeForTest(home),
      openSessionRuntimeForTest(home),
    ]);
    const [clientA, clientB] = await Promise.all([client(a), client(b)]);
    const openedA = payload(
      await clientA.callTool({ name: TOOL_NAMES.captureOpen, arguments: { sessionId: "alpha" } }),
    );
    const openedB = payload(
      await clientB.callTool({ name: TOOL_NAMES.captureOpen, arguments: { sessionId: "beta" } }),
    );
    expect(openedA.feedPath).not.toBe(openedB.feedPath);
    const mode = (await stat(String(openedA.feedPath))).mode & 0o777;
    expect(mode).toBe(0o600);
    await Promise.all([a.stop(), b.stop()]);
  });

  test("concurrent seals serialize without corrupting either feed", async () => {
    const [a, b] = await Promise.all([
      openSessionRuntimeForTest(home),
      openSessionRuntimeForTest(home),
    ]);
    const [clientA, clientB] = await Promise.all([client(a), client(b)]);
    const openedA = payload(
      await clientA.callTool({ name: TOOL_NAMES.captureOpen, arguments: { sessionId: "alpha" } }),
    );
    const openedB = payload(
      await clientB.callTool({ name: TOOL_NAMES.captureOpen, arguments: { sessionId: "beta" } }),
    );
    await appendFeed(String(openedA.feedPath), "alpha", "hello from alpha");
    await appendFeed(String(openedB.feedPath), "beta", "hello from beta");

    const [sealA, sealB] = await Promise.all([
      clientA.callTool({ name: TOOL_NAMES.captureSeal, arguments: { sessionId: "alpha" } }),
      clientB.callTool({ name: TOOL_NAMES.captureSeal, arguments: { sessionId: "beta" } }),
    ]);
    for (const seal of [payload(sealA), payload(sealB)]) {
      const sealed = seal.sealed === true;
      const busy =
        (seal as { error?: { code?: string; retryable?: boolean } }).error?.code ===
        "capture-archive-busy";
      expect(sealed || busy).toBe(true);
      if (busy) {
        expect((seal as { error: { retryable: boolean } }).error.retryable).toBe(true);
      }
    }
    expect(await readFile(String(openedA.feedPath), "utf-8")).toContain("hello from alpha");
    expect(await readFile(String(openedB.feedPath), "utf-8")).toContain("hello from beta");
    await Promise.all([a.stop(), b.stop()]);
  });

  test("a tools-role search answers while a seal is in flight", async () => {
    const session = await openSessionRuntimeForTest(home);
    const tools = await openToolsRuntimeForTest(home);
    const [sessionClient, toolsClient] = await Promise.all([client(session), client(tools)]);
    const opened = payload(
      await sessionClient.callTool({ name: TOOL_NAMES.captureOpen, arguments: { sessionId: "gamma" } }),
    );
    await appendFeed(String(opened.feedPath), "gamma", "hello from gamma");

    const sealing = sessionClient.callTool({
      name: TOOL_NAMES.captureSeal,
      arguments: { sessionId: "gamma" },
    });
    const searched = payload(
      await toolsClient.callTool({
        name: TOOL_NAMES.corpusSearch,
        arguments: { query: "hello from gamma" },
      }),
    );
    expect(typeof searched.count).toBe("number");
    await sealing;
    await Promise.all([session.stop(), tools.stop()]);
  });
});
