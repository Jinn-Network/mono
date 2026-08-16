/**
 * A small, total argument parser, and the file reader the verbs share (spec
 * §5.2). Deliberately not a dependency — the same reasoning as the
 * policy-optimization CLI this package's structure follows: the dependency
 * graph is an audited list, not a default.
 *
 * Grammar: `<words...> --flag value`, with `--flag=value` and valueless
 * boolean flags also accepted. There are no repeatable flags in this
 * product — a flag supplied twice has no obvious winner, and picking one
 * silently would be picking the wrong one silently just as often as not.
 * Every refusal here throws a `BenchmarkProductError` with code
 * `"invalid-invocation"` (errors.ts, spec §4.3), which `main.ts` catches and
 * renders as an envelope or a stderr line depending on `--json`.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { refuse } from "../errors.js";

export interface ParsedArgs {
  /** Positional words before the first flag, e.g. `["draft", "create"]`. */
  readonly words: readonly string[];
  readonly flags: ReadonlyMap<string, string>;
}

/**
 * Splits `argv` into leading positional words and trailing `--flag`
 * tokens. A token after the first flag that does not itself start with
 * `--` is an unexpected positional and refuses; a flag name supplied more
 * than once refuses.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const words: string[] = [];
  const flags = new Map<string, string>();
  let index = 0;

  while (index < argv.length && !argv[index]!.startsWith("--")) {
    words.push(argv[index]!);
    index += 1;
  }

  while (index < argv.length) {
    const token = argv[index]!;
    if (!token.startsWith("--")) {
      refuse("invalid-invocation", token, `unexpected argument "${token}"; flags come after the verb`);
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
    if (flags.has(name)) {
      refuse("invalid-invocation", `--${name}`, `--${name} was supplied more than once`);
    }
    flags.set(name, value);
  }

  return { words, flags };
}

/** Refuses `"invalid-invocation"` on any flag not in `known`, naming the verb's full flag set. */
export function assertKnownFlags(args: ParsedArgs, known: readonly string[]): void {
  const allowed = new Set(known);
  for (const name of args.flags.keys()) {
    if (!allowed.has(name)) {
      refuse(
        "invalid-invocation",
        `--${name}`,
        `unknown flag --${name}; this verb takes ${known.map((flag) => `--${flag}`).join(", ")}`,
      );
    }
  }
}

export function optional(args: ParsedArgs, name: string): string | undefined {
  return args.flags.get(name);
}

/** Refuses `"invalid-invocation"` when the flag is missing or was supplied as an empty/valueless boolean. */
export function required(args: ParsedArgs, name: string): string {
  const value = optional(args, name);
  if (value === undefined || value === "") {
    refuse("invalid-invocation", `--${name}`, `--${name} is required`);
  }
  return value;
}

export function present(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}

/** Resolves a non-absolute path against the invocation's working directory. */
export function pathFrom(cwd: string, value: string): string {
  return isAbsolute(value) ? value : resolve(cwd, value);
}

/** Reads and parses a JSON file. An unreadable file or invalid JSON refuses `"validation"`, naming `path`. */
export function readJsonFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    refuse("validation", path, `cannot read ${path}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    refuse("validation", path, `${path} is not valid JSON`);
  }
}

/** Reads an exact UTF-8 text manifest; semantic/canonical validation belongs to the operation. */
export function readTextFile(path: string): string {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch {
    refuse("validation", path, `cannot read ${path}`);
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    refuse("validation", path, `${path} must not begin with a UTF-8 BOM`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    refuse("validation", path, `${path} is not valid UTF-8`);
  }
}
