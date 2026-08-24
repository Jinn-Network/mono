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
 * Best-effort cleanup of orphaned bundled/local vendor copies left by older
 * operators. Never throws — a failed delete must not block boot.
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
