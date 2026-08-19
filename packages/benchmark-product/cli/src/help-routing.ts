const WRAPPER_HELP_COMMANDS = new Set(["demo", "open", "help"]);

/** First non-flag token, or undefined once `--` appears. */
export function firstCommand(argv: readonly string[]): string | undefined {
  for (const token of argv) {
    if (token === "--") return undefined;
    if (!token.startsWith("--")) return token;
  }
  return undefined;
}

/**
 * Primary install USAGE (demo / open / bare help), not core's 40-verb list
 * and not a verb-specific page. `method --help` and `help method` must fall
 * through to core.
 */
export function usesPrimaryWrapperHelp(argv: readonly string[]): boolean {
  if (!argv.includes("--help")) return false;
  const command = firstCommand(argv);
  return command === undefined || WRAPPER_HELP_COMMANDS.has(command);
}
