// Per-run sweep of the temp roots the workers create. Wired as the Vitest `globalSetup` entry in
// `vitest.config.ts`.
//
// `isolate-tmp.ts` gives every test *file* its own managed root and sweeps it in `afterAll`. That
// covers files that pass and files that fail, but not a file whose tests are all skipped: Vitest
// runs no suite there, so no `afterAll` fires and the file's root outlives the run. The suite's
// fully-skipped files therefore left one empty `jinn-tmp-*` directory each behind on every
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
// instead of containing them keeps every path as short as it can be; `sweep-tree.ts` carries the
// budget check that fails loudly rather than letting a shortfall surface as an unrelated EEXIST.
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

import { isSweepableRecord, sweepManagedTree } from "./sweep-tree.js";

interface RunState {
  registry: string;
  teardown: () => void;
}

// Vitest can run one `globalSetup` entry more than once per run in the SAME process: a config that
// declares a `projects` array whose entries set `extends: true` has the root config and every
// project invoke this file. Measured on such a config, both invocations report the same pid and
// each gets its OWN module instance — module scope cannot see the other — while `globalThis` is
// shared, which is why the live state hangs off it.
//
// Without this guard the second invocation replaced `JINN_TEST_RUN_TMPDIR` with a second, empty
// registry (so every worker recorded into the empty one) and installed a second set of interrupt
// handlers. Node runs `once` listeners in registration order, the first set calls `process.exit`,
// and that aborts the emit loop before the set holding the populated registry ever runs — so a
// SIGTERM mid-run swept nothing at all.
const RUN_STATE: unique symbol = Symbol.for("jinn.test.global-tmp-root");
const realm = globalThis as typeof globalThis & { [RUN_STATE]?: RunState };

export default function setup(): () => void {
  const live = realm[RUN_STATE];
  if (live !== undefined) {
    // Re-publish rather than re-create: one registry, one handler set, one teardown per run.
    process.env["JINN_TEST_RUN_TMPDIR"] = live.registry;
    return live.teardown;
  }

  // Captured once, here, and handed to the workers. They create their roots under this exact
  // string and the guard below admits records under this exact string, so the writer's base and
  // the reader's base cannot diverge. It also gives a reused worker — `--no-isolate`, where the
  // setup file re-runs in a process whose own `$TMPDIR` already points into the previous,
  // already-swept root — a base that still exists.
  const hostTmpdir = tmpdir();
  const registry = mkdtempSync(join(hostTmpdir, "jinn-vitest-run-"));

  /** The temp directory the workers create their managed roots in. */
  process.env["JINN_TEST_HOST_TMPDIR"] = hostTmpdir;
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
      // have written: a tree that resolves to somewhere strictly inside `hostTmpdir`, under a
      // component this suite named. `isSweepableRecord` normalises `..` away first — a raw prefix
      // test does not, and admits a record that escapes the temp directory entirely.
      if (isSweepableRecord(recorded, hostTmpdir)) {
        sweepManagedTree(recorded, "managed temp root");
      }
    }
    sweepManagedTree(registry, "per-run temp registry");
  }

  // Vitest's own `BaseReporter` installs `process.once` listeners for SIGINT and SIGTERM — verified
  // against the installed vitest 4.1.10, `dist/chunks/cli-api.*.js`, `addCleanupListeners` — and
  // none for SIGHUP. Those listeners restore the terminal and schedule `process.exit()`; they do
  // not run a `globalSetup` teardown, so the teardown below never fires on any of the three —
  // measured, not assumed: a SIGTERM mid-run left the per-run registry holding every record written
  // so far and every root it named unswept. SIGINT is Ctrl-C; SIGTERM is what a CI cancellation,
  // `timeout(1)` and process supervisors send, which is the common case on a build runner; SIGHUP
  // is a closed terminal. SIGKILL cannot be caught at all and stays outside what this can cover.
  //
  // One `once` listener per signal closes the gap. Each sweeps and then exits with the same
  // `128 + signum` the default disposition would have produced, and because each is `once`, a
  // second identical signal still terminates by default. The sweep is synchronous, so it finishes
  // inside the emit loop even though Vitest's listener has already scheduled an exit of its own.
  //
  // Best-effort, not a guarantee, and the residue is bounded: measured on a mid-run SIGTERM of the
  // operator suite, which carries the same seam, the registry held 25 roots and the handler removed
  // 23. The two survivors were roots a worker was still writing into as the main process swept, and
  // it recreated the tree beneath the removal — a race the main process cannot win, since the
  // workers outlive its handler by design. SIGKILL — and a machine that loses power — additionally
  // strands one `jinn-vitest-run-*` registry, since no later run adopts an older one. That registry
  // holds nothing but a few small record files.
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

  const teardown = (): void => {
    delete realm[RUN_STATE];
    for (const { signal, sweepOnInterrupt } of interruptHandlers) {
      process.off(signal, sweepOnInterrupt);
    }
    sweepRegisteredRoots();
  };

  realm[RUN_STATE] = { registry, teardown };
  return teardown;
}
