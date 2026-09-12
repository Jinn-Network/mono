// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";

import { checks, doctor } from "../src/doctor.mjs";
import { fakeEnv } from "./fake.mjs";
import { temp } from "./helpers.mjs";

function named(results, name) {
  return results.find((check) => check.name === name);
}

test("a healthy environment reports the resolved runtime and the named deployment", () => {
  const results = checks(fakeEnv());
  assert.equal(named(results, "runtime-available").ok, true);
  assert.equal(named(results, "model-identity").ok, true);
  assert.equal(named(results, "runtime-pin").ok, true);
});

test("silence is made legible: every failure names one command that fixes it", () => {
  // A `claude` session that captures nothing produces no failure, just silence, which is the
  // one thing an operator cannot debug.
  const results = checks({ CLAUDE_CONFIG_DIR: temp(), PATH: temp() });
  const runtime = named(results, "runtime-available");
  assert.equal(runtime.ok, false);
  assert.match(runtime.remedy, /npm install/u);
  const model = named(results, "model-identity");
  assert.equal(model.ok, false);
  assert.match(model.remedy, /ANTHROPIC_MODEL/u);
});

test("the rendering marks each check and prints a fix under each failure", () => {
  const lines = doctor({ CLAUDE_CONFIG_DIR: temp(), PATH: temp() });
  assert.equal(
    lines.some((line) => line.startsWith("[fail] runtime-available:")),
    true,
  );
  assert.equal(
    lines.some((line) => line.trim().startsWith("fix:")),
    true,
  );
  assert.equal(
    doctor(fakeEnv()).some((line) => line.trim().startsWith("fix:")),
    false,
  );
});
