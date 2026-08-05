/**
 * The CLI's return shape and its injected environment (spec §5.2).
 *
 * `runCli` returns a result rather than writing to `process.stdout` and
 * calling `process.exit`, so every verb is testable as a function of its
 * arguments and the directory it was pointed at. `bin.ts` is the only file
 * in this package that touches the process.
 */

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CliContext {
  readonly cwd: string;
  /** Returns an RFC 3339 timestamp. Injected so a test's output is a function of its inputs. */
  readonly clock: () => string;
}
