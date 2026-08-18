// Per-run sweep of the temp roots the workers create. Wired as the Vitest `globalSetup` entry in
// `vitest.config.ts`.
//
// `isolate-tmp.ts` gives every test *file* its own managed root and sweeps it in `afterAll`. That
// covers files that pass and files that fail, but not a file whose tests are all skipped: Vitest
// runs no suite there, so no `afterAll` fires and the file's root outlives the run. The suite's
// fully-skipped files therefore left one empty `jinn-vitest-tmp-*` directory each behind on every
// `yarn test`, and a hard-killed worker or a Ctrl-C left whatever it had written.
//
// `globalSetup` closes that. It runs in the MAIN process before any worker is forked, and the
// teardown it returns runs there too, after every worker is gone — the one place that can clean up
// after a worker which never reached its own sweep.
//
// It works as a REGISTRY rather than by nesting the roots inside a per-run parent directory, which
// would be the obvious shape. Nesting is not available across these suites: macOS truncates a
// unix-domain socket path at 104 bytes, `spawn`ed children inherit `$TMPDIR`, and a suite that
// spawns a tool binding `$TMPDIR/<tool>/<pid>.sock` is already close to that limit with the
// managed root alone. One more directory level pushes it past, the kernel truncates the pid off
// the end, and two concurrent children collide on the same truncated name. Registering the roots
// instead of containing them keeps every path exactly the length it is today.
//
// A worker records its root by writing one small file here, named after the root's basename. The
// teardown reads them back and removes each recorded tree. A worker killed between creating its
// root and recording it — a window of microseconds — is the one case this cannot cover.
//
// This file is duplicated verbatim in `packages/task-execution/evaluator-adapters`, alongside the
// other two files of this seam. Graduate the set to a shared package at a third consumer.
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MANAGED_ROOT_PREFIX, sweepManagedTree } from "./sweep-tree.js";

export default function setup(): () => void {
  const registry = mkdtempSync(join(tmpdir(), "jinn-vitest-run-"));

  /** The directory each test file records its managed root in. */
  process.env["JINN_TEST_RUN_TMPDIR"] = registry;

  function sweepRegisteredRoots(): void {
    let entries: string[];
    try {
      entries = readdirSync(registry);
    } catch {
      return; // Already gone: a second call, or the run root was removed by hand.
    }
    for (const entry of entries) {
      let recorded: string;
      try {
        recorded = readFileSync(join(registry, entry), "utf8").trim();
      } catch {
        continue; // A half-written record names nothing removable.
      }
      // These paths drive a recursive removal, so only honour what a worker could legitimately
      // have written: something strictly inside the temp directory this process also sees.
      if (recorded.startsWith(join(tmpdir(), MANAGED_ROOT_PREFIX))) {
        sweepManagedTree(recorded, "managed temp root");
      }
    }
    sweepManagedTree(registry, "per-run temp registry");
  }

  // `vitest run` installs no handler for any of these, so each one kills this process under the
  // default disposition and the teardown below never runs — measured, not assumed: a SIGTERM
  // mid-run left the per-run registry holding every record written so far and every root it named
  // unswept. SIGINT is Ctrl-C; SIGTERM is what a CI cancellation, `timeout(1)` and process
  // supervisors send, which is the common case on a build runner; SIGHUP is a closed terminal.
  // SIGKILL cannot be caught at all and stays outside what this can cover.
  //
  // One `once` listener per signal closes the gap. Each sweeps and then exits with the same
  // `128 + signum` the default disposition would have produced, and because each is `once`, a
  // second identical signal still terminates by default.
  const interruptHandlers = (
    [
      ["SIGHUP", 1],
      ["SIGINT", 2],
      ["SIGTERM", 15],
    ] as const
  ).map(([signal, signum]) => {
    const sweepOnInterrupt = (): void => {
      sweepRegisteredRoots();
      process.exit(128 + signum);
    };
    process.once(signal, sweepOnInterrupt);
    return { signal, sweepOnInterrupt };
  });

  return () => {
    for (const { signal, sweepOnInterrupt } of interruptHandlers) {
      process.off(signal, sweepOnInterrupt);
    }
    sweepRegisteredRoots();
  };
}
