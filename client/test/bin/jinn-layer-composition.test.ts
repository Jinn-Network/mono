import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const clientRoot = fileURLToPath(new URL('../../', import.meta.url));

describe('jinn-layer production composition root', () => {
  it('routes development and the shipped bundle through authenticated verifier wiring', () => {
    const packageJson = JSON.parse(
      readFileSync(join(clientRoot, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    const bundleSource = readFileSync(
      join(clientRoot, 'scripts/bundle-jinn-layer.mjs'),
      'utf8',
    );
    const rootSource = readFileSync(
      join(clientRoot, 'scripts/jinn-layer-entry.ts'),
      'utf8',
    );

    expect(packageJson.scripts['jinn-layer']).toBe(
      'tsx scripts/jinn-layer-entry.ts',
    );
    expect(bundleSource).toContain(
      "{ in: 'scripts/jinn-layer-entry.ts', out: 'dist/bin/jinn-layer.js'",
    );
    expect(rootSource).toContain('runJinnLayerCli');
    expect(rootSource).toContain('createBoundedRawHfRowFetcher');
    expect(rootSource).toContain('createSweRebenchV2VerifierFactsResolver');
    expect(rootSource).toContain('verifierFactsResolverFactory');
  });
});
