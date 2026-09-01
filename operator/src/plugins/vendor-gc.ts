import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { SolverPluginEntry } from './types.js';
import { entrySource, safeVendorName, sourceKind } from './resolvers.js';

/**
 * Vendor directory names for remote plugin sources that must keep their
 * materialized trees under the writable vendor root.
 */
export function remoteVendorNamesFromEntries(entries: readonly SolverPluginEntry[]): Set<string> {
  const names = new Set<string>();
  for (const entry of entries) {
    const source = entrySource(entry);
    const kind = sourceKind(source);
    if (kind === 'npm' || kind === 'git' || kind === 'github' || kind === 'claude') {
      names.add(safeVendorName(source));
    }
  }
  return names;
}

/**
 * The invariant leading segment `safeVendorName` produces for each remote
 * source kind: the scheme is alphanumeric, so it survives the sanitizer
 * verbatim, and the `:` that follows it always becomes `_`.
 */
const REMOTE_VENDOR_NAME_PREFIXES = ['npm_', 'git_', 'github_', 'claude_'] as const;

function isRemoteVendorName(baseName: string): boolean {
  return REMOTE_VENDOR_NAME_PREFIXES.some((prefix) => baseName.startsWith(prefix));
}

/**
 * Best-effort cleanup of orphaned bundled/local vendor copies left by older
 * operators. Never throws — a failed delete must not block boot.
 *
 * This is a denylist over what is on disk, not an allowlist over what is
 * configured. AC5 of #1242 is unconditional — "garbage collection does not
 * delete remote materializations" — and `protectedRemoteNames` only ever sees
 * the wiring the caller happens to hold. An evaluator-only net contributes no
 * wiring entry (`wiringFromJoined` filters `roles.includes('solver')`), a
 * fresh operator boots with `executionWiring: []`, and a net can be
 * temporarily unjoined or a remote plugin vendored ahead of joining. Nothing
 * in `operator/src` writes remote trees into the vendor root, so those copies
 * are operator-placed by hand and unrecoverable once deleted.
 *
 * So an entry is removed only when it is positively identifiable as a legacy
 * bundled/local copy: a name that does not carry one of the remote-kind
 * prefixes `safeVendorName` invariably produces. Anything unrecognized is
 * kept.
 */
export function gcOrphanedBundledLocalVendorCopies(
  vendorRoot: string,
  protectedRemoteNames: ReadonlySet<string>,
): void {
  try {
    if (!existsSync(vendorRoot)) return;
    for (const name of readdirSync(vendorRoot)) {
      const baseName = name.endsWith('.source.sha256')
        ? name.slice(0, -'.source.sha256'.length)
        : name.endsWith('.lock')
          ? name.slice(0, -'.lock'.length)
          : name;
      if (protectedRemoteNames.has(baseName)) continue;
      if (isRemoteVendorName(baseName)) continue;
      try {
        rmSync(join(vendorRoot, name), { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  } catch {
    // best-effort
  }
}
