// SPDX-License-Identifier: MIT

/**
 * A small, total argument parser, and the file readers the verbs share.
 *
 * Deliberately not a dependency. The whole grammar is `<group> <verb> --flag value` with
 * `--flag=value` and repeatable flags, and a parser library would be a runtime edge in a package
 * whose dependency graph is an audited list (`policy-optimization-package-inventory.test.mjs`)
 * rather than a default.
 *
 * Two rules the parser enforces so the verbs do not have to:
 *
 * - **An unknown flag is refused**, never ignored. A mistyped `--campaing-dir` that silently fell
 *   through to a default would run the wrong campaign, and the operator would find out from the
 *   journal.
 * - **A repeated single-valued flag is refused.** `--dir a --dir b` has no obvious winner, and
 *   picking one is picking one silently.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { refuse } from "../errors.js";

export interface ParsedArgs {
  /** Positional words before the first flag — `["campaign", "create"]`. */
  readonly words: readonly string[];
  readonly flags: ReadonlyMap<string, readonly string[]>;
}

/** Flags that may appear more than once; every other flag is single-valued. */
const REPEATABLE = new Set(["seed", "approve-payload-class", "payload-class"]);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const words: string[] = [];
  const flags = new Map<string, string[]>();
  let index = 0;

  while (index < argv.length && !argv[index]!.startsWith("--")) {
    words.push(argv[index]!);
    index += 1;
  }
  while (index < argv.length) {
    const token = argv[index]!;
    if (!token.startsWith("--")) {
      refuse("invalid-document", token, `unexpected argument "${token}"; flags come after the verb`);
    }
    const equals = token.indexOf("=");
    const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
    let value: string;
    if (equals !== -1) {
      value = token.slice(equals + 1);
      index += 1;
    } else {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        // A valueless flag is a boolean; the empty string is its presence marker.
        value = "";
        index += 1;
      } else {
        value = next;
        index += 2;
      }
    }
    const existing = flags.get(name);
    if (existing === undefined) {
      flags.set(name, [value]);
    } else if (REPEATABLE.has(name)) {
      existing.push(value);
    } else {
      refuse("invalid-document", `--${name}`,
        `--${name} was supplied more than once and takes a single value`);
    }
  }
  return { words, flags };
}

export function assertKnownFlags(args: ParsedArgs, known: readonly string[]): void {
  const allowed = new Set(known);
  for (const name of args.flags.keys()) {
    if (!allowed.has(name)) {
      refuse("invalid-document", `--${name}`,
        `unknown flag --${name}; this verb takes ${known.map((flag) => `--${flag}`).join(", ")}`);
    }
  }
}

export function optional(args: ParsedArgs, name: string): string | undefined {
  const values = args.flags.get(name);
  return values === undefined ? undefined : values[values.length - 1];
}

export function required(args: ParsedArgs, name: string): string {
  const value = optional(args, name);
  if (value === undefined || value === "") {
    refuse("invalid-document", `--${name}`, `--${name} is required`);
  }
  return value;
}

export function many(args: ParsedArgs, name: string): readonly string[] {
  return args.flags.get(name) ?? [];
}

export function present(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}

/** Resolves a path against the invocation's working directory. */
export function pathFrom(cwd: string, value: string): string {
  return isAbsolute(value) ? value : resolve(cwd, value);
}

export function readBytes(path: string): Uint8Array {
  try {
    return new Uint8Array(readFileSync(path));
  } catch {
    refuse("invalid-document", path, `cannot read ${path}`);
  }
}

export function readJson(path: string): unknown {
  const bytes = readBytes(path);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    refuse("invalid-document", path, `${path} is not JSON`);
  }
}
