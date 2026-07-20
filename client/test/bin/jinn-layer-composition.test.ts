import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const clientRoot = fileURLToPath(new URL('../../', import.meta.url));

describe('jinn-layer production composition root', () => {
  it('leaves both layer binaries out of the client release lane', () => {
    const packageJson = JSON.parse(
      readFileSync(join(clientRoot, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string>; bin: Record<string, string> };

    expect(packageJson.bin).not.toHaveProperty('jinn-layer');
    expect(packageJson.bin).not.toHaveProperty('jinn-distill-mcp');
    expect(packageJson.scripts).not.toHaveProperty('jinn-layer');
    expect(packageJson.scripts.build).not.toContain('bundle-jinn-layer');
  });
});
