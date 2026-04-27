/**
 * Shared types and helpers for jinn CLI command modules.
 *
 * Every command module exports a default `CommandModule` object. The
 * dispatcher in cli/index.ts looks up the verb name, parses flags with
 * `parseArgs`, and calls `run`.
 */

import { parseArgs, type ParseArgsConfig } from 'node:util';

export interface CommandContext {
  /** Everything after the verb, e.g. for `jinn bootstrap --json`, this is ['--json']. */
  argv: string[];
  /** Effective stdout TTY state; tests inject false. */
  stdoutIsTty: boolean;
  /** Injected writer for tests; production uses process.stdout. */
  writer: { write: (s: string) => boolean };
  /** Injected exit for tests; production uses process.exit. */
  exit: (code: number) => void;
  /** Process environment, for JINN_PASSWORD, JINN_CLAUDE_PATH, etc. */
  env: NodeJS.ProcessEnv;
}

export interface CommandModule {
  name: string;
  summary: string;
  helpText: string; // Full --help body including Examples, rendered by help.ts
  run(ctx: CommandContext): Promise<void>;
}

/**
 * Strongly-typed wrapper around Node's parseArgs. Callers pass the command
 * name and options schema; this returns the parsed values or throws on
 * invalid flags. Callers are responsible for catching and emitting an
 * envelope with code 'invalid_invocation'.
 */
export function parseCommandArgs<T extends ParseArgsConfig['options']>(
  argv: string[],
  options: T,
): ReturnType<typeof parseArgs<{ options: T; allowPositionals: true }>> {
  return parseArgs({ args: argv, options, allowPositionals: true });
}

/**
 * Common flags every verb accepts. Callers spread this into their options.
 */
export const COMMON_FLAGS = {
  json: { type: 'boolean' as const, default: false },
  human: { type: 'boolean' as const, default: false },
  help: { type: 'boolean' as const, default: false },
  config: { type: 'string' as const },
  /** Parsed value is the fd number as string; read via resolveCliPassword / readPasswordFromFd. */
  'password-fd': { type: 'string' as const },
};

/**
 * Shared base for command factory deps. Most CLI commands need at least these.
 * Extend with command-specific deps via `<Cmd>Deps extends BaseCommandDeps`.
 * See docs/runbooks/testing.md and any factory-style command (e.g. doctor.ts) for usage.
 */
export interface BaseCommandDeps {
  loadConfig: typeof import('../config.js').loadConfig;
  getConfigPathFromArgs: typeof import('../config.js').getConfigPathFromArgs;
}
