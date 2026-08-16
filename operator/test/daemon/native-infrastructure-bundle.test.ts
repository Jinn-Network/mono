import { createHash } from 'node:crypto';
import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadNativeInfrastructureBundle } from '../../src/daemon/native-infrastructure-bundle.js';

function digest(bytes: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

describe('native infrastructure bundle confinement', () => {
  it('loads a digest-pinned self-contained primitive factory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jinn-infra-'));
    const path = join(root, 'bundle.mjs');
    const source = 'export function createNativeInfrastructure(){ return { schemaVersion: 1 }; }\n';
    await writeFile(path, source);
    const loaded = await loadNativeInfrastructureBundle({ path, digest: digest(source) });
    expect(typeof loaded.createNativeInfrastructure).toBe('function');
  });

  it('rejects digest drift, symlinks, external source imports, and product authority', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jinn-infra-bad-'));
    const target = join(root, 'target.mjs');
    const link = join(root, 'link.mjs');
    const source = 'export function createNativeInfrastructure(){ return {}; }\n';
    await writeFile(target, source);
    await symlink(target, link);
    await expect(loadNativeInfrastructureBundle({ path: target, digest: `sha256:${'0'.repeat(64)}` }))
      .rejects.toThrow(/digest mismatch/u);
    await expect(loadNativeInfrastructureBundle({ path: link, digest: digest(source) }))
      .rejects.toThrow(/regular non-symlink/u);

    const imported = 'import "./authority.mjs"; export function createNativeInfrastructure(){}\n';
    await writeFile(target, imported);
    await expect(loadNativeInfrastructureBundle({ path: target, digest: digest(imported) }))
      .rejects.toThrow(/not self-contained/u);

    const authority = 'export function createNativeOperatorHost(){}; export function createNativeInfrastructure(){}\n';
    await writeFile(target, authority);
    await expect(loadNativeInfrastructureBundle({ path: target, digest: digest(authority) }))
      .rejects.toThrow(/forbidden product authority/u);
  });
});
