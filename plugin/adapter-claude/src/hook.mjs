// SPDX-License-Identifier: Apache-2.0

/**
 * The host adapter: the one thing MCP structurally cannot carry, which is the host's hook API.
 *
 * Claude Code runs each hook as its own short-lived process and hands it a JSON payload on
 * stdin. Two calls go to the runtime over MCP — `capture_open` at session start and
 * `capture_seal` at session end — and every event in between is an append to a feed file whose
 * path the runtime computed. Autopilot spawns `claude`; these hooks fire inside it; nothing in
 * Autopilot imports an evidence package, and nothing needs to.
 *
 * Two rules govern this module and are tested as such: **no hook ever fails into the host**
 * (stdout stays empty and the exit code stays 0, because a `SessionStart` hook's stdout is
 * added to the session's context), and **a broken runtime degrades the product to silence,
 * never to a broken session**.
 */

import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

import { SessionFeed } from "./feed.mjs";
import {
  CONFIG_INPUT_NAME,
  HOST_NAME,
  PROMPT_INPUT_NAME,
  effectiveCaptureConfig,
  hostVersion,
  modelIdentity,
  readWorkflowInstruction,
} from "./identity.mjs";
import { McpClient } from "./mcp.mjs";
import { runtimeHome } from "./paths.mjs";
import { observeRepositoryState } from "./repo.mjs";
import { clearState, readState, sessionStatePath, writeState } from "./state.mjs";
import { resolveSessionRuntime } from "./runtime.mjs";

/**
 * How a Claude Code session end maps onto a protocol outcome. The host reports why the session
 * ended, never whether the work succeeded, so the mapping says only what the host said: a
 * session left at its own prompt ended normally; a logout took it away mid-flight. A session
 * killed hard fires no hook at all and is sealed later by the runtime's stranded-feed sweep.
 */
const OUTCOME_BY_REASON = Object.freeze({
  clear: "completed",
  prompt_input_exit: "completed",
  other: "completed",
  logout: "abandoned",
});

function debug(env, message) {
  if (String(env.JINN_CAPTURE_DEBUG ?? "").trim() === "") return;
  try {
    process.stderr.write(`jinn: ${message}\n`);
  } catch {
    // A diagnostic that cannot be written is not worth failing a hook for.
  }
}

/**
 * A hook payload carries the host's own tool arguments and results, so its size is the host's
 * to choose, not this adapter's. It is bounded anyway: a hook is a short-lived process the
 * session waits on, and buffering an unbounded payload is the one way this module could cost
 * a session something. Past the bound the event is dropped whole rather than truncated —
 * half a tool result binds to nothing a verifier can check.
 */
export const HOOK_PAYLOAD_MAX_BYTES = 16 * 1024 * 1024;

async function readAll(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > HOOK_PAYLOAD_MAX_BYTES) {
      throw new Error(`the hook payload exceeds ${HOOK_PAYLOAD_MAX_BYTES} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A live session-role runtime, or `undefined`. Never throws. */
async function openRuntime(env) {
  const resolution = resolveSessionRuntime(env);
  if (resolution === undefined) return undefined;
  try {
    const client = new McpClient(resolution.argv, {
      env: { JINN_PLUGIN_HOME: runtimeHome(env) },
    });
    await client.start();
    return { client, resolution };
  } catch (error) {
    debug(env, `runtime unavailable: ${error?.message ?? error}`);
    return undefined;
  }
}

function persist(statePath, state, feed) {
  writeState(statePath, { ...state, lastNano: feed.lastNano.toString() });
}

/**
 * The stored session, or `undefined`. The feed path is re-asserted here rather than only where
 * `capture_open` minted it, so the boundary holds at every point a path reaches the filesystem
 * instead of only at the one where it was first checked.
 */
function openStoredFeed(statePath) {
  const state = readState(statePath);
  if (typeof state?.feedPath !== "string" || !isAbsolute(state.feedPath)) return undefined;
  return { state, feed: new SessionFeed(state.feedPath, state.lastNano) };
}

async function onSessionStart(payload, env) {
  const statePath = sessionStatePath(payload.session_id, env);
  // `SessionStart` also fires on resume and compact. A second capture for one session would
  // split its evidence in two, so an existing state is left exactly as it is.
  if (readState(statePath) !== undefined) return;

  const opened = await openRuntime(env);
  if (opened === undefined) return;
  const { client, resolution } = opened;
  try {
    const result = await client.callTool("capture_open", {});
    const captureSessionId = String(result?.sessionId ?? "");
    const feedPath = String(result?.feedPath ?? "");
    // The feed path is minted by the runtime, never by the host; this asserts that the value
    // that reaches the filesystem really did come from there.
    if (captureSessionId === "" || feedPath === "" || !isAbsolute(feedPath)) {
      debug(env, "capture_open returned no usable session");
      return;
    }

    const model = modelIdentity(env);
    const host = { name: HOST_NAME, version: hostVersion(env) };
    const feed = new SessionFeed(feedPath);
    const written = feed.openSession({
      sessionId: captureSessionId,
      hostName: host.name,
      hostVersion: host.version,
      modelProvider: model.provider,
      modelName: model.name,
      modelService: model.service,
    });
    if (!written) {
      debug(env, "the session could not be opened; abandoning the capture");
      await client.callTool("capture_abandon", { sessionId: captureSessionId }).catch(() => {});
      return;
    }

    const observed = observeRepositoryState(payload.cwd);
    if (observed !== undefined) feed.repositoryState(observed);

    feed.controlledInput({
      role: "config",
      name: CONFIG_INPUT_NAME,
      mediaType: "application/json",
      content: effectiveCaptureConfig({
        model,
        host,
        ...(resolution.pin === undefined ? {} : { runtimePin: resolution.pin }),
      }),
    });
    const workflow = readWorkflowInstruction(payload.cwd);
    if (workflow !== undefined) feed.controlledInput(workflow);

    feed.environment({ tools: [], skills: [] });
    persist(statePath, { captureSessionId, feedPath, promptBound: false }, feed);
  } catch (error) {
    debug(env, `session start failed: ${error?.message ?? error}`);
  } finally {
    client.close();
  }
}

function onUserPromptSubmit(payload, env) {
  const statePath = sessionStatePath(payload.session_id, env);
  const stored = openStoredFeed(statePath);
  if (stored === undefined) return;
  const { state, feed } = stored;
  const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
  let promptBound = state.promptBound === true;
  // The first prompt is the instruction that drove the session. Its bytes are already in the
  // feed as a `user-turn`, so binding them adds no disclosure surface; it makes them
  // content-addressed rather than narrative.
  if (!promptBound && prompt !== "") {
    promptBound = feed.controlledInput({
      role: "prompt",
      name: PROMPT_INPUT_NAME,
      mediaType: "text/markdown",
      content: new TextEncoder().encode(prompt),
    });
  }
  feed.userTurn(prompt);
  persist(statePath, { ...state, promptBound }, feed);
}

function onPostToolUse(payload, env) {
  const statePath = sessionStatePath(payload.session_id, env);
  const stored = openStoredFeed(statePath);
  if (stored === undefined) return;
  const { state, feed } = stored;
  const response = payload.tool_response;
  const failed =
    response !== null && typeof response === "object" && !Array.isArray(response)
      ? response.success === false || typeof response.error === "string"
      : false;
  feed.toolCall({
    toolName: typeof payload.tool_name === "string" ? payload.tool_name : "unknown",
    // Claude Code does not always name the call, and a trace needs one identifier per call.
    toolCallId: typeof payload.tool_use_id === "string" && payload.tool_use_id !== ""
      ? payload.tool_use_id
      : randomUUID(),
    args: payload.tool_input,
    result: response,
    status: failed ? "error" : "ok",
    ...(failed && typeof response.error === "string" ? { errorMessage: response.error } : {}),
  });
  persist(statePath, state, feed);
}

async function onSessionEnd(payload, env) {
  const statePath = sessionStatePath(payload.session_id, env);
  const stored = openStoredFeed(statePath);
  if (stored === undefined) return;
  const { state, feed } = stored;
  feed.closeSession({
    outcome: OUTCOME_BY_REASON[String(payload.reason ?? "other")] ?? "completed",
    summary: "",
  });
  // The state is dropped whatever the seal does: the session is over, and an unsealed feed is
  // recovered by the runtime's own stranded-feed sweep at the start of a later session.
  clearState(statePath);

  const opened = await openRuntime(env);
  if (opened === undefined) return;
  try {
    const sealed = await opened.client.callTool("capture_seal", {
      sessionId: state.captureSessionId,
    });
    if (sealed?.sealed !== true) debug(env, `capture not sealed: ${JSON.stringify(sealed)}`);
  } catch (error) {
    // A busy archive keeps the feed; a later session's sweep seals it. Never user-facing.
    debug(env, `seal deferred: ${error?.message ?? error}`);
  } finally {
    opened.client.close();
  }
}

const HANDLERS = Object.freeze({
  SessionStart: onSessionStart,
  UserPromptSubmit: onUserPromptSubmit,
  PostToolUse: onPostToolUse,
  SessionEnd: onSessionEnd,
});

/**
 * Run one hook. Always resolves, always to nothing: the caller's exit code stays 0 and stdout
 * stays empty, because a hook that fails is a session that fails.
 */
export async function run(argv, { stdin, env = process.env } = {}) {
  let payload;
  try {
    payload = JSON.parse(await readAll(stdin));
  } catch (error) {
    debug(env, `unreadable hook payload: ${error?.message ?? error}`);
    return;
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return;
  const event = typeof payload.hook_event_name === "string" ? payload.hook_event_name : argv[0];
  const handler = Object.hasOwn(HANDLERS, event) ? HANDLERS[event] : undefined;
  if (handler === undefined) return;
  if (typeof payload.session_id !== "string" || payload.session_id === "") return;
  try {
    await handler(payload, env);
  } catch (error) {
    debug(env, `${event} failed: ${error?.message ?? error}`);
  }
}
