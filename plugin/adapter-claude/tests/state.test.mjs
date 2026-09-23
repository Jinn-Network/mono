// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { stateDir } from "../src/paths.mjs";
import { clearState, readState, sessionStatePath, writeState } from "../src/state.mjs";
import { temp } from "./helpers.mjs";

test("the state file is named by a digest, so no host string is ever a path component", () => {
  const env = { CLAUDE_CONFIG_DIR: temp() };
  for (const hostile of ["../../escape", "a/b", "..", "with space", "~/.ssh/id_rsa"]) {
    const path = sessionStatePath(hostile, env);
    assert.equal(path.startsWith(join(stateDir(env), "sessions")), true, hostile);
    assert.match(path, /\/[0-9a-f]{32}\.json$/u);
  }
  // Distinct ids stay distinct; one id is stable across processes.
  assert.notEqual(sessionStatePath("a", env), sessionStatePath("b", env));
  assert.equal(sessionStatePath("a", env), sessionStatePath("a", env));
});

test("state round-trips and is written owner-only", () => {
  const path = sessionStatePath("s", { CLAUDE_CONFIG_DIR: temp() });
  assert.equal(writeState(path, { captureSessionId: "cap-1", feedPath: "/f" }), true);
  assert.deepEqual(readState(path), { captureSessionId: "cap-1", feedPath: "/f" });
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("absent, unreadable, or shapeless state is absent, never a raise", () => {
  const directory = temp();
  assert.equal(readState(join(directory, "missing.json")), undefined);
  const broken = join(directory, "broken.json");
  writeFileSync(broken, "{not json");
  assert.equal(readState(broken), undefined);
  const array = join(directory, "array.json");
  writeFileSync(array, "[1,2]");
  assert.equal(readState(array), undefined);
  const scalar = join(directory, "scalar.json");
  writeFileSync(scalar, "null");
  assert.equal(readState(scalar), undefined);
});

test("an unwritable state reports failure rather than throwing into a hook", () => {
  const directory = temp();
  writeFileSync(join(directory, "file.json"), "{}");
  assert.equal(writeState(join(directory, "file.json", "nested.json"), {}), false);
});

test("clearing is idempotent and never raises", () => {
  const path = sessionStatePath("s", { CLAUDE_CONFIG_DIR: temp() });
  writeState(path, { a: 1 });
  clearState(path);
  assert.equal(existsSync(path), false);
  clearState(path);
});

test("the Claude home is the profile switch, so two homes never share an archive", () => {
  const first = { CLAUDE_CONFIG_DIR: temp() };
  const second = { CLAUDE_CONFIG_DIR: temp() };
  assert.notEqual(sessionStatePath("s", first), sessionStatePath("s", second));
});
