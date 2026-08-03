// SPDX-License-Identifier: MIT

/**
 * The CLI's return shape and its injected environment.
 *
 * `runCli` returns a result rather than writing to `process.stdout` and calling `process.exit`, so
 * every verb is testable as a function of its arguments and the directory it was pointed at. The
 * bin wrapper is the only place that touches the process, and it is four lines long for exactly
 * that reason.
 */

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CliContext {
  readonly cwd: string;
  /** RFC 3339 with an offset. Injected so a test's output is a function of its inputs. */
  readonly now: () => string;
}

/** Joins lines into a trailing-newline block. `""` produces a blank separator line. */
export function lines(...values: readonly string[]): string {
  return values.length === 0 ? "" : `${values.join("\n")}\n`;
}

export function ok(stdout: string): CliResult {
  return { exitCode: 0, stdout, stderr: "" };
}

export function failed(message: string): CliResult {
  return { exitCode: 1, stdout: "", stderr: `${message}\n` };
}
