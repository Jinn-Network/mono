// SPDX-License-Identifier: Apache-2.0

import {
  chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync,
  mkdirSync, openSync, readFileSync, realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { refuse, unavailable } from "./errors.js";

function refuseSymlink(path: string): void {
  if (lstatSync(path).isSymbolicLink()) {
    refuse(`grader path "${path}" is a symbolic link`);
  }
}

/**
 * Resolve only an OS-controlled root alias such as macOS `/var` -> `/private/var`. Every other
 * symlink in the path's lineage is left alone so the lineage walk below can still refuse it.
 * Ported from `packages/policy-optimization/src/host-local/state.ts:47-54`; without this, the
 * lineage walk in `ensurePrivateDirectory` refuses any macOS temp path outright, because `/var`
 * itself is a symlink.
 */
function resolveRootAlias(path: string): string {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const [first, ...rest] = relative(root, absolute).split(sep);
  if (first === undefined || first.length === 0) return absolute;
  const firstPath = join(root, first);
  return existsSync(firstPath) && lstatSync(firstPath).isSymbolicLink()
    ? resolve(realpathSync(firstPath), ...rest)
    : absolute;
}

/** Creates (or adopts) a 0700 directory, refusing any symlink in its lineage. */
export function ensurePrivateDirectory(path: string): string {
  if (!isAbsolute(path)) refuse("grader path must be absolute");
  const absolute = resolveRootAlias(path);
  const lineage: string[] = [];
  for (let current = absolute; ; current = dirname(current)) {
    lineage.unshift(current);
    if (dirname(current) === current) break;
  }
  for (const directory of lineage) {
    if (existsSync(directory)) {
      refuseSymlink(directory);
      if (!lstatSync(directory).isDirectory()) {
        refuse("grader path crosses a non-directory");
      }
      continue;
    }
    mkdirSync(directory, { mode: 0o700 });
    refuseSymlink(directory);
  }
  if (!lstatSync(absolute).isDirectory()) refuse("grader path is not a directory");
  chmodSync(absolute, 0o700);
  return absolute;
}

/** Exact no-follow read of a regular file. */
export function secureRead(path: string): Uint8Array {
  const absolute = resolve(path);
  refuseSymlink(absolute);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(descriptor).isFile()) refuse("grader artifact is not a regular file");
    return new Uint8Array(readFileSync(descriptor));
  } catch (cause) {
    if (cause instanceof Error && cause.name === "EvaluationOperationalError") throw cause;
    return unavailable("grader output could not be read", cause);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
