import { builtinModules } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const layerRoot = resolve(import.meta.dirname, '../..');
const srcRoot = resolve(layerRoot, 'src');
const specifier = /(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/gu;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : /\.(?:ts|mts|js|mjs)$/u.test(entry)
        ? [path]
        : [];
  });
}

function packageName(value: string): string {
  const parts = value.split('/');
  return value.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

describe('layer dependency manifest', () => {
  it('declares every bare production import', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(layerRoot, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);
    const builtins = new Set(builtinModules);
    const offenders: string[] = [];

    for (const file of sourceFiles(srcRoot)) {
      for (const match of readFileSync(file, 'utf8').matchAll(specifier)) {
        const imported = match[1]!;
        if (imported.startsWith('.') || imported.startsWith('node:')) continue;
        const name = packageName(imported);
        if (!builtins.has(name) && !declared.has(name)) {
          offenders.push(
            `${relative(layerRoot, file).split(sep).join('/')} -> ${imported}`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
