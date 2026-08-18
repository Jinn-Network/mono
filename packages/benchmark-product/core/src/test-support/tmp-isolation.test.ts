import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// The suite's `benchmark-product-*`, `provisioner-*` and `sample-repository-work-*` roots were
// created straight in the user temp directory and survived any failing run.
// `src/test-support/isolate-tmp.ts` now redirects `$TMPDIR` at one managed root per test file and
// sweeps it on teardown, so every `mkdtemp(join(tmpdir(), …))` is removed with it.
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

  // Declared last on purpose: it runs the sweep for real, which removes the managed root the
  // earlier cases depend on.
  it("sweeps a root holding a sealed input/ directory", () => {
    // The venue provisioner seals each attempt's `input/` read-only — directories 0o500, files
    // 0o400 — so the solver process cannot rewrite its own dispatch context. A plain
    // `rmSync(recursive, force)` cannot remove that tree: `unlink` needs the write bit on the
    // parent directory and `force` only suppresses ENOENT. That is the exact failure that blocked
    // this suite's isolation, so the sweep repairs permissions before retrying.
    //
    // Re-asserted as a precondition so an unwired run fails here rather than sealing a directory
    // relative to the package root.
    expect(managedTmp, "src/test-support/isolate-tmp.ts is not in vitest setupFiles").toBeTypeOf("string");
    const root = String(managedTmp);
    const sealed = join(root, "attempt-probe", "input");
    mkdirSync(sealed, { recursive: true });
    writeFileSync(join(sealed, "dispatch-context.json"), "{}", { mode: 0o400 });
    chmodSync(sealed, 0o500);

    // Skipped as root, where the kernel waives the permission check and there is no bug to
    // reproduce. Everywhere else this is what makes the assertion below discriminating.
    if (process.getuid?.() !== 0) {
      expect(() => rmSync(sealed, { recursive: true, force: true })).toThrow();
    }

    // The shim exports nothing on purpose, so the sweep is reached through the `exit` listener it
    // registers. Vitest reuses a worker process across test files, so several may be registered;
    // the most recently added one belongs to this file's setup. A wrong pick leaves the root in
    // place and fails the assertion below rather than passing quietly.
    const sweeps = process.listeners("exit").filter((fn) => fn.name === "jinnTestTmpdirSweep");
    (sweeps[sweeps.length - 1] as () => void)();

    expect(existsSync(root)).toBe(false);

    // Put the managed root back: `os.tmpdir()` still points at it for the rest of this process,
    // and the `afterAll` sweep runs against it again (a no-op on an empty directory).
    mkdirSync(root, { recursive: true });
  });
});
