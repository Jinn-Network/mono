/**
 * Zero-dependency argv scan for `--config`, shared by every call site that
 * resolves an operator config path (#2393). It lives outside `config.ts` so
 * that graphs which must not reach the legacy config module -- notably
 * `daemon/native-production-deployment.ts`, guarded by the native-product
 * import boundary -- can still resolve the flag through one implementation
 * instead of hand-rolling a scan that understands only one of the two forms.
 */

/**
 * `empty` is reached only when at least one `--config` token was present and
 * no occurrence yielded a usable value, so the fall-through documented on
 * `getConfigPathFromArgs` is preserved by construction.
 */
type ConfigPathArg = { kind: 'path'; path: string } | { kind: 'empty' } | { kind: 'absent' };

function scanConfigPathArg(argv: string[]): ConfigPathArg {
  let seen = false;
  for (const [idx, arg] of argv.entries()) {
    let value: string | undefined;
    if (arg === '--config') {
      seen = true;
      value = argv[idx + 1];
    } else if (arg.startsWith('--config=')) {
      seen = true;
      value = arg.slice('--config='.length);
    } else {
      continue;
    }
    if (value) return { kind: 'path', path: value };
  }
  return seen ? { kind: 'empty' } : { kind: 'absent' };
}

/**
 * Resolve the config path from `--config <path>` or `--config=<path>`.
 *
 * The first *usable* occurrence wins. An empty value (a trailing bare
 * `--config`, or `--config=`) never terminates the scan: it falls through so a
 * later usable occurrence still resolves, rather than silently falling back to
 * the caller's default.
 */
export function getConfigPathFromArgs(argv: string[] = process.argv): string | undefined {
  const scanned = scanConfigPathArg(argv);
  return scanned.kind === 'path' ? scanned.path : undefined;
}

/**
 * Same resolution as `getConfigPathFromArgs`, but distinguishes "no `--config`"
 * (undefined, so the caller applies its own default) from "`--config` given
 * with an empty value" (throws). Call sites where a silent default would load
 * or mutate a different file than the operator named must use this (#4376).
 */
export function requireConfigPathFromArgs(argv: string[] = process.argv): string | undefined {
  const scanned = scanConfigPathArg(argv);
  if (scanned.kind === 'empty') {
    throw new Error('--config was given with an empty value; pass a config path or omit the flag');
  }
  return scanned.kind === 'path' ? scanned.path : undefined;
}
