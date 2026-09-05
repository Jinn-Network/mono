// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { pluginDir } from "../src/paths.mjs";
import { RUNTIME_PACKAGE, SESSION_BIN_NAME, readPin, resolveSessionRuntime } from "../src/runtime.mjs";
import { temp } from "./helpers.mjs";

function executable(directory, name) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

function pinned(document) {
  const directory = temp();
  writeFileSync(join(directory, "runtime-pin.json"), JSON.stringify(document));
  return directory;
}

test("the shipped pin is the three-key manifest a bare clone can assert", () => {
  const pin = readPin(pluginDir());
  assert.equal(pin.package, RUNTIME_PACKAGE);
  assert.match(pin.version, /^\d+\.\d+\.\d+/u);
  assert.equal(pin.bin.endsWith(SESSION_BIN_NAME), true);
});

test("a pin that is malformed, floating, or escaping is refused", () => {
  const good = { package: RUNTIME_PACKAGE, version: "0.1.0", bin: "runtime/bin/x" };
  assert.notEqual(readPin(pinned(good)), undefined);
  for (const bad of [
    { ...good, package: "@other/thing" },
    { ...good, version: "^0.1.0" },
    { ...good, version: "0.1" },
    { ...good, bin: "/absolute/x" },
    { ...good, bin: "../escape/x" },
    { ...good, bin: "" },
  ]) {
    assert.equal(readPin(pinned(bad)), undefined, JSON.stringify(bad));
  }
  assert.equal(readPin(temp()), undefined);
});

test("the pinned artifact wins, and is reported as the product install", () => {
  const directory = pinned({ package: RUNTIME_PACKAGE, version: "0.1.0", bin: "bin/session" });
  executable(join(directory, "bin"), "session");
  const resolution = resolveSessionRuntime({}, directory);
  assert.equal(resolution.source, "pinned");
  assert.equal(resolution.detail, `${RUNTIME_PACKAGE}@0.1.0`);
  assert.deepEqual(resolution.argv, [join(directory, "bin", "session")]);
});

test("an override prefers the session sibling, and falls back to the serve argv", () => {
  const withSibling = temp();
  const tools = executable(withSibling, "jinn-plugin-runtime");
  executable(withSibling, SESSION_BIN_NAME);
  assert.deepEqual(
    resolveSessionRuntime({ JINN_PLUGIN_RUNTIME_BIN: tools }, temp()).argv,
    [join(withSibling, SESSION_BIN_NAME)],
  );

  const alone = temp();
  const bare = executable(alone, "jinn-plugin-runtime");
  const resolution = resolveSessionRuntime({ JINN_PLUGIN_RUNTIME_BIN: bare }, temp());
  assert.deepEqual(resolution.argv, [bare, "serve", "--role", "session"]);
  assert.equal(resolution.source, "env");
});

test("PATH is the last resort and is reported as one", () => {
  const directory = temp();
  executable(directory, SESSION_BIN_NAME);
  const resolution = resolveSessionRuntime({ PATH: `${temp()}:${directory}` }, temp());
  assert.equal(resolution.source, "path");
  assert.deepEqual(resolution.argv, [join(directory, SESSION_BIN_NAME)]);
});

test("no runtime resolves to nothing rather than to a guess", () => {
  assert.equal(resolveSessionRuntime({ PATH: temp() }, temp()), undefined);
  // Resolve only, never acquire: an unresolved runtime must not become an install.
  assert.equal(
    resolveSessionRuntime({ JINN_PLUGIN_RUNTIME_BIN: join(temp(), "absent") }, temp()),
    undefined,
  );
});
