/**
 * The backend's own capture of the harness's stdio (#2538 F5).
 *
 * The shim can redirect the harness's stdout/stderr into `logs/`, which is backend-written and
 * outside the executor's write surface (design §7.1). Nothing passed those paths before, so every
 * launcher's output went to `ignore` — live, the prediction launcher wrote a precise diagnostic to
 * stderr and the attempt's `logs/` was empty, which sent a whole diagnosis down the wrong path.
 *
 * These two files are backend state, like `meta/`, not executor Results: `harvest` collects the
 * rest of `logs/` into the manifest (and from there into the signed Delivery's `outputs`), and the
 * backend's own copy of whatever the harness happened to print does not belong in a published,
 * content-addressed artifact list. `harvest` skips exactly these two names at the root of `logs/`;
 * anything the HARNESS itself writes under `logs/` is still collected exactly as before.
 */

export const HARNESS_STDOUT_LOG = "harness.stdout.log";
export const HARNESS_STDERR_LOG = "harness.stderr.log";

/** The backend-written stdio captures, excluded from the harvested manifest. */
export const BACKEND_WRITTEN_LOG_FILENAMES: readonly string[] = [
  HARNESS_STDOUT_LOG,
  HARNESS_STDERR_LOG,
];
