import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const layerRoot = resolve(import.meta.dirname, '../..');

describe('plain TypeScript build lane', () => {
  it('builds and typechecks with tsc and contains no bundler dependency or script', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(layerRoot, 'package.json'), 'utf8'),
    ) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.scripts?.build).toBe('tsc -p tsconfig.json');
    expect(pkg.scripts?.typecheck).toBe('tsc --noEmit -p tsconfig.json');

    const serialized = JSON.stringify({
      scripts: pkg.scripts,
      dependencies: pkg.dependencies,
      devDependencies: pkg.devDependencies,
    });
    expect(serialized).not.toMatch(/\besbuild\b/u);
    expect(serialized).not.toMatch(/\brollup\b/u);
    expect(serialized).not.toMatch(/\bwebpack\b/u);
  });
});
