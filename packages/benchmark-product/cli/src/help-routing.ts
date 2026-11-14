/** First non-flag token, or undefined once `--` appears. */
export function firstCommand(argv: readonly string[]): string | undefined {
  for (const token of argv) {
    if (token === "--") return undefined;
    if (!token.startsWith("--")) return token;
  }
  return undefined;
}

/**
 * Primary install USAGE (demo / open / claimant-verb list / bare help), not
 * core's full lifecycle library and not a verb-specific page. `method --help`,
 * `help method`, and `help method --help` must fall through to core.
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

// Core's `parseArgs` treats these as flags that never take a value. Keep in step with it.
const BOOLEAN_FLAGS = new Set(["help", "json", "include-native-artifacts", "ack-provider-network-costs", "ack-sample-size"]);

/**
 * The verb as core finds it: the first positional word, with flags allowed before it. A value
 * flag (`--workspace ws`) takes the next token, so that token is not the verb. (Issue #5046)
 */
export function verbOf(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--") return argv[index + 1];
    if (!token.startsWith("--")) return token;
    if (token.includes("=") || BOOLEAN_FLAGS.has(token.slice(2))) continue;
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) index += 1;
  }
  return undefined;
}

/**
 * Whether core's `parseArgs` sees the `help` flag: `--help` or `--help=<value>` before any `--`.
 * After `--` every token is a word, so `-- --help` is not a help request. (Issue #5198)
 */
export function helpRequested(argv: readonly string[]): boolean {
  for (const token of argv) {
    if (token === "--") return false;
    if (token === "--help" || token.startsWith("--help=")) return true;
  }
  return false;
}
