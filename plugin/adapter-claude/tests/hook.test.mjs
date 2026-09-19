// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { CONTROLLED_INPUT_MAX_BYTES } from "../src/feed.mjs";
import { HOOK_PAYLOAD_MAX_BYTES, run } from "../src/hook.mjs";
import { CONTROLLED_INPUT_SELECTION_RULE } from "../src/identity.mjs";
import { readState, sessionStatePath, writeState } from "../src/state.mjs";
import { fakeEnv, toolCalls } from "./fake.mjs";
import { feedEvents, stdinOf, temp } from "./helpers.mjs";

const SESSION = "sess-abc";

/**
 * The fake runtime reads its mode from the environment it inherits, and the adapter
 * deliberately hands a child only `JINN_PLUGIN_HOME`. `await body()` rather than
 * `return body()` is load-bearing: restoring the variable before the child has spawned would
 * silently run every failure test against a healthy runtime.
 */
async function withFakeMode(mode, body) {
  const previous = process.env.JINN_FAKE_MODE;
  process.env.JINN_FAKE_MODE = mode;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.JINN_FAKE_MODE;
    else process.env.JINN_FAKE_MODE = previous;
  }
}

function payload(event, extra = {}) {
  return { hook_event_name: event, session_id: SESSION, cwd: process.cwd(), ...extra };
}

async function hook(event, env, extra = {}) {
  await run([event], { stdin: stdinOf(payload(event, extra)), env });
}

function stateOf(env) {
  return readState(sessionStatePath(SESSION, env));
}

function events(env) {
  return feedEvents(stateOf(env).feedPath);
}

test("SessionStart opens a capture and binds both of the fixture's capture gaps", async () => {
  const env = fakeEnv();
  const cwd = temp("jinn-claude-cwd-");
  writeFileSync(join(cwd, "CLAUDE.md"), "# Project rules\n");
  await hook("SessionStart", env, { cwd, source: "startup" });

  const state = stateOf(env);
  assert.equal(state.captureSessionId, "cap-1");
  assert.equal(state.promptBound, false);

  const written = feedEvents(state.feedPath);
  assert.deepEqual(
    written.map((event) => event.type),
    ["session-open", "controlled-input", "controlled-input", "environment"],
  );

  const open = written[0];
  assert.deepEqual(open.host, { name: "claude-code", version: "2.1.258" });
  assert.equal(open.model.service.iri, "https://spec.jinn.network/services/anthropic/claude-opus-5");

  const bound = Object.fromEntries(
    written.filter((event) => event.type === "controlled-input").map((event) => [event.role, event]),
  );
  assert.deepEqual(Object.keys(bound).sort(), ["config", "workflow"]);
  assert.equal(
    Buffer.from(bound.workflow.contentBase64, "base64").toString("utf8"),
    "# Project rules\n",
  );
  const config = JSON.parse(Buffer.from(bound.config.contentBase64, "base64").toString("utf8"));
  assert.equal(config.selectionRule, CONTROLLED_INPUT_SELECTION_RULE);
});

test("the base repository state is bound when the session sits in a public checkout", async () => {
  const env = fakeEnv();
  const repo = temp("jinn-claude-repo-");
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "T");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "f.txt"), "x");
  git("add", "f.txt");
  git("commit", "-qm", "one");
  git("remote", "add", "origin", "https://github.com/example/repo.git");

  await hook("SessionStart", env, { cwd: repo });
  const state = events(env).find((event) => event.type === "repository-state");
  assert.equal(state.repository, "https://github.com/example/repo");
  assert.match(state.baseCommit, /^[0-9a-f]{40}$/u);
});

test("a resumed or compacted session never opens a second capture", async () => {
  const env = fakeEnv();
  await hook("SessionStart", env, { source: "startup" });
  const before = readFileSync(stateOf(env).feedPath, "utf8");
  await hook("SessionStart", env, { source: "resume" });
  assert.equal(readFileSync(stateOf(env).feedPath, "utf8"), before);
  assert.equal(toolCalls(env).filter((call) => call.name === "capture_open").length, 1);
});

test("the first prompt is bound once, and every prompt is a turn", async () => {
  const env = fakeEnv();
  await hook("SessionStart", env);
  await hook("UserPromptSubmit", env, { prompt: "Implement issue #3223." });
  await hook("UserPromptSubmit", env, { prompt: "and again" });

  const bound = events(env).filter((event) => event.type === "controlled-input");
  assert.deepEqual(bound.map((event) => event.role).sort(), ["config", "prompt"]);
  assert.equal(
    Buffer.from(bound.find((event) => event.role === "prompt").contentBase64, "base64").toString(
      "utf8",
    ),
    "Implement issue #3223.",
  );
  assert.deepEqual(
    events(env)
      .filter((event) => event.type === "user-turn")
      .map((event) => event.text),
    ["Implement issue #3223.", "and again"],
  );
  assert.equal(stateOf(env).promptBound, true);
});

test("an empty first prompt binds nothing and leaves the binding available", async () => {
  const env = fakeEnv();
  await hook("SessionStart", env);
  await hook("UserPromptSubmit", env, { prompt: "" });
  assert.equal(stateOf(env).promptBound, false);
  await hook("UserPromptSubmit", env, { prompt: "the real instruction" });
  assert.equal(stateOf(env).promptBound, true);
});

test("an oversized first instruction is absent, never replaced by a later one", async () => {
  const env = fakeEnv();
  await withFakeMode("ok", () => hook("SessionStart", env));
  await hook("UserPromptSubmit", env, { prompt: "x".repeat(CONTROLLED_INPUT_MAX_BYTES + 1) });
  await hook("UserPromptSubmit", env, { prompt: "a much later instruction" });

  // Binding turn two under the name `initial-user-prompt.md` would be a confident wrong claim.
  assert.equal(
    events(env).some((event) => event.type === "controlled-input" && event.role === "prompt"),
    false,
  );
  assert.equal(stateOf(env).promptBound, true);
});

test("a reported failure is recorded as one; an empty error string is not", async () => {
  const env = fakeEnv();
  await withFakeMode("ok", () => hook("SessionStart", env));
  await hook("PostToolUse", env, {
    tool_name: "Read",
    tool_input: {},
    tool_response: { error: "   " },
  });
  await hook("PostToolUse", env, {
    tool_name: "Read",
    tool_input: {},
    tool_response: { success: false },
  });
  const calls = events(env).filter((event) => event.type === "tool-call");
  assert.equal(calls[0].status, "ok");
  assert.equal(calls[0].errorMessage, undefined);
  assert.equal(calls[1].status, "error");
});

test("a session-end reason nobody sent cannot reach the prototype", async () => {
  for (const reason of ["constructor", "toString", "__proto__"]) {
    const env = fakeEnv();
    await withFakeMode("ok", () => hook("SessionStart", env));
    const { feedPath } = stateOf(env);
    await withFakeMode("ok", () => hook("SessionEnd", env, { reason }));
    assert.equal(feedEvents(feedPath).at(-1).outcome, "completed", reason);
  }
});

test("a tool call carries the host's own id when it has one, and a unique id when not", async () => {
  const env = fakeEnv();
  await hook("SessionStart", env);
  await hook("PostToolUse", env, {
    tool_name: "Bash",
    tool_use_id: "toolu_01",
    tool_input: { command: "yarn test" },
    tool_response: { stdout: "ok" },
  });
  await hook("PostToolUse", env, {
    tool_name: "Read",
    tool_input: { file_path: "/x" },
    tool_response: { success: false, error: "missing" },
  });

  const [first, second] = events(env).filter((event) => event.type === "tool-call");
  assert.equal(first.toolCallId, "toolu_01");
  assert.equal(first.status, "ok");
  assert.equal(first.arguments, '{"command":"yarn test"}');
  assert.equal(second.status, "error");
  assert.equal(second.errorMessage, "missing");
  assert.notEqual(second.toolCallId, "");
  assert.notEqual(second.toolCallId, first.toolCallId);
});

test("SessionEnd closes the feed, seals it, and drops the state", async () => {
  const env = fakeEnv();
  await hook("SessionStart", env);
  const { feedPath } = stateOf(env);
  await hook("SessionEnd", env, { reason: "prompt_input_exit" });

  const written = feedEvents(feedPath);
  assert.equal(written.at(-1).type, "session-close");
  assert.equal(written.at(-1).outcome, "completed");
  assert.deepEqual(
    toolCalls(env).at(-1),
    { name: "capture_seal", args: { sessionId: "cap-1" } },
  );
  assert.equal(stateOf(env), undefined);
});

test("the host's reason is reported, never a success it did not claim", async () => {
  for (const [reason, outcome] of [
    ["logout", "abandoned"],
    ["clear", "completed"],
    ["other", "completed"],
    ["something-new", "completed"],
  ]) {
    const env = fakeEnv();
    await hook("SessionStart", env);
    const { feedPath } = stateOf(env);
    await hook("SessionEnd", env, { reason });
    assert.equal(feedEvents(feedPath).at(-1).outcome, outcome, reason);
  }
});

test("a seal the archive refuses still drops the state; the runtime's sweep is the net", async () => {
  const env = fakeEnv();
  await hook("SessionStart", env);
  const { feedPath } = stateOf(env);
  await withFakeMode("seal-busy", () => hook("SessionEnd", env, { reason: "other" }));
  assert.equal(stateOf(env), undefined);
  assert.equal(feedEvents(feedPath).at(-1).type, "session-close");
});

test("every stamp in a whole session is non-decreasing", async () => {
  const env = fakeEnv();
  await hook("SessionStart", env);
  const { feedPath } = stateOf(env);
  await hook("UserPromptSubmit", env, { prompt: "go" });
  await hook("PostToolUse", env, { tool_name: "Bash", tool_input: {}, tool_response: {} });
  await hook("UserPromptSubmit", env, { prompt: "again" });
  await hook("SessionEnd", env, { reason: "other" });

  const stamps = feedEvents(feedPath).map((event) => BigInt(event.atUnixNano));
  for (let index = 1; index < stamps.length; index += 1) {
    assert.ok(stamps[index] >= stamps[index - 1], `line ${index} went backwards`);
  }
});

test("no resolvable runtime is silence: no state, no feed, no raise", async () => {
  const env = fakeEnv({ PATH: temp() });
  await hook("SessionStart", env);
  assert.equal(stateOf(env), undefined);
  assert.equal(existsSync(join(env.CLAUDE_CONFIG_DIR, "jinn", "sessions")), false);
});

test("a runtime that dies or speaks an alien protocol is silence, and leaks no child", async () => {
  // The suite finishing at all is half the assertion: a start that failed without closing its
  // child would keep the test runner's event loop open until it was killed.
  for (const mode of ["die", "protocol-alien"]) {
    const env = fakeEnv();
    await withFakeMode(mode, () => hook("SessionStart", env));
    assert.equal(stateOf(env), undefined, mode);
  }
});

test("a runtime that answers capture_open with nothing usable writes no state", async () => {
  for (const mode of ["open-empty", "open-relative"]) {
    const env = fakeEnv();
    await withFakeMode(mode, () => hook("SessionStart", env));
    assert.equal(stateOf(env), undefined, mode);
  }
});

test("an event that arrives before its session did is a no-op", async () => {
  const env = fakeEnv();
  for (const event of ["UserPromptSubmit", "PostToolUse", "SessionEnd"]) {
    await hook(event, env, { prompt: "x", tool_name: "Bash", reason: "other" });
  }
  assert.equal(stateOf(env), undefined);
  assert.deepEqual(toolCalls(env), []);
});

test("an unreadable, shapeless, unnamed, or unknown hook payload does nothing", async () => {
  const env = fakeEnv();
  const { Readable } = await import("node:stream");
  await run(["SessionStart"], { stdin: Readable.from([Buffer.from("not json")]), env });
  await run(["SessionStart"], { stdin: Readable.from([Buffer.from("[1,2]")]), env });
  await run([], { stdin: stdinOf({ hook_event_name: "Notification", session_id: SESSION }), env });
  await run([], { stdin: stdinOf({ hook_event_name: "SessionStart" }), env });
  await run([], { stdin: stdinOf({ hook_event_name: "SessionStart", session_id: "" }), env });
  assert.deepEqual(toolCalls(env), []);
});

test("a payload past the bound is dropped whole rather than buffered or truncated", async () => {
  const env = fakeEnv();
  await withFakeMode("ok", () => hook("SessionStart", env));
  const { feedPath } = stateOf(env);
  const before = feedEvents(feedPath).length;

  // Valid JSON, so only the bound can reject it: a payload that merely fails to parse would
  // pass this test with the bound deleted.
  const { Readable } = await import("node:stream");
  const huge = JSON.stringify(
    payload("PostToolUse", {
      tool_name: "Bash",
      tool_input: {},
      tool_response: { stdout: "x".repeat(HOOK_PAYLOAD_MAX_BYTES) },
    }),
  );
  assert.ok(Buffer.byteLength(huge) > HOOK_PAYLOAD_MAX_BYTES);
  await run([], { stdin: Readable.from([Buffer.from(huge)]), env });
  assert.equal(feedEvents(feedPath).length, before);

  // A payload comfortably inside the bound is still recorded, so the bound is a bound and not
  // a refusal of large tool results in general.
  await hook("PostToolUse", env, {
    tool_name: "Bash",
    tool_input: {},
    tool_response: { stdout: "y".repeat(1024) },
  });
  assert.equal(feedEvents(feedPath).length, before + 1);
});

test("a stored feed path that is not absolute is refused at every later hook", async () => {
  const env = fakeEnv();
  await withFakeMode("ok", () => hook("SessionStart", env));
  const statePath = sessionStatePath(SESSION, env);
  const { feedPath } = stateOf(env);
  const before = feedEvents(feedPath).length;
  writeState(statePath, { ...stateOf(env), feedPath: "relative/feed.ndjson" });

  await hook("UserPromptSubmit", env, { prompt: "x" });
  await hook("PostToolUse", env, { tool_name: "Bash", tool_input: {}, tool_response: {} });
  await withFakeMode("ok", () => hook("SessionEnd", env, { reason: "other" }));

  assert.equal(feedEvents(feedPath).length, before);
  assert.equal(existsSync("relative/feed.ndjson"), false);
  // The seal is never asked for either: there is no session this process can vouch for.
  assert.equal(toolCalls(env).some((call) => call.name === "capture_seal"), false);
});

test("the event name may come from argv when the payload omits it", async () => {
  const env = fakeEnv();
  await run(["SessionStart"], { stdin: stdinOf({ session_id: SESSION, cwd: temp() }), env });
  assert.notEqual(stateOf(env), undefined);
});

test("the process entry writes nothing to stdout and exits zero", () => {
  const env = fakeEnv();
  const main = fileURLToPath(new URL("../src/main.mjs", import.meta.url));
  const stdout = execFileSync(process.execPath, [main, "SessionStart"], {
    input: JSON.stringify(payload("SessionStart")),
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  // A SessionStart hook's stdout is added to the session's context, so it must stay empty.
  assert.equal(stdout, "");
  assert.notEqual(stateOf(env), undefined);
});
