import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const layerRoot = resolve(import.meta.dirname, '../..');
const srcRoot = resolve(layerRoot, 'src');
const specifier = /(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/gu;

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : /\.(?:ts|mts|js|mjs)$/u.test(entry)
        ? [path]
        : [];
  });
}

describe('layer architecture boundary', () => {
  it('has production source and never imports client implementation paths', () => {
    const files = sourceFiles(srcRoot);
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      for (const match of readFileSync(file, 'utf8').matchAll(specifier)) {
        const imported = match[1]!;
        if (
          imported.includes('operator/src')
          || imported.includes('operator/packages')
          || imported === '@jinn-network/client'
          || imported.startsWith('@jinn-network/client/')
        ) {
          offenders.push(
            `${relative(layerRoot, file).split(sep).join('/')} -> ${imported}`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
