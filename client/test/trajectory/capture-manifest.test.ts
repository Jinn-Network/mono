import { describe, it, expect } from 'vitest';
import { CaptureManifestSchema, EMPTY_BUNDLE_SHA256 } from '../../src/trajectory/schema.js';

describe('CaptureManifestSchema', () => {
  it('accepts a complete capture manifest', () => {
    const manifest = {
      scrubProcessors: [
        { name: '@opentelemetry/processor-redaction', version: '0.1.0' },
        { name: 'identity-scrub', version: '1.0.0', config: { patterns: ['username', 'hostname'] } },
      ],
      reviewedBy: {
        safeAddress: '0xabc' + 'd'.repeat(37),
        reviewedAt: '2026-05-07T01:00:00.000Z',
      },
      trustedRepoToggle: false,
      harnessBundle: {
        included: true,
        sha256: 'a'.repeat(64),
        allowedDirectoriesHash: 'b'.repeat(64),
        capturePath: 'A' as const,
      },
    };
    const result = CaptureManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
  });

  it('accepts opted-out harness bundle', () => {
    const manifest = {
      scrubProcessors: [{ name: 'identity-scrub', version: '1.0.0' }],
      reviewedBy: {
        safeAddress: '0xabc' + 'd'.repeat(37),
        reviewedAt: '2026-05-07T01:00:00.000Z',
      },
      trustedRepoToggle: true,
      harnessBundle: {
        included: false,
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', // empty bundle sentinel
        allowedDirectoriesHash: 'b'.repeat(64),
        capturePath: 'C' as const,
      },
    };
    const result = CaptureManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
  });

  it('rejects missing capturePath', () => {
    const manifest = {
      scrubProcessors: [],
      reviewedBy: { safeAddress: '0xabc' + 'd'.repeat(37), reviewedAt: '2026-05-07T01:00:00.000Z' },
      trustedRepoToggle: false,
      harnessBundle: { included: true, sha256: 'a'.repeat(64), allowedDirectoriesHash: 'b'.repeat(64) },
    };
    const result = CaptureManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it('rejects invalid sha256 length', () => {
    const manifest = {
      scrubProcessors: [],
      reviewedBy: { safeAddress: '0xabc' + 'd'.repeat(37), reviewedAt: '2026-05-07T01:00:00.000Z' },
      trustedRepoToggle: false,
      harnessBundle: { included: true, sha256: 'tooshort', allowedDirectoriesHash: 'b'.repeat(64), capturePath: 'A' },
    };
    const result = CaptureManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it('exports EMPTY_BUNDLE_SHA256 sentinel', () => {
    expect(EMPTY_BUNDLE_SHA256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});
