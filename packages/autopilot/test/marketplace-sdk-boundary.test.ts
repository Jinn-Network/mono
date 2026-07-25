import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function filesBelow(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? filesBelow(path) : [path];
  });
}

describe('marketplace SDK consumer boundary', () => {
  it('declares the SDK runtime dependency and never reaches into SDK source', () => {
    const root = join(import.meta.dirname, '..');
    const manifest = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(manifest.dependencies?.['@jinn-network/sdk']).toBe('portal:../sdk');

    const deepSource = ['../', '../', '../', 'sdk/src/'].join('');
    const privateFixtures = ['sdk/', 'test/', 'fixtures/', 'autopilot-session'].join('');
    const sourceOffenders = filesBelow(join(root, 'src'))
      .filter((path) => path.endsWith('.ts'))
      .filter((path) => readFileSync(path, 'utf8').includes(deepSource));
    const fixtureOffenders = filesBelow(join(root, 'test'))
      .filter((path) => path.endsWith('.ts') && path !== import.meta.filename)
      .filter((path) => readFileSync(path, 'utf8').includes(privateFixtures));
    expect(sourceOffenders).toEqual([]);
    expect(fixtureOffenders).toEqual([]);
  });
});
