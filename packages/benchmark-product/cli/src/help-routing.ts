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
 * and not a verb-specific page. `method --help`, `help method`, and
 * `help method --help` must fall through to core.
 */
export function usesPrimaryWrapperHelp(argv: readonly string[]): boolean {
  if (!argv.includes("--help")) return false;
  const command = firstCommand(argv);
  if (command === undefined || command === "demo" || command === "open") return true;
  if (command !== "help") return false;
  return helpTopic(argv) === undefined;
}

function helpTopic(argv: readonly string[]): string | undefined {
  let seenHelp = false;
  for (const token of argv) {
    if (token === "--") return undefined;
    if (token.startsWith("--")) continue;
    if (!seenHelp) {
      if (token === "help") {
        seenHelp = true;
        continue;
      }
      return undefined;
    }
    return token;
  }
  return undefined;
}
