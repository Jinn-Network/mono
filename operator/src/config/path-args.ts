/**
 * Zero-dependency argv scan for `--config`, shared by every call site that
 * resolves an operator config path (#2393). It lives outside `config.ts` so
 * that graphs which must not reach the legacy config module -- notably
 * `daemon/native-production-deployment.ts`, guarded by the native-product
 * import boundary -- can still resolve the flag through one implementation
 * instead of hand-rolling a scan that understands only one of the two forms.
 */

/**
 * Resolve the config path from `--config <path>` or `--config=<path>`.
 *
 * The first *usable* occurrence wins. An empty value (a trailing bare
 * `--config`, or `--config=`) never terminates the scan: it falls through so a
 * later usable occurrence still resolves, rather than silently falling back to
 * the caller's default.
 */
export function getConfigPathFromArgs(argv: string[] = process.argv): string | undefined {
  for (const [idx, arg] of argv.entries()) {
    if (arg === '--config') {
      const value = argv[idx + 1];
      if (value) return value;
    } else if (arg.startsWith('--config=')) {
      const value = arg.slice('--config='.length);
      if (value) return value;
    }
  }
  return undefined;
}
