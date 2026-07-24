import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Recursively list `.ts` files under `dir`, skipping `node_modules`. */
export function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules') continue;
      out.push(...tsFiles(full));
    } else if (name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

// Static `import ... from` / `export ... from`, dynamic `import(...)`, and
// bare side-effect `import '...'` specifiers.
export const SPECIFIER = /(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;
