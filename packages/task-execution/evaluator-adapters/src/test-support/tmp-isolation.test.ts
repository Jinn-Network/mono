import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";

// Safe to import: unlike the setup file, this module performs nothing at import time — the root is
// only created when `setup()` is called. The wiring assertions below still read the environment,
// so deleting the `globalSetup` entry turns this file red.
import globalTmpRootSetup from "./global-tmp-root.js";
import { MANAGED_ROOT_PREFIX } from "./sweep-tree.js";

// The suite's `jinn-container-grader-*` roots were created straight in the user temp directory and
// survived any failing run. `src/test-support/isolate-tmp.ts` now redirects `$TMPDIR` at one
// managed root per test file and sweeps it on teardown, so every `mkdtemp(join(tmpdir(), …))` is
// removed with it. `src/test-support/global-tmp-root.ts` records that root in a per-run registry
// and sweeps every recorded root after the workers exit, so a file whose tests are all skipped —
// which never fires an `afterAll` — leaves nothing behind either.
//
// This file deliberately does NOT import the shim — importing it would perform the redirect, and
// the test would then pass even with the `setupFiles` wiring deleted. It reads the path the shim
// publishes as an environment variable instead, so removing the wiring turns this file red.
const managedTmp = process.env["JINN_TEST_TMPDIR"];
const runRegistry = process.env["JINN_TEST_RUN_TMPDIR"];

describe("test tmpdir isolation", () => {
  it("is wired as a suite-wide setup file", () => {
    expect(managedTmp, "src/test-support/isolate-tmp.ts is not in vitest setupFiles").toBeTypeOf("string");
  });

  it("is wired as a global setup file", () => {
    // Only `global-tmp-root.ts` publishes this, and only Vitest's `globalSetup` hook runs it, so
    // an absent value means the `globalSetup` entry is gone from vitest.config.ts.
    expect(runRegistry, "src/test-support/global-tmp-root.ts is not in vitest globalSetup").toBeTypeOf(
      "string",
    );
  });

  it("registers its managed root with the per-run teardown", () => {
    // Nesting the root inside a per-run parent would be the obvious shape, and is not available
    // here — see `global-tmp-root.ts` on the 104-byte unix-socket path limit. The registry file is
    // what the per-run teardown reads, so its presence is the wiring this suite depends on.
    const recorded = join(String(runRegistry), basename(String(managedTmp)));
    expect(existsSync(recorded), `${managedTmp} is not registered in ${runRegistry}`).toBe(true);
    expect(readFileSync(recorded, "utf8")).toBe(managedTmp);
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
    // backstop can. That backstop is best-effort — measured, it fires for a file that throws at
    // import time and not for a fully-skipped one — so this asserts only that it is still
    // registered. The guarantee lives in the per-run teardown asserted below.
    expect(process.listeners("exit").some((fn) => fn.name === "jinnTestTmpdirSweep")).toBe(true);
  });

  it("removes every registered root on teardown", () => {
    // Vitest calls this teardown in the main process once every worker is gone, which is why it
    // catches roots no worker swept. It cannot be observed from inside a worker, so the function
    // is driven directly here: `setup()` builds a fresh registry, this registers a throwaway root
    // holding a sealed subtree the way the venue provisioner does, and the returned teardown has
    // to remove both the root and the registry.
    const previous = process.env["JINN_TEST_RUN_TMPDIR"];
    try {
      const teardown = globalTmpRootSetup();
      const registry = String(process.env["JINN_TEST_RUN_TMPDIR"]);
      expect(registry).not.toBe(previous);

      // Created next to the real managed roots, because the teardown deliberately only honours
      // recorded paths under `tmpdir()` with the expected prefix.
      const orphan = mkdtempSync(join(tmpdir(), MANAGED_ROOT_PREFIX));
      const sealed = join(orphan, "attempt", "input");
      mkdirSync(sealed, { recursive: true });
      writeFileSync(join(sealed, "dispatch-context.json"), "{}", { mode: 0o400 });
      chmodSync(sealed, 0o500);
      writeFileSync(join(registry, basename(orphan)), orphan);

      teardown();

      expect(existsSync(orphan), "the registered root survived teardown").toBe(false);
      expect(existsSync(registry), "the registry survived teardown").toBe(false);
    } finally {
      // Sibling test files share this worker process and read the variable at setup time, so it
      // must go back exactly as it was — including the case where it was unset.
      if (previous === undefined) delete process.env["JINN_TEST_RUN_TMPDIR"];
      else process.env["JINN_TEST_RUN_TMPDIR"] = previous;
    }
  });
});
