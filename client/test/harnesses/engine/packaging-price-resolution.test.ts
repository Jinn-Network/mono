/**
 * Pin uploadArtifacts price-resolution precedence (Phase 3, jinn-mono-vy37.1.3).
 *
 * Order: OUTPUTS.json `access.priceUsdc`
 *      > deps.perArtifactTypePrice[artifactType]
 *      > deps.defaultPriceUsdc.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../src/store/store.js';
import { uploadArtifacts } from '../../../src/harnesses/engine/packaging.js';

describe('uploadArtifacts price resolution', () => {
  let store: Store;
  let workDir: string;

  beforeEach(() => {
    store = new Store(':memory:');
    workDir = mkdtempSync(join(tmpdir(), 'jinn-test-'));
  });

  afterEach(() => {
    store.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  function makeFile(name: string): string {
    const p = join(workDir, name);
    writeFileSync(p, name);
    return p;
  }

  const baseDeps = (overrides: Partial<Parameters<typeof uploadArtifacts>[1]> = {}) => ({
    store,
    operatorEndpoint: 'https://op.example.com',
    defaultPriceUsdc: '0.001',
    perArtifactTypePrice: { design_document: '0.5' },
    requestId: '0x' + 'a'.repeat(64),
    ...overrides,
  });

  it('uses OUTPUTS.json access.priceUsdc when present', async () => {
    const out = await uploadArtifacts(
      [
        {
          localPath: makeFile('a.txt'),
          artifactType: 'design_document',
          access: { priceUsdc: '0.99' },
        },
      ],
      baseDeps(),
    );
    expect(out[0]!.access.priceUsdc).toBe('0.99');
  });

  it('uses perArtifactTypePrice when no OUTPUTS.json override', async () => {
    const out = await uploadArtifacts(
      [{ localPath: makeFile('b.txt'), artifactType: 'design_document' }],
      baseDeps(),
    );
    expect(out[0]!.access.priceUsdc).toBe('0.5');
  });

  it('falls back to defaultPriceUsdc otherwise', async () => {
    const out = await uploadArtifacts(
      [{ localPath: makeFile('c.txt'), artifactType: 'runtime_log' }],
      baseDeps(),
    );
    expect(out[0]!.access.priceUsdc).toBe('0.001');
  });

  it('stamps deps.operatorEndpoint when artifact has no access.endpoint', async () => {
    const out = await uploadArtifacts(
      [{ localPath: makeFile('d.txt'), artifactType: 'runtime_log' }],
      baseDeps(),
    );
    expect(out[0]!.access.endpoint).toBe('https://op.example.com');
  });
});
