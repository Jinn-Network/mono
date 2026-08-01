#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Seed a JINN_PLUGIN_HOME with sealed capture records, through the same MCP
// surface the adapter uses. Usage: node seed-archive.mjs <tools-runtime-bin> <home>

import { appendFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const [, , toolsRuntimeBin, home] = process.argv;
if (!toolsRuntimeBin || !home) {
  console.error("usage: seed-archive.mjs <tools-runtime-bin> <home>");
  process.exit(2);
}

const sessionRuntimeBin = join(dirname(toolsRuntimeBin), "jinn-plugin-runtime-session");
const runtimePackageRoot = join(dirname(toolsRuntimeBin), "..", "@jinn-network", "plugin-runtime");
const require = createRequire(join(runtimePackageRoot, "package.json"));
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const SESSIONS = [
  {
    id: "seed-flaky-vitest",
    user: "the vitest suite fails intermittently on CI but passes locally",
    tool: { name: "bash", args: { command: "yarn test" }, result: "2 failed, 118 passed" },
    assistant: "the failure is a shared temp directory between two suites; give each its own mkdtemp",
    summary: "fixed a flaky vitest suite caused by a shared temp directory",
  },
  {
    id: "seed-sqlite-lock",
    user: "better-sqlite3 throws SQLITE_BUSY when two processes open the same database",
    tool: { name: "bash", args: { command: "node repro.mjs" }, result: "SQLITE_BUSY: database is locked" },
    assistant: "enable WAL and set a busy_timeout, or hold the exclusive lock per operation instead of per process",
    summary: "resolved SQLITE_BUSY between two processes on one database",
  },
];

const transport = new StdioClientTransport({
  command: sessionRuntimeBin,
  args: [],
  env: { ...process.env, JINN_PLUGIN_HOME: home },
});
const client = new Client({ name: "jinn-seed", version: "0.1.0" });
await client.connect(transport);

const payload = (result) => JSON.parse(result.content[0].text);

for (const session of SESSIONS) {
  const opened = payload(await client.callTool({ name: "capture_open", arguments: { sessionId: session.id } }));
  let at = process.hrtime.bigint() + 1_700_000_000_000_000_000n;
  const bump = () => {
    at += 1n;
    return String(at);
  };
  const lines = [
    { type: "session-open", v: 1, sessionId: session.id, startedAt: new Date().toISOString(), atUnixNano: bump(), host: { name: "hermes-agent", version: "seed" }, model: { provider: "anthropic", name: "claude-opus-4.6" } },
    { type: "user-turn", atUnixNano: bump(), text: session.user },
    { type: "tool-call", startedAtUnixNano: bump(), atUnixNano: bump(), toolName: session.tool.name, toolCallId: `${session.id}-1`, status: "error", arguments: JSON.stringify(session.tool.args), result: session.tool.result },
    { type: "assistant-turn", atUnixNano: bump(), text: session.assistant },
    { type: "session-close", atUnixNano: bump(), endedAt: new Date().toISOString(), outcome: "completed", summary: session.summary },
  ];
  await appendFile(opened.feedPath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf-8");
  const sealed = payload(await client.callTool({ name: "capture_seal", arguments: { sessionId: session.id } }));
  if (!sealed.sealed) {
    console.error(`seed: ${session.id} did not seal:`, JSON.stringify(sealed));
    process.exit(1);
  }
  console.log(`seeded ${session.id} -> ${sealed.digest}`);
}

await client.close();
