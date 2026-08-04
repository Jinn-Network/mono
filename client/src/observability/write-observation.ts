import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { z } from 'zod';

/**
 * Class O (observation) container primitive
 * (docs/superpowers/specs/2026-08-04-headless-operator-rederivation-design.md §7/§14.7).
 *
 * Every Class O writer in this repo hand-rolled the same atomic-rename idiom, and one of them
 * (`phase-d-transition-usage.ts`) dropped the restrictive mode along the way — its temp file
 * defaulted to 0644, and the rename preserved that leak straight through to the durable file.
 * This is the one Class O container: Zod-validate the value against the caller's schema (AC1:
 * "versioned-Zod-strict" — a cyclic, unserializable, or shape-drifted value never touches the
 * filesystem), mkdir the parent directory, write the serialized result to a uniquely-named temp
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
 * The schema is a caller-supplied parameter, not a helper-owned import: this keeps the container
 * generic and extractable rather than coupling it to any one writer's domain shape. Reader-side
 * validation (parsing a Class O file back in) is explicitly out of scope here and stays
 * hand-rolled at each reader for now — folding readers onto the same schemas is a follow-up.
 *
 * Deliberately import-free of daemon/api/cli — this module is an extractable boundary (issue
 * #2409); a later stage moves it beside the trust core (`packages/trust/core`) once Class A
 * receipts exist to share a container profile with.
 */
export interface WriteObservationOptions {
  readonly mode?: number;
}

export function writeObservation<T>(
  path: string,
  schema: z.ZodType<T>,
  value: T,
  { mode = 0o600 }: WriteObservationOptions = {},
): void {
  // Validate and serialize before any filesystem call: an invalid value must never partially
  // land, and a serialization failure (a cyclic value slipping past a lenient schema) must not
  // leave a temp file behind.
  const contents = `${JSON.stringify(schema.parse(value), null, 2)}\n`;
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
