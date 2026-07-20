import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPECIFIER, tsFiles } from './import-scan.js';

/**
 * Architecture manifest test for #1833 (mirrors C1's harness-layer version).
 *
 * Every bare (non-relative) import specifier in `packages/core/src/` must be
 * declared in `packages/core/package.json` — core's dependency manifest.
 * Node builtins (`node:*` and un-prefixed builtin names) are exempt. C5 adds
 * the scrub/parser dependencies (including the read-only transcript SQLite
 * driver); any undeclared runtime dependency still fails loudly.
 */
const pkgRoot = fileURLToPath(new URL('../../', import.meta.url));
const srcDir = join(pkgRoot, 'src');

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

describe('core dependency manifest (#1833)', () => {
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
      `bare imports missing from packages/core/package.json:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('publishes stable domain subpaths for the C5 extraction', () => {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf-8'));
    expect(Object.keys(pkg.exports ?? {}).sort()).toEqual([
      '.',
      './corpus-read',
      './scrub',
      './trajectory',
    ]);
  });
});
