// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { McpClient, McpError, payloadOf } from "../src/mcp.mjs";
import { SESSION_BIN_NAME } from "../src/runtime.mjs";
import { fakeRuntimeDir } from "./fake.mjs";
import { temp } from "./helpers.mjs";

function client(mode, options = {}) {
  return new McpClient([join(fakeRuntimeDir(), SESSION_BIN_NAME)], {
    env: { JINN_PLUGIN_HOME: temp(), ...(mode === undefined ? {} : { JINN_FAKE_MODE: mode }) },
    ...options,
  });
}

test("a tool answers with the parsed payload of its single text block", () => {
  assert.deepEqual(payloadOf({ content: [{ type: "text", text: '{"sealed":true}' }] }), {
    sealed: true,
  });
  assert.deepEqual(payloadOf({ content: [{ type: "text", text: "not json" }] }), {
    text: "not json",
  });
  assert.deepEqual(payloadOf({ content: [{ type: "image" }] }), {});
  assert.deepEqual(payloadOf({}), {});
  assert.deepEqual(payloadOf({ content: [{ type: "text", text: "[1]" }] }), { value: [1] });
});

test("the handshake negotiates, and a tool call round-trips", async () => {
  const connection = await client().start();
  try {
    assert.equal(connection.protocolVersion, "2025-06-18");
    const opened = await connection.callTool("capture_open", {});
    assert.equal(typeof opened.feedPath, "string");
  } finally {
    connection.close();
  }
});

test("a protocol the adapter does not speak is refused rather than assumed", async () => {
  const connection = client("protocol-alien");
  await assert.rejects(connection.start(), (error) => {
    assert.equal(error instanceof McpError, true);
    assert.equal(error.code, "protocol-unsupported");
    return true;
  });
  connection.close();
});

test("a tool that answers with isError raises the structured code", async () => {
  const connection = await client("seal-busy").start();
  try {
    await assert.rejects(connection.callTool("capture_seal", { sessionId: "cap-1" }), (error) => {
      assert.equal(error.code, "capture-archive-busy");
      return true;
    });
  } finally {
    connection.close();
  }
});

test("a JSON-RPC error is a rejection, not a silently empty result", async () => {
  const connection = await client("rpc-error").start();
  try {
    await assert.rejects(connection.callTool("capture_open", {}), (error) => {
      assert.equal(error.code, "rpc-error");
      return true;
    });
  } finally {
    connection.close();
  }
});

test("a wedged runtime is a bounded wait, never a hung hook", async () => {
  const connection = await client("silent", { timeoutMs: 150 }).start();
  try {
    await assert.rejects(connection.callTool("capture_open", {}), (error) => {
      assert.equal(error.code, "timeout");
      return true;
    });
  } finally {
    connection.close();
  }
});

test("a runtime that exits fails the handshake instead of hanging it", async () => {
  const connection = client("die", { timeoutMs: 2_000 });
  await assert.rejects(connection.start(), (error) => {
    assert.equal(error instanceof McpError, true);
    return true;
  });
  connection.close();
});

test("a binary that does not exist is a start failure, not a throw from spawn", async () => {
  const connection = new McpClient([join(temp(), "absent")], { timeoutMs: 500 });
  await assert.rejects(connection.start(), (error) => error instanceof McpError);
  connection.close();
});

test("closing twice is safe, and a call after close is refused", async () => {
  const connection = await client().start();
  connection.close();
  connection.close();
  await assert.rejects(connection.callTool("capture_open", {}), (error) => {
    assert.equal(error.code, "not-running");
    return true;
  });
});
