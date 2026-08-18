import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// The suite's `jinn-container-grader-*` roots were created straight in the user temp directory and
// survived any failing run. `src/test-support/isolate-tmp.ts` now redirects `$TMPDIR` at one
// managed root per test file and sweeps it on teardown, so every `mkdtemp(join(tmpdir(), …))` is
// removed with it.
//
// This file deliberately does NOT import the shim — importing it would perform the redirect, and
// the test would then pass even with the `setupFiles` wiring deleted. It reads the path the shim
// publishes as an environment variable instead, so removing the wiring turns this file red.
const managedTmp = process.env["JINN_TEST_TMPDIR"];

describe("test tmpdir isolation", () => {
  it("is wired as a suite-wide setup file", () => {
    expect(managedTmp, "src/test-support/isolate-tmp.ts is not in vitest setupFiles").toBeTypeOf("string");
  });

  it("redirects os.tmpdir() at the managed root", () => {
    expect(tmpdir()).toBe(managedTmp);
  });

  it("creates every mkdtemp directory inside the managed root", () => {
    const probe = mkdtempSync(join(tmpdir(), "probe-"));
    try {
      expect(probe.startsWith(String(managedTmp))).toBe(true);
    } finally {
      rmSync(probe, { recursive: true, force: true });
    }
  });

  it("registers the teardown that sweeps the managed root", () => {
    // The `afterAll` half cannot be observed from inside a test, but the `process.on("exit")`
    // backstop can. Asserting on the listener is what proves the teardown survives a test file
    // that throws at import time — the case `afterAll` cannot cover.
    expect(process.listeners("exit").some((fn) => fn.name === "jinnTestTmpdirSweep")).toBe(true);
  });
});
