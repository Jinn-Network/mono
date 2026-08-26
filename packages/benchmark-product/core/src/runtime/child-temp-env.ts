// The temp-directory variables a spawned child needs, for the two things a caller can mean by
// "where does this child write its scratch files".
//
// Every `spawn`/`execFile` site in this package hands the child an explicit `env` allowlist rather
// than `process.env`, which is the right default — no ambient credential crosses a harness
// boundary that way. It also means a child inherits nothing the allowlist does not name, and
// `TMPDIR`/`TMP`/`TEMP` were named nowhere. A child that inherits no temp variable falls back to
// the platform default (`/tmp`, or `/var/folders/…` on macOS) and writes outside whatever root its
// parent was confined to — under the Vitest seam in `test-support/tmp-isolation/`, that is the one
// escape the per-run sweep cannot follow, and in production it is scratch space nothing cleans up.
//
// All three names, not just `TMPDIR`: `os.tmpdir()` reads `TMPDIR` on POSIX and `TEMP`/`TMP` on
// Windows, and Python's `tempfile` consults all three on every platform. Setting one of three
// leaves the other two pointing at the platform default for whichever runtime the child happens to
// be.

/** The three names every runtime this package spawns consults for its scratch directory. */
const TEMP_VARIABLES = ["TMPDIR", "TMP", "TEMP"] as const;

/**
 * The caller's own temp directory, for a child that should write where its parent writes — a
 * version probe, a readiness check, a harness run whose output the caller collects afterwards.
 *
 * Spread into the allowlist rather than assigned over it, so a site that pins its own temp
 * directory after the spread still wins.
 */
export function inheritedTempEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const name of TEMP_VARIABLES) {
    const value = source[name];
    // Absent rather than empty: an empty `TMPDIR` is not "use the default", it is a relative path,
    // and a child that resolves it writes into its own working directory.
    if (typeof value === "string" && value.length > 0) inherited[name] = value;
  }
  return inherited;
}

/**
 * A directory the child must write its scratch files into, for a launcher that owns an attempt
 * workspace and collects `paths.tmp` as part of the run.
 */
export function scopedTempEnv(directory: string): Record<string, string> {
  return Object.fromEntries(TEMP_VARIABLES.map((name) => [name, directory]));
}
