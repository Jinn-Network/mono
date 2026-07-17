import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Architecture manifest test for #1832.
 *
 * Every bare (non-relative) import specifier in `packages/harness-layer/src/`
 * must be declared in the package's own package.json — the harness-layer
 * dependency manifest. Node builtins (`node:*` and un-prefixed builtin names)
 * are exempt. This freezes the package's external surface so a later
 * extraction (C2/C5/C6) can trust the manifest instead of re-deriving it.
 */
const pkgRoot = fileURLToPath(new URL('../../', import.meta.url));
const srcDir = join(pkgRoot, 'src');

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...tsFiles(full));
    } else if (name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

// Static `import ... from` / `export ... from`, dynamic `import(...)`, and
// bare side-effect `import '...'` specifiers.
const SPECIFIER = /(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;

function bareSpecifiers(source: string): string[] {
  const specs: string[] = [];
  for (const match of source.matchAll(SPECIFIER)) {
    const spec = match[1];
    if (!spec.startsWith('.') && !spec.startsWith('node:')) specs.push(spec);
  }
  return specs;
}

/** `@scope/name/deep/path.js` → `@scope/name`; `pkg/deep` → `pkg`. */
function packageName(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

describe('harness-layer dependency manifest (#1832)', () => {
  it('every bare import in src/ is declared in the package manifest', () => {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf-8'));
    const declared = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);
    const builtins = new Set(builtinModules);

    const offenders: string[] = [];
    for (const file of tsFiles(srcDir)) {
      const source = readFileSync(file, 'utf-8');
      for (const spec of bareSpecifiers(source)) {
        const name = packageName(spec);
        if (builtins.has(name)) continue;
        if (!declared.has(name)) {
          offenders.push(`${file.slice(pkgRoot.length)}: '${spec}' (undeclared: ${name})`);
        }
      }
    }
    expect(
      offenders,
      `bare imports missing from packages/harness-layer/package.json:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
