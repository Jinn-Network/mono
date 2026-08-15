import { describe, it, expect } from 'vitest';
import { HarnessBundleManifestSchema, HARNESS_BUNDLE_ARTIFACT_TYPE } from '../../src/trajectory/harness-bundle-schema.js';

describe('harness-bundle.v1', () => {
  it('exports artifact-type literal', () => {
    expect(HARNESS_BUNDLE_ARTIFACT_TYPE).toBe('harness-bundle.v1');
  });

  it('parses a minimal manifest', () => {
    const manifest = {
      schemaVersion: 'harness-bundle.v1',
      bundleSha256: 'a'.repeat(64),
      capturePath: 'B',
      tool: { name: 'claude-code', version: '1.0.42' },
      files: [
        { path: 'global/CLAUDE.md', sha256: 'b'.repeat(64), bytes: 1024 },
        { path: 'project/CLAUDE.md', sha256: 'c'.repeat(64), bytes: 512 },
      ],
    };
    const result = HarnessBundleManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
  });

  it('rejects bundle with no files when included', () => {
    const manifest = {
      schemaVersion: 'harness-bundle.v1',
      bundleSha256: 'a'.repeat(64),
      capturePath: 'B',
      tool: { name: 'claude-code' },
      files: [],
    };
    const result = HarnessBundleManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it('rejects invalid sha256 length', () => {
    const manifest = {
      schemaVersion: 'harness-bundle.v1',
      bundleSha256: 'tooshort',
      capturePath: 'A',
      tool: { name: 'claude-code' },
      files: [{ path: 'x', sha256: 'b'.repeat(64), bytes: 1 }],
    };
    const result = HarnessBundleManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it('rejects negative file bytes', () => {
    const manifest = {
      schemaVersion: 'harness-bundle.v1',
      bundleSha256: 'a'.repeat(64),
      capturePath: 'A',
      tool: { name: 'claude-code' },
      files: [{ path: 'x', sha256: 'b'.repeat(64), bytes: -5 }],
    };
    const result = HarnessBundleManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it('rejects wrong schemaVersion (discriminator)', () => {
    const manifest = {
      schemaVersion: 'harness-bundle.v0',
      bundleSha256: 'a'.repeat(64),
      capturePath: 'A',
      tool: { name: 'claude-code' },
      files: [{ path: 'x', sha256: 'b'.repeat(64), bytes: 0 }],
    };
    const result = HarnessBundleManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });
});
