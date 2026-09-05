// SPDX-License-Identifier: Apache-2.0

/**
 * The two-sided contract with the runtime.
 *
 * `plugin/runtime/fixtures/capture/session-claude.ndjson` is adapter output, and the runtime's
 * own suite parses, assembles, seals, and indexes it. This side asserts that the writer still
 * produces that shape, so drift on either side fails a test rather than silently breaking
 * capture for every Claude Code session.
 */

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { SessionFeed } from "../src/feed.mjs";
import { effectiveCaptureConfig } from "../src/identity.mjs";
import { feedEvents, temp } from "./helpers.mjs";

const FIXTURE = fileURLToPath(
  new URL("../../runtime/fixtures/capture/session-claude.ndjson", import.meta.url),
);

/** Stamps and instants are wall-clock, so they are the two fields the fixture cannot pin. */
const UNPINNABLE = new Set(["atUnixNano", "startedAtUnixNano", "startedAt", "endedAt"]);

function writeSession() {
  const path = join(temp("jinn-claude-seam-"), "feed.ndjson");
  writeFileSync(path, "");
  const feed = new SessionFeed(path);
  feed.openSession({
    sessionId: "s-claude",
    hostName: "claude-code",
    hostVersion: "2.1.258",
    modelProvider: "anthropic",
    modelName: "claude-opus-5",
    modelService: {
      iri: "https://spec.jinn.network/services/anthropic/claude-opus-5",
      name: "anthropic claude-opus-5",
      deployment: "api.anthropic.com",
    },
  });
  feed.repositoryState({
    repository: "https://github.com/Jinn-Network/mono",
    baseCommit: "4f0e2b7c1a9d8e3f5b6a7c8d9e0f1a2b3c4d5e6f",
    baseTree: "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567",
    branch: "autopilot/3223",
    targetBase: "next",
  });
  feed.controlledInput({
    role: "config",
    name: "effective-capture-config.json",
    mediaType: "application/json",
    content: effectiveCaptureConfig({
      model: { provider: "anthropic", name: "claude-opus-5" },
      host: { name: "claude-code", version: "2.1.258" },
      runtimePin: { package: "@jinn-network/plugin-runtime", version: "0.1.0" },
    }),
  });
  feed.controlledInput({
    role: "workflow",
    name: "CLAUDE.md",
    mediaType: "text/markdown",
    content: new TextEncoder().encode("# CLAUDE.md\n"),
  });
  feed.controlledInput({
    role: "prompt",
    name: "initial-user-prompt.md",
    mediaType: "text/markdown",
    content: new TextEncoder().encode("Implement issue #3223.\n"),
  });
  feed.environment({ tools: [], skills: [] });
  feed.userTurn("Implement issue #3223.\n");
  feed.toolCall({
    toolName: "Bash",
    toolCallId: "toolu_01capture",
    args: { command: "yarn test" },
    result: { stdout: "ok" },
    status: "ok",
  });
  feed.closeSession({ outcome: "completed", summary: "" });
  return path;
}

test("the writer still produces the shape the runtime fixture pins", () => {
  const written = feedEvents(writeSession());
  const pinned = feedEvents(FIXTURE);
  assert.equal(written.length, pinned.length);
  for (const [index, expected] of pinned.entries()) {
    const actual = written[index];
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), expected.type);
    for (const [key, value] of Object.entries(expected)) {
      if (UNPINNABLE.has(key)) continue;
      assert.deepEqual(actual[key], value, `${expected.type}.${key}`);
    }
  }
});

test("the fixture is an ordered feed whose stamps never decrease", () => {
  const pinned = feedEvents(FIXTURE);
  assert.equal(pinned[0].type, "session-open");
  assert.equal(pinned.at(-1).type, "session-close");
  for (let index = 1; index < pinned.length; index += 1) {
    assert.ok(BigInt(pinned[index].atUnixNano) >= BigInt(pinned[index - 1].atUnixNano));
  }
  // Trailing newline, no blank line anywhere: the parser refuses a feed with either wrong.
  const raw = readFileSync(FIXTURE, "utf8");
  assert.equal(raw.endsWith("\n"), true);
  assert.equal(raw.includes("\n\n"), false);
});

test("the fixture closes both of the capture gaps the protocol fixture records", () => {
  const pinned = feedEvents(FIXTURE);
  const repository = pinned.find((event) => event.type === "repository-state");
  assert.equal(repository.repository, "https://github.com/Jinn-Network/mono");
  assert.match(repository.baseCommit, /^[0-9a-f]{40}$/u);
  assert.match(repository.baseTree, /^[0-9a-f]{40}$/u);

  const bound = pinned.filter((event) => event.type === "controlled-input");
  assert.deepEqual(
    bound.map((event) => event.role).sort(),
    ["config", "prompt", "workflow"],
  );
  assert.notEqual(pinned[0].model.service, undefined);
});
