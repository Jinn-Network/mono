import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest } from '../../../src/harnesses/manifest/load.js';

const FIXTURES = fileURLToPath(
  new URL('../../../test-fixtures/manifests/', import.meta.url),
);

describe('loadManifest', () => {
  it('parses a valid manifest', async () => {
    const m = await loadManifest(join(FIXTURES, 'valid.json'));
    expect(m.name).toBe('@example/forecaster');
    expect(m.supportedSolverTypes).toContain('prediction.v0>=1.0.0');
    expect(m.signature.alg).toBe('ed25519');
  });

  it('rejects a manifest violating the JSON schema', async () => {
    await expect(
      loadManifest(join(FIXTURES, 'invalid-schema.json')),
    ).rejects.toThrow(/schema/i);
  });

  it('rejects a missing manifest file', async () => {
    await expect(
      loadManifest(join(FIXTURES, 'does-not-exist.json')),
    ).rejects.toThrow();
  });
});
