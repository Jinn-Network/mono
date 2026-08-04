import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Class O (observation) container primitive
 * (docs/superpowers/specs/2026-08-04-headless-operator-rederivation-design.md §7/§14.7).
 *
 * Every Class O writer in this repo hand-rolled the same atomic-rename idiom, and one of them
 * (`phase-d-transition-usage.ts`) dropped the restrictive mode along the way — its temp file
 * defaulted to 0644, and the rename preserved that leak straight through to the durable file.
 * This is the one Class O container: mkdir the parent directory, write to a uniquely-named temp
 * file with `wx` (never silently clobber a concurrent writer) and mode 0600 by default, fsync the
 * file, rename into place, chmod the target to the requested mode (independent of the process
 * umask), then fsync the parent directory so the rename itself is durable. Mode is a tested
 * assertion, not a convention (see `write-observation.test.ts`). The temp name is
 * `crypto.randomUUID()`-scoped rather than `pid+Date.now()`-scoped: a pid and a millisecond clock
 * tick are not unique across containers/hosts, and a collision there is destructive — the loser's
 * `wx` open fails EEXIST, and a naive cleanup on that failure would delete the winner's
 * still-in-flight temp file out from under it. This mirrors (and is intentionally weaker than,
 * for now — see issue #2409's follow-up scope) `client/src/config/atomic-write.ts`'s discipline,
 * the stronger sibling of this idiom for config files.
 *
 * Deliberately import-free of daemon/api/cli — this module is an extractable boundary (issue
 * #2409); a later stage moves it beside the trust core (`packages/trust/core`) once Class A
 * receipts exist to share a container profile with.
 */
export interface WriteObservationOptions {
  readonly mode?: number;
}

export function writeObservation(
  path: string,
  contents: string,
  { mode = 0o600 }: WriteObservationOptions = {},
): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const fd = openSync(temporaryPath, 'wx', mode);
  try {
    writeFileSync(fd, contents);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temporaryPath, { force: true });
    throw error;
  }
  closeSync(fd);
  renameSync(temporaryPath, path);
  // Independent of the open() mode above, which is subject to the process umask (a restrictive
  // umask like 0077 would otherwise silently mask group bits off an explicit override).
  chmodSync(path, mode);
  const directoryFd = openSync(directory, 'r');
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
}
