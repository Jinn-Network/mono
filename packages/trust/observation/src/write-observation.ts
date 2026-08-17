// SPDX-License-Identifier: Apache-2.0

import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { z } from "zod";

/**
 * Class O (observation) container primitive
 * (docs/superpowers/specs/2026-08-04-headless-operator-rederivation-design.md §7).
 *
 * Zod-validate the value against the caller's schema, mkdir the parent directory,
 * write the serialized result to a uniquely-named temp file with `wx` and mode
 * 0600 by default, fsync the file, rename into place, chmod the target, then
 * fsync the parent directory.
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
  const contents = `${JSON.stringify(schema.parse(value), null, 2)}\n`;
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const fd = openSync(temporaryPath, "wx", mode);
  try {
    writeFileSync(fd, contents);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temporaryPath, { force: true });
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
  chmodSync(path, mode);
  const directoryFd = openSync(directory, "r");
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
}
