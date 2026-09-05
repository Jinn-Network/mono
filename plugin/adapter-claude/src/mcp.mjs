// SPDX-License-Identifier: Apache-2.0

/**
 * A dependency-free MCP client over stdio.
 *
 * Why not an SDK: Claude Code installs a plugin by cloning it and runs no dependency install,
 * so importing one would make capture conditional on an install step the operator never
 * performs. MCP over stdio is newline-delimited JSON-RPC 2.0 and this adapter needs three
 * messages, so the client is written here and stays small on purpose.
 *
 * Every wait is bounded and every failure is an error object, never a hang: a hook that blocks
 * is a session that blocks.
 */

import { spawn } from "node:child_process";

export const CLIENT_NAME = "jinn-claude-adapter";
export const CLIENT_VERSION = "0.1.0";

/** Requested at initialize. The server may negotiate down, so this is a preference. */
export const PROTOCOL_VERSION = "2025-06-18";
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);

export const DEFAULT_TIMEOUT_MS = 30_000;
const STDERR_RING_LINES = 20;
const TERMINATE_GRACE_MS = 2_000;

export class McpError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = "McpError";
    this.code = code;
    this.detail = detail;
  }
}

/** Every tool in this runtime answers with exactly one text block. */
export function payloadOf(result) {
  const content = result?.content;
  if (!Array.isArray(content) || content.length === 0) return {};
  const first = content[0];
  if (first?.type !== "text") return {};
  try {
    const parsed = JSON.parse(String(first.text ?? ""));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : { value: parsed };
  } catch {
    return { text: String(first.text ?? "") };
  }
}

/** One runtime subprocess, one JSON-RPC session. */
export class McpClient {
  constructor(argv, { env = {}, timeoutMs = DEFAULT_TIMEOUT_MS, spawnFn = spawn } = {}) {
    this.argv = [...argv];
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.spawnFn = spawnFn;
    this.child = undefined;
    this.pending = new Map();
    this.stderr = [];
    this.buffer = "";
    this.nextId = 0;
    this.exited = false;
    this.protocolVersion = "";
  }

  async start() {
    if (this.child !== undefined) return this;
    try {
      this.child = this.spawnFn(this.argv[0], this.argv.slice(1), {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...this.env },
      });
    } catch (error) {
      throw new McpError("start-failed", String(error?.message ?? error));
    }
    this.child.on("error", (error) => this.#fail("start-failed", String(error?.message ?? error)));
    this.child.on("exit", () => {
      this.exited = true;
      this.#fail("transport-closed", this.#exitDetail("the runtime exited"));
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.#absorb(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      for (const line of String(chunk).split("\n")) {
        if (line.trim() === "") continue;
        this.stderr.push(line.trim());
        if (this.stderr.length > STDERR_RING_LINES) this.stderr.shift();
      }
    });
    await this.#handshake();
    return this;
  }

  async callTool(name, args) {
    const result = await this.#request("tools/call", { name, arguments: { ...args } });
    const payload = payloadOf(result);
    if (result?.isError) {
      const error = payload?.error;
      throw new McpError(String(error?.code ?? "tool-error"), String(error?.detail ?? name));
    }
    return payload;
  }

  close() {
    const child = this.child;
    this.child = undefined;
    if (child === undefined) return;
    this.#fail("transport-closed", "the client closed the connection");
    try {
      // Terminate before closing pipes: a long-lived Node runtime keeps reading stdin, so
      // closing stdout first deadlocks teardown.
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // The child is already gone; nothing left to signal.
        }
      }, TERMINATE_GRACE_MS);
      timer.unref?.();
      child.once("exit", () => clearTimeout(timer));
      child.stdin?.end();
    } catch {
      // Teardown is best effort: a wedged child must not become a raised hook.
    }
  }

  async #handshake() {
    const result = await this.#request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
    });
    const version = String(result?.protocolVersion ?? "");
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
      throw new McpError(
        "protocol-unsupported",
        `server negotiated protocol ${JSON.stringify(version)}, which this adapter does not speak`,
      );
    }
    this.protocolVersion = version;
    this.#write({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  }

  #request(method, params) {
    this.nextId += 1;
    const id = this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError("timeout", `no response within ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.#write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  #write(message) {
    if (this.child?.stdin === undefined || this.child.stdin.destroyed) {
      throw new McpError("not-running", this.#exitDetail("the runtime process is not running"));
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #absorb(chunk) {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // a non-JSON line on stdout is not ours
      }
      const waiter = this.pending.get(message?.id);
      if (waiter === undefined) continue;
      this.pending.delete(message.id);
      if (message.error) {
        waiter.reject(
          new McpError("rpc-error", `${message.error.code}: ${message.error.message}`),
        );
      } else {
        waiter.resolve(message.result ?? {});
      }
    }
  }

  #fail(code, detail) {
    for (const [id, waiter] of this.pending) {
      this.pending.delete(id);
      waiter.reject(new McpError(code, detail));
    }
  }

  #exitDetail(prefix) {
    const tail = this.stderr.slice(-3).join(" | ");
    return tail === "" ? prefix : `${prefix}: ${tail}`;
  }
}
