#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

/**
 * A stand-in for `jinn-plugin-runtime-session` that speaks the same three MCP messages.
 *
 * It exists so the hook tests exercise the **real** runtime resolution, the real MCP client,
 * and a real child process — everything except the runtime's own sealing, which the runtime's
 * suite owns. `JINN_FAKE_MODE` selects the failure the test is asking for.
 */

import { createInterface } from "node:readline";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.JINN_PLUGIN_HOME ?? process.cwd();
const mode = process.env.JINN_FAKE_MODE ?? "ok";

if (mode === "die") process.exit(3);

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function textResult(payload, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], isError };
}

function record(name, args) {
  mkdirSync(home, { recursive: true });
  const path = join(home, "calls.json");
  let calls = [];
  try {
    calls = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    calls = [];
  }
  calls.push({ name, args });
  writeFileSync(path, JSON.stringify(calls));
}

function callTool(name, args) {
  record(name, args);
  if (name === "capture_open") {
    if (mode === "open-empty") return textResult({});
    if (mode === "open-relative") return textResult({ sessionId: "cap-1", feedPath: "feed.ndjson" });
    const sessionId = args.sessionId ?? "cap-1";
    const directory = join(home, "capture", "sessions", sessionId);
    mkdirSync(directory, { recursive: true });
    const feedPath = join(directory, "feed.ndjson");
    writeFileSync(feedPath, "", { mode: 0o600 });
    return textResult({ sessionId, feedPath });
  }
  if (name === "capture_seal") {
    if (mode === "seal-busy") {
      return textResult(
        { error: { code: "capture-archive-busy", detail: "held elsewhere" } },
        true,
      );
    }
    return textResult({ sealed: true, digest: "sha256:deadbeef" });
  }
  if (name === "capture_abandon") return textResult({ abandoned: true });
  return textResult({ error: { code: "unknown-tool", detail: name } }, true);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === "initialize") {
    const version = mode === "protocol-alien" ? "1999-01-01" : "2025-06-18";
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: version,
        capabilities: {},
        serverInfo: { name: "fake-runtime", version: "0.0.0" },
      },
    });
    return;
  }
  if (message.method === "tools/call") {
    if (mode === "silent") return; // a wedged runtime that never answers
    if (mode === "rpc-error") {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "broken" } });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: callTool(message.params.name, message.params.arguments ?? {}),
    });
  }
});
