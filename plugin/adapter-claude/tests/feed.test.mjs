// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  CONTROLLED_INPUT_MAX_BYTES,
  CONTROLLED_INPUT_MAX_COUNT,
  SessionFeed,
  absoluteIri,
  canonicalJson,
} from "../src/feed.mjs";
import { feedEvents, temp } from "./helpers.mjs";

function writer() {
  const path = join(temp(), "feed.ndjson");
  writeFileSync(path, "");
  return { path, feed: new SessionFeed(path) };
}

function opened() {
  const made = writer();
  made.feed.openSession({
    sessionId: "cap-1",
    hostName: "claude-code",
    hostVersion: "2.1.258",
    modelProvider: "anthropic",
    modelName: "claude-opus-5",
  });
  return made;
}

test("canonical JSON sorts keys at every depth and emits no whitespace", () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: [3, 2], c: "x" } }),
    '{"a":{"c":"x","d":[3,2]},"b":1}',
  );
});

test("the runtime's absolute-IRI rule is mirrored, including the parse it performs", () => {
  assert.equal(absoluteIri("https://github.com/o/r"), true);
  // Shape-only would accept both of these, and the runtime refuses the whole feed for one.
  assert.equal(absoluteIri("https://github.com:99999999/o/r"), false);
  assert.equal(absoluteIri("https://ex[ample.com/o/r"), false);
  assert.equal(absoluteIri("not an iri"), false);
});

test("session-open carries the version, the host, and the model", () => {
  const { path, feed } = opened();
  const [event] = feedEvents(path);
  assert.equal(event.type, "session-open");
  assert.equal(event.v, 1);
  assert.deepEqual(event.host, { name: "claude-code", version: "2.1.258" });
  assert.equal(event.model.service, undefined);
  assert.equal(feed.lineCount, 1);
});

test("a model service the runtime would refuse costs itself, never the session", () => {
  for (const service of [
    { name: "Anthropic" }, // no IRI
    { iri: "not an iri" },
    { iri: "https://x.test/s", providerIri: "https://x.test/s" },
    { iri: "https://x.test/s", providerIri: "not an iri" },
  ]) {
    const { path, feed } = writer();
    assert.equal(
      feed.openSession({
        sessionId: "cap-1",
        hostName: "claude-code",
        hostVersion: "1.0.0",
        modelProvider: "anthropic",
        modelName: "opus",
        modelService: service,
      }),
      true,
    );
    assert.equal(feedEvents(path)[0].model.service, undefined);
  }
});

test("an over-long descriptive service field is dropped, the identity is kept", () => {
  const { path, feed } = writer();
  feed.openSession({
    sessionId: "cap-1",
    hostName: "claude-code",
    hostVersion: "1.0.0",
    modelProvider: "anthropic",
    modelName: "opus",
    modelService: { iri: "https://x.test/s", name: "n".repeat(257), version: "1" },
  });
  assert.deepEqual(feedEvents(path)[0].model.service, { iri: "https://x.test/s", version: "1" });
});

test("a session-open the runtime would refuse is not written at all", () => {
  for (const overrides of [
    { sessionId: "" },
    { sessionId: "s".repeat(129) },
    { hostVersion: "  " },
    { modelName: "" },
  ]) {
    const { path, feed } = writer();
    assert.equal(
      feed.openSession({
        sessionId: "cap-1",
        hostName: "claude-code",
        hostVersion: "1.0.0",
        modelProvider: "anthropic",
        modelName: "opus",
        ...overrides,
      }),
      false,
    );
    assert.equal(readFileSync(path, "utf8"), "");
  }
});

test("repository state binds the commit and tree and treats branch and base as context", () => {
  const { path, feed } = opened();
  assert.equal(
    feed.repositoryState({
      repository: "https://github.com/Jinn-Network/mono",
      baseCommit: "a".repeat(40),
      baseTree: "b".repeat(40),
      branch: "HEAD",
      targetBase: "x".repeat(257),
    }),
    true,
  );
  const event = feedEvents(path)[1];
  assert.equal(event.baseCommit, "a".repeat(40));
  // A detached head reports "HEAD", which names nothing; an over-long base exceeds the bound.
  assert.equal(event.branch, undefined);
  assert.equal(event.targetBase, undefined);
});

test("repository state is written at most once and refuses a malformed binding", () => {
  const { feed } = opened();
  const good = {
    repository: "https://github.com/o/r",
    baseCommit: "a".repeat(40),
    baseTree: "b".repeat(64),
  };
  assert.equal(feed.repositoryState(good), true);
  assert.equal(feed.repositoryState(good), false);

  const { feed: second } = opened();
  // Uppercase hex is a second spelling of one commit, and two spellings are two identities.
  assert.equal(second.repositoryState({ ...good, baseCommit: "A".repeat(40) }), false);
  assert.equal(second.repositoryState({ ...good, repository: "github.com/o/r" }), false);
});

test("a controlled input the runtime would refuse costs itself", () => {
  const { feed } = opened();
  const content = new TextEncoder().encode("{}");
  const base = { role: "config", name: "c.json", mediaType: "application/json", content };
  assert.equal(feed.controlledInput(base), true);
  assert.equal(feed.controlledInput({ ...base, role: "unknown" }), false);
  assert.equal(feed.controlledInput({ ...base, name: "n".repeat(257) }), false);
  assert.equal(feed.controlledInput({ ...base, mediaType: "m".repeat(129) }), false);
  assert.equal(feed.controlledInput({ ...base, content: new Uint8Array(0) }), false);
  assert.equal(feed.controlledInput({ ...base, content: "not bytes" }), false);
  assert.equal(
    feed.controlledInput({ ...base, content: new Uint8Array(CONTROLLED_INPUT_MAX_BYTES + 1) }),
    false,
  );
  assert.equal(feed.lineCount, 2);
});

test("the controlled-input count budget is spent, not exceeded", () => {
  const { feed } = opened();
  const input = {
    role: "skill",
    name: "s.md",
    mediaType: "text/markdown",
    content: new TextEncoder().encode("x"),
  };
  for (let index = 0; index < CONTROLLED_INPUT_MAX_COUNT; index += 1) {
    assert.equal(feed.controlledInput(input), true);
  }
  assert.equal(feed.controlledInput(input), false);
});

test("a tool call never ends before it started and names its status", () => {
  const { path, feed } = opened();
  feed.toolCall({
    toolName: "Bash",
    toolCallId: "call-1",
    args: { command: "pytest" },
    result: { error: "boom" },
    status: "error",
    errorMessage: "boom",
  });
  const event = feedEvents(path)[1];
  assert.equal(event.status, "error");
  assert.equal(event.errorMessage, "boom");
  assert.equal(event.arguments, '{"command":"pytest"}');
  assert.ok(BigInt(event.startedAtUnixNano) <= BigInt(event.atUnixNano));
});

test("a tool call without a name or an id is refused", () => {
  const { feed } = opened();
  assert.equal(feed.toolCall({ toolName: "", toolCallId: "c" }), false);
  assert.equal(feed.toolCall({ toolName: "Bash", toolCallId: "  " }), false);
});

test("stamps never decrease, including across the process boundary", () => {
  const { path, feed } = opened();
  const future = BigInt(Date.now()) * 1_000_000n + 60_000_000_000n;
  const resumed = new SessionFeed(path, future.toString());
  resumed.userTurn("later");
  const events = feedEvents(path);
  assert.ok(BigInt(events[1].atUnixNano) >= future);
  assert.ok(BigInt(events[1].atUnixNano) >= BigInt(events[0].atUnixNano));
  assert.ok(feed.lastNano <= resumed.lastNano);
});

test("a malformed carried stamp is treated as absent rather than raising", () => {
  const { path } = opened();
  const resumed = new SessionFeed(path, "not a number");
  assert.equal(resumed.lastNano, 0n);
  assert.equal(resumed.userTurn("x"), true);
});

test("an unwritable feed reports failure instead of throwing into a hook", () => {
  const feed = new SessionFeed(join(temp(), "missing-directory", "feed.ndjson"));
  assert.equal(feed.userTurn("x"), false);
  assert.equal(feed.lineCount, 0);
});

test("session-close falls back to a stated outcome rather than an invented one", () => {
  const { path, feed } = opened();
  feed.closeSession({ outcome: "nonsense" });
  assert.equal(feedEvents(path)[1].outcome, "failed");
});
