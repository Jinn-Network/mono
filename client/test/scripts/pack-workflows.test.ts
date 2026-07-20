import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../..');

function workflow(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

describe('packed client workflow coverage', () => {
  it.each(['.github/workflows/ci.yml', '.github/workflows/npm-publish.yml'])(
    '%s is triggered by client, core, and plugin changes',
    (path) => {
      const source = workflow(path);
      expect(source).toContain("'client/**'");
      expect(source).toContain("'packages/core/**'");
      expect(source).toContain("'packages/plugin/**'");
    },
  );

  it('CI covers internal package changes on pull requests and pushes', () => {
    const ci = workflow('.github/workflows/ci.yml');

    expect(ci.match(/'packages\/core\/\*\*'/g)).toHaveLength(2);
    expect(ci.match(/'packages\/plugin\/\*\*'/g)).toHaveLength(2);
  });

  it('CI and publish run the current npm-shaped private-runtime smoke', () => {
    const ci = workflow('.github/workflows/ci.yml');
    const publish = workflow('.github/workflows/npm-publish.yml');

    expect(ci).toContain('- run: yarn pack:smoke');
    expect(ci).toContain('- run: yarn pack -o jinn-client.tgz');
    expect(ci).not.toContain('working-directory: /tmp');

    const smoke = publish.indexOf('- run: yarn pack:smoke');
    const publishCanary = publish.indexOf('npm publish --access public --tag canary');
    expect(smoke).toBeGreaterThan(-1);
    expect(publishCanary).toBeGreaterThan(smoke);
  });
});
