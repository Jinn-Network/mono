import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Class O (observation) container primitive
 * (docs/superpowers/specs/2026-08-04-headless-operator-rederivation-design.md §7/§14.7).
 *
 * Every Class O writer in this repo hand-rolled the same atomic-rename idiom, and one of them
 * (`phase-d-transition-usage.ts`) dropped the restrictive mode along the way — its temp file
 * defaulted to 0644, and the rename preserved that leak straight through to the durable file.
 * This is the one place the idiom is implemented: mkdir the parent directory, write to a
 * pid+timestamp-scoped temp file with `wx` (never silently clobber a concurrent writer) and mode
 * 0600 by default, rename into place, then clean up the temp file. Mode is a tested assertion,
 * not a convention (see `write-observation.test.ts`).
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
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporaryPath, contents, { flag: 'wx', mode });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}
