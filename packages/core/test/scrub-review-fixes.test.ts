import { describe, expect, it } from 'vitest';
import {
  applyDispositions,
  buildLayer2ScrubPipeline,
  buildSeedScrubPipeline,
  countsTowardRefusal,
  shouldRejectPublish,
  type Finding,
} from '../src/scrub/index.js';
import { DEFAULT_POLICY } from '../src/scrub/policy.js';

describe('review fixes: allowlist-pass + reject-publish stubbing', () => {
  it('allowlist-pass records do not count toward refusal', () => {
    expect(countsTowardRefusal({ key: 'c', stage: 'known-identity', kind: 'allowlist-pass' })).toBe(
      false,
    );
    expect(shouldRejectPublish({
      redactions: [{ key: 'c', stage: 'known-identity', kind: 'allowlist-pass', detail: 'loopback' }],
    })).toBe(false);
  });

  it('loopback allowlist does not trip seed check-mode refusal', async () => {
    const pipeline = buildSeedScrubPipeline({
      knownIdentity: {
        allowlist: {
          entries: [{ value: '127.0.0.1', kind: 'loopback', provenance: 'test' }],
        },
      },
    });
    const result = await pipeline.run({ content: 'Bind to 127.0.0.1:8080 for local smoke.' });
    expect(result.attributes.content).toContain('127.0.0.1');
    expect(result.redactions.some((r) => r.kind === 'allowlist-pass')).toBe(true);
    expect(shouldRejectPublish(result)).toBe(false);
    expect(result.rejected).toBeFalsy();
  });

  it('reject-publish stubs A4 span text even in check-mode (no plaintext leftover)', async () => {
    const mnemonic =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const layer2 = buildLayer2ScrubPipeline();
    const result = await layer2.run({ content: `recovery phrase: ${mnemonic}` });
    expect(result.rejected).toBe(true);
    expect(String(result.attributes.content)).not.toContain('abandon abandon');
    expect(shouldRejectPublish(result)).toBe(true);
  });

  it('applyDispositions stubs reject-publish spans in redact-mode before assert throws', () => {
    const finding: Finding = {
      class: 'A4',
      span: { key: 'content', start: 5, end: 69 },
      confidence: 'VERY_HIGH',
      evidence: ['reject:private-key'],
      detector: { name: 'reject-classes', version: '0.1.0' },
    };
    // 64 hex chars
    const hex = 'a'.repeat(64);
    const applied = applyDispositions(
      { content: `key=${hex} trailing` },
      [finding],
      { policy: DEFAULT_POLICY, checkMode: false },
    );
    expect(applied.rejected).toBe(true);
    expect(String(applied.attributes.content)).not.toContain(hex);
  });
});
