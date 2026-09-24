// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { readPin } from "../src/runtime.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const readme = readFileSync(join(root, "README.md"), "utf8");

test("every hook the adapter implements is wired, and to one entry", () => {
  const manifest = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.name, "jinn");
  assert.equal(manifest.hooks, "./hooks/hooks.json");

  const { hooks } = JSON.parse(readFileSync(join(root, "hooks", "hooks.json"), "utf8"));
  assert.deepEqual(Object.keys(hooks).sort(), [
    "PostToolUse",
    "SessionEnd",
    "SessionStart",
    "UserPromptSubmit",
  ]);
  for (const [event, matchers] of Object.entries(hooks)) {
    for (const matcher of matchers) {
      for (const entry of matcher.hooks) {
        assert.equal(entry.type, "command", event);
        // `CLAUDE_PLUGIN_ROOT` is the only path the plugin may name: the install location is
        // the host's to choose, and a hard-coded one would work on exactly one machine.
        assert.match(entry.command, /\$\{CLAUDE_PLUGIN_ROOT\}\/src\/main\.mjs/u);
      }
    }
  }
});

test("the adapter carries no npm manifest, because it is installed by clone", () => {
  // Claude Code installs a plugin by cloning it and runs no dependency install, so a manifest
  // would promise an install step that never happens. The plugin-tree guards key on
  // `package.json`, so its absence is also what keeps this directory out of the npm inventory.
  assert.equal(existsSync(join(root, "package.json")), false);
  execFileSync(process.execPath, [join(root, "scripts", "check-stdlib-only.mjs")], {
    stdio: "ignore",
  });
});

test("the pinned runtime version in the README matches the pin the adapter asserts", () => {
  const pin = readPin(root);
  assert.equal(readme.includes(`${pin.package}@${pin.version}`), true);
});

test("the README does not quote an install command the channel cannot yet serve", () => {
  // Publication to a plugin marketplace is not part of this adapter; a quoted command that
  // resolves nothing would be a claim the repository cannot back.
  assert.equal(readme.includes("claude plugin install"), false);
  assert.match(readme, /not yet published to a plugin marketplace/u);
});

test("the README states the privacy posture rather than leaving it to be discovered", () => {
  assert.match(readme, /owner-only/u);
  assert.match(readme, /does not\s+scrub at capture time/u);
});

test("the README names the selection rule's every role, including the one it omits", () => {
  for (const role of ["`config`", "`workflow`", "`prompt`", "`skill`"]) {
    assert.equal(readme.includes(role), true, role);
  }
  assert.match(readme, /Nothing is bound for the `skill` role/u);
});

test("the README names both limits of the trace rather than implying completeness", () => {
  assert.match(readme, /Assistant turns and token counts/u);
  assert.match(readme, /A success verdict/u);
  assert.match(readme, /stranded-feed sweep/u);
});

test("the README states the four rules the adapter holds", () => {
  for (const rule of [
    "No hook ever fails into the host",
    "degrades the product to silence",
    "No feed-derived value reaches the filesystem as a path",
    "No host-controlled string can forge",
  ]) {
    assert.equal(readme.includes(rule), true, rule);
  }
});
